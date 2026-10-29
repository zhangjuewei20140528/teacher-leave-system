'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  version: 2,
  warnDays: 1,
  criticalDays: 3,
  openWarnDays: 7,
  openCriticalDays: 14,
  leaveTypes: ['事假', '病假', '公假', '调休', '婚假', '产假', '丧假'],
  schools: ['本校'],
  subjects: ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理',
    '体育', '音乐', '美术', '信息技术', '科学', '道德与法治', '心理健康', '劳动'],
  grades: ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级',
    '初一', '初二', '初三', '高一', '高二', '高三'],
  backupKeep: 30,
  // 流水号计数器：{"20261029": 3} 表示这天已经用到 003。
  // 记在设置里而不是从记录里现算，删除记录后号也不会被重用
  noSeq: {},
  firstRunTipShown: false
};

// 计数器只许前进，取两份的较大值
function mergeSeq(a, b) {
  const out = Object.assign({}, a || {});
  Object.keys(b || {}).forEach(k => {
    const n = Number(b[k]) || 0;
    if (!(Number(out[k]) >= n)) out[k] = n;
  });
  return out;
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function stamp(d) {
  d = d || new Date();
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

// 备份文件名里的 tag：auto / manual / before-restore（可能带 -2 -3 去重后缀）
function tagOfName(name) {
  const m = /_([a-z][a-z-]*?)(?:-\d+)?\.json$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// 文件名里的时间才是「备份时刻」。copyFile 在 Windows 上会继承源文件的
// mtime，直接用 stat.mtime 当备份时间会显示成上一次保存的时间，差出好几秒甚至几分钟。
function nameTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(String(name || ''));
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.backupDir = path.join(dataDir, 'backups');
    this.leavesPath = path.join(dataDir, 'leaves.json');
    this.settingsPath = path.join(dataDir, 'settings.json');
    this.ensureDirs();
  }

  ensureDirs() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  readJSON(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      const e = new Error('数据文件读取失败：' + path.basename(file) + '（' + err.message + '）');
      e.code = 'CORRUPT';
      e.file = file;
      throw e;
    }
  }

  writeAtomic(file, obj) {
    this.ensureDirs();
    const tmp = file + '.tmp';
    const body = JSON.stringify(obj, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  loadLeaves() {
    const data = this.readJSON(this.leavesPath, { version: 1, records: [] });
    if (!data || !Array.isArray(data.records)) return { version: 1, records: [] };
    return data;
  }

  loadSettings() {
    const s = this.readJSON(this.settingsPath, null);
    if (!s) return Object.assign({}, DEFAULT_SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS, s);
  }

  saveSettings(settings) {
    const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    // 流水号计数器只许前进：渲染进程手里可能是启动时的旧快照，
    // 直接照抄会把手上的号退回去，删掉的号又会被重新用上
    merged.noSeq = mergeSeq(this.loadSettings().noSeq, settings && settings.noSeq);
    this.writeAtomic(this.settingsPath, merged);
    return merged;
  }

  backup(tag) {
    try {
      if (!fs.existsSync(this.leavesPath)) return null;
      // 同一秒内做两次同类型备份时不能互相覆盖（文件名精确到秒），
      // 否则「刚点完立即备份，紧接着又保存一次」会把刚备份的那份冲掉
      const base = stamp() + (tag ? '_' + tag : '');
      let name = base + '.json';
      let dest = path.join(this.backupDir, name);
      for (let i = 2; fs.existsSync(dest) && i < 100; i++) {
        name = base + '-' + i + '.json';
        dest = path.join(this.backupDir, name);
      }
      fs.copyFileSync(this.leavesPath, dest);
      this.pruneBackups();
      return dest;
    } catch (err) {
      return null;
    }
  }

  // 每份备份的内容摘要，用来在界面上区分「这份里到底有哪些记录」。
  // 只有用户能看清每份备份的内容，恢复时才不会挑错时间点。
  backupMeta(f) {
    const full = path.join(this.backupDir, f);
    const item = {
      name: f,
      tag: tagOfName(f),
      size: 0,
      mtime: '',
      takenAt: nameTime(f),
      dataTime: '',
      records: null,
      teachers: null,
      sample: [],
      corrupt: false
    };
    try {
      const st = fs.statSync(full);
      item.size = st.size;
      item.mtime = st.mtime.toISOString();
    } catch (e) {
      item.corrupt = true;
    }
    if (!item.takenAt) item.takenAt = item.mtime;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!data || !Array.isArray(data.records)) throw new Error('bad');
      const recs = data.records;
      item.records = recs.length;
      const keys = new Set();
      const names = [];
      recs.forEach(r => {
        const n = String((r && r.name) || '').trim();
        keys.add(((r && r.school) || '') + '|' + n);
        if (n && names.indexOf(n) < 0) names.push(n);
      });
      item.teachers = keys.size;
      item.sample = names.slice(0, 3);
      item.dataTime = data.updatedAt || '';
    } catch (e) {
      item.corrupt = true;
    }
    return item;
  }

  pruneBackups() {
    try {
      const keep = Number(this.loadSettings().backupKeep) || 30;
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({
          f,
          // 用文件名里的备份时刻排序（mtime 会被 copyFile 继承成源文件的写入时间）
          t: Date.parse(nameTime(f)) || fs.statSync(path.join(this.backupDir, f)).mtimeMs,
          tag: tagOfName(f)
        }))
        .sort((a, b) => b.t - a.t);

      // 手动备份是用户主动点的「立即备份」，不能被随后几十次自动备份挤掉：
      // 自动备份按保留份数清理，手动备份单独按同样份数封顶
      const manual = files.filter(x => x.tag === 'manual');
      const auto = files.filter(x => x.tag !== 'manual');
      const drop = manual.slice(keep).concat(auto.slice(keep));

      drop.forEach(item => {
        try { fs.unlinkSync(path.join(this.backupDir, item.f)); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  saveLeaves(data) {
    // 备份必须在写之前做（备份的是「这次操作之前」的状态，
    // 挪到写之后就变成备份刚写的文件，等于没法回退）；
    // 但写失败时这份备份跟现状一模一样，纯属噪音，删掉它
    const bak = this.backup('auto');
    const payload = { version: 1, updatedAt: new Date().toISOString(), records: data.records || [] };
    try {
      this.writeAtomic(this.leavesPath, payload);
    } catch (err) {
      if (bak) {
        try { fs.unlinkSync(bak); } catch (e) { /* 删不掉也不影响抛错 */ }
      }
      throw err;
    }
    // 落盘成功后再推进流水号计数器（表单取消不占号，删除也不倒退）
    payload.noSeq = this.syncNoSeq(payload.records);
    return payload;
  }

  listBackups() {
    try {
      return fs.readdirSync(this.backupDir)
        .filter(f => f.endsWith('.json'))
        .map(f => this.backupMeta(f))
        .sort((a, b) => (String(a.takenAt) < String(b.takenAt) ? 1 : -1));
    } catch (e) {
      return [];
    }
  }

  restoreBackup(name) {
    const safe = path.basename(String(name || ''));
    const src = path.join(this.backupDir, safe);
    if (!fs.existsSync(src)) throw new Error('备份文件不存在');
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    if (!data || !Array.isArray(data.records)) throw new Error('备份文件内容无效');
    this.backup('before-restore');
    this.writeAtomic(this.leavesPath, { version: 1, updatedAt: new Date().toISOString(), records: data.records });
    return { version: 1, records: data.records };
  }

  // 数据与备份的占用情况，用于在设置页说明"不会一直变大"
  stats() {
    const out = { recordCount: 0, leavesSize: 0, backupCount: 0, backupSize: 0, backupKeep: 30 };
    try { out.recordCount = this.loadLeaves().records.length; } catch (e) { /* 数据损坏时仍能看备份信息 */ }
    try { if (fs.existsSync(this.leavesPath)) out.leavesSize = fs.statSync(this.leavesPath).size; } catch (e) { /* ignore */ }
    try { out.backupKeep = Number(this.loadSettings().backupKeep) || 30; } catch (e) { /* ignore */ }
    try {
      const files = fs.readdirSync(this.backupDir).filter(f => f.endsWith('.json'));
      out.backupCount = files.length;
      files.forEach(f => {
        try { out.backupSize += fs.statSync(path.join(this.backupDir, f)).size; } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  nextLeaveNo(records, dateStr) {
    const key = String(dateStr || '').replace(/[^0-9]/g, '');
    const prefix = 'QJ' + key;
    // 取「持久化计数器」和「现有记录里的最大号」的较大值。
    // 前者保证删除后不复用，后者兼容手工改过 leaves.json / 老版本留下的号
    let n = Number((this.loadSettings().noSeq || {})[key]) || 0;
    (records || []).forEach(r => {
      const m = /^QJ(\d{8})-(\d+)$/.exec(String(r.no || ''));
      if (m && m[1] === key) {
        const v = parseInt(m[2], 10);
        if (!isNaN(v) && v > n) n = v;
      }
    });
    return prefix + '-' + String(n + 1).padStart(3, '0');
  }

  // 把记录里出现过的最大号写进计数器（只前进不后退）
  syncNoSeq(records) {
    const seq = Object.assign({}, this.loadSettings().noSeq || {});
    let changed = false;
    (records || []).forEach(r => {
      const m = /^QJ(\d{8})-(\d+)$/.exec(String(r.no || ''));
      if (!m) return;
      const key = m[1];
      const n = parseInt(m[2], 10);
      if (isNaN(n)) return;
      if (!(Number(seq[key]) >= n)) { seq[key] = n; changed = true; }
    });
    if (!changed) return seq;
    const settings = this.loadSettings();
    settings.noSeq = seq;
    this.saveSettings(settings);
    return seq;
  }

  info() {
    return {
      dataDir: this.dataDir,
      backupDir: this.backupDir,
      leavesPath: this.leavesPath,
      hasLeaves: fs.existsSync(this.leavesPath)
    };
  }
}

module.exports = { Store, DEFAULT_SETTINGS, stamp };
