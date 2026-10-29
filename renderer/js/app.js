'use strict';

const L = window.LeaveLogic;
const $ = (id) => document.getElementById(id);

const STATUS_TEXT = { active: '进行中', pending: '待销假', checked: '已销假', revoked: '已撤销' };
const STATUS_RANK = { pending: 0, active: 1, checked: 2, revoked: 3 };
const STATUS_TAG = { active: 'blue', pending: 'amber', checked: 'green', revoked: 'gray' };

// 备份文件的类型标签（文件名里的 tag）
const BACKUP_TAGS = {
  manual: ['手动备份', 'pill pill-blue'],
  auto: ['自动备份', 'pill'],
  'before-restore': ['恢复前自动备份', 'pill pill-amber']
};
const backupTagOf = (tag) => BACKUP_TAGS[tag] || ['备份', 'pill'];

const state = {
  records: [],
  settings: {
    warnDays: 1, criticalDays: 3,
    openWarnDays: 7, openCriticalDays: 14,
    leaveTypes: [], schools: [], subjects: [], grades: []
  },
  view: 'home',
  page: 1,
  pageSize: 20,
  sort: { key: 'startDate', dir: 'desc' },
  editing: null,
  today: { school: '', subject: '', q: '', group: 'school' },
  alerts: { school: '', type: '', level: '', q: '' },
  teachers: { school: '', subject: '', range: '', from: '', to: '', state: '', q: '', sort: 'days' },
  teacherKey: null,
  // 教师详情里那张明细表的筛选与分页，与列表页的 state.page 互不干扰
  teacherRec: { year: '', type: '', state: '', page: 1, pageSize: 10 },
  formPreset: null,
  // 表单里用户手动改过哪些字段（学科/年级/电话），以及表单是否有未保存的改动
  formTouched: { subject: false, grade: false, phone: false },
  formDirty: false,
  // 销假正在确认 / 保存中：挡住连点。首页卡片销假后会立刻重绘，
  // 下面那张卡片会顶到刚点过的位置，双击的第二下就会落到别人身上
  checkBusy: false,
  info: null
};

/* ---------------- utils ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function val(id) { const el = $(id); return el ? el.value : ''; }

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, 2400);
}

function uid() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 校验不通过时把对应输入框标红，比只弹一条 toast 更容易定位。
// 表单比弹窗高时（备注在下面），光标红用户看不见，所以还要滚到这一栏。
function markInvalid(id) {
  const el = $(id);
  if (!el) return;
  const f = el.closest('.field');
  if (!f) return;
  f.classList.add('is-invalid');
  try {
    f.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch (e) {
    try { f.scrollIntoView(); } catch (e2) { /* ignore */ }
  }
  setTimeout(() => f.classList.remove('is-invalid'), 2400);
}

function shortDate(d) { return d ? String(d).slice(5) : ''; }

// 今年的日期只显示月-日，跨年的带上年份，避免"01-05"看不出是哪一年
function dayLabel(d) {
  if (!d) return '';
  return d.slice(0, 4) === String(new Date().getFullYear()) ? d.slice(5) : d;
}

// 请假区间：起止时段一律标出来，避免"到底是上午走还是下午走"看不出来。
// 只有同一天时合并成一个标签（上午 / 下午 / 全天）。
function rangeHTML(r) {
  if (!r.startDate) return '<span class="rng rng-empty">未填日期</span>';
  const title = esc(fullRange(r));
  const sDate = `<span class="rng-date">${esc(dayLabel(r.startDate))}</span>`;
  const startHalf = r.startHalf === 'pm' ? '下午' : '上午';

  if (L.isOpenEnded(r)) {
    return `<span class="rng" title="${title}">${sDate}<span class="rng-half">${startHalf}</span>`
      + `<span class="rng-arrow">→</span><span class="rng-open">未定</span></span>`;
  }
  if (!r.endDate) {
    return `<span class="rng" title="${title}">${sDate}<span class="rng-half">${startHalf}</span>`
      + `<span class="rng-arrow">→</span><span class="rng-open">—</span></span>`;
  }

  if (r.startDate === r.endDate) {
    const full = r.startHalf === 'am' && r.endHalf === 'pm';
    const label = full ? '全天' : (r.startHalf === 'pm' ? '下午' : '上午');
    return `<span class="rng" title="${title}">${sDate}`
      + `<span class="rng-half${full ? ' all' : ''}">${label}</span></span>`;
  }

  const eDate = `<span class="rng-date">${esc(dayLabel(r.endDate))}</span>`;
  const endHalf = r.endHalf === 'am' ? '上午' : '下午';
  return `<span class="rng" title="${title}">${sDate}<span class="rng-half">${startHalf}</span>`
    + `<span class="rng-arrow">→</span>${eDate}<span class="rng-half">${endHalf}</span></span>`;
}

function fullRange(r) { return L.rangeLabel(r); }

function askConfirm(title, text, okText, opts) {
  return new Promise(resolve => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = okText || '确认';
    // 破坏性操作用红色按钮；"继续保存"这类只是确认继续的用主色
    $('confirmOk').className = 'btn ' + (opts && opts.safe ? 'btn-primary' : 'btn-danger');
    $('confirmModal').hidden = false;
    const close = (v) => {
      $('confirmModal').hidden = true;
      $('confirmOk').onclick = null;
      $('confirmCancel').onclick = null;
      resolve(v);
    };
    $('confirmOk').onclick = () => close(true);
    $('confirmCancel').onclick = () => close(false);
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  const res = await window.api.init();

  if (!res.ok) {
    renderFatal(res);
    return;
  }

  state.records = (res.records || []).map(normalize);
  state.settings = Object.assign({
    warnDays: 1, criticalDays: 3,
    openWarnDays: 7, openCriticalDays: 14,
    leaveTypes: [], schools: [], subjects: [], grades: []
  }, res.settings || {});
  state.info = res.info;
  $('verText').textContent = 'v' + (res.version || '1.0.0');

  // 兜底：选项数组必须存在，学校至少一所，否则录入时无法选择
  ['leaveTypes', 'schools', 'subjects', 'grades'].forEach(k => {
    if (!Array.isArray(state.settings[k])) state.settings[k] = [];
  });

  // 学校列表被清空时（历史数据或手工改过 settings.json），
  // 先按记录里用过的学校补回来，再不行才用"本校"，并写回文件，避免下次启动又丢
  let healed = false;
  if (!state.settings.schools.length) {
    const used = Array.from(new Set(state.records.map(r => (r.school || '').trim()).filter(Boolean)));
    state.settings.schools = used.length ? used : ['本校'];
    healed = true;
  }
  if (!state.settings.leaveTypes.length) {
    state.settings.leaveTypes = ['事假', '病假', '公假'];
    healed = true;
  }
  if (healed) {
    try {
      const rs = await window.api.saveSettings(state.settings);
      if (rs && rs.ok) state.settings = Object.assign(state.settings, rs.settings);
    } catch (e) { /* 写不进去也不影响本次使用 */ }
  }

  buildSelects();
  bindEvents();
  renderAll();
  maybeShowFirstRunTip();
}

// 首次打开说明「Windows 已保护你的电脑」怎么过（exe 没有数字签名证书）。
// 只弹一次，关掉后写进 settings.firstRunTipShown；写失败也没关系，下次再提示。
async function maybeShowFirstRunTip() {
  const box = $('firstRun');
  if (!box || state.settings.firstRunTipShown) return;
  box.hidden = false;
  const close = async () => {
    box.hidden = true;
    state.settings.firstRunTipShown = true;
    try {
      const res = await window.api.saveSettings(state.settings);
      if (res && res.ok && res.settings) state.settings = Object.assign(state.settings, res.settings);
    } catch (e) { /* 忽略：下次打开再提示一遍 */ }
  };
  $('firstRunOk').addEventListener('click', close, { once: true });
  const mask = box.querySelector('.modal-mask');
  if (mask) mask.addEventListener('click', close, { once: true });
}

function normalize(r) {
  const rec = Object.assign({}, r);

  // 老版本把"学科 / 年级"存在一个字段里，这里拆开
  if (!rec.grade) {
    const sp = L.splitSubject(rec.subject);
    rec.subject = sp.subject;
    if (sp.grade) rec.grade = sp.grade;
  }

  if (rec.openEnded !== true) rec.openEnded = false;
  if (!rec.startHalf) rec.startHalf = 'am';
  if (!rec.endHalf) rec.endHalf = 'pm';

  rec.days = L.effectiveDays(rec, new Date());
  if (!rec.school) rec.school = '';
  return rec;
}

function renderFatal(res) {
  const backups = res.backups || [];
  // 数据文件坏了，用户得在这里挑一份备份：必须看清每份里有多少条记录，
  // 否则很容易挑到「刚删除完」的那一份，恢复出来还是空的
  const list = backups.slice(0, 12).map(b => {
    const when = b.takenAt ? L.formatDateTime(new Date(b.takenAt)) : '';
    const tag = backupTagOf(b.tag);
    const detail = b.corrupt
      ? '文件也无法读取'
      : `${b.records} 条记录 · ${b.teachers} 位教师` +
        (b.sample && b.sample.length ? `：${b.sample.join('、')}${b.teachers > b.sample.length ? ' 等' : ''}` : '');
    return `<div class="backup-item">
      <span class="bleft">
        <span class="bt">${esc(when || b.name)}<span class="${tag[1]}">${esc(tag[0])}</span></span>
        <span class="bs">${esc(detail)}</span></span>
      ${b.corrupt ? '<span class="bs">不可用</span>'
        : `<button class="link-btn" data-fatal-restore="${esc(b.name)}">恢复</button>`}</div>`;
  }).join('');

  document.querySelector('.content').innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>数据文件无法读取</h2></div>
      <div class="panel-body">
        <p class="confirm-text">${esc(res.error || '未知错误')}</p>
        <p class="hint">数据文件位于：<code>${esc((res.info && res.info.leavesPath) || '')}</code><br>
        可以从下面的备份中选一份记录数合适的恢复。恢复前会先把当前文件另存一份。</p>
        <div class="backup-list">${list || '<div class="empty">没有可用备份</div>'}</div>
      </div>
    </div>`;

  document.querySelectorAll('[data-fatal-restore]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-fatal-restore');
      const item = backups.find(b => b.name === name);
      const detail = item && !item.corrupt
        ? `该备份含 ${item.records} 条记录、${item.teachers} 位教师。`
        : '';
      const ok = await askConfirm('恢复数据', `确认用这份备份覆盖当前数据文件？\n${detail}`, '确认恢复');
      if (!ok) return;
      const rs = await window.api.restoreBackup(name);
      if (!rs.ok) { toast(rs.error || '恢复失败', 'err'); return; }
      toast('已恢复，正在重新加载');
      setTimeout(() => location.reload(), 700);
    });
  });
}

/* ---------------- 下拉框 ---------------- */

function fillOptions(el, items, placeholder) {
  if (!el) return;
  const old = el.value;
  const head = placeholder == null ? '' : `<option value="">${esc(placeholder)}</option>`;
  el.innerHTML = head + (items || []).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  if (old && Array.from(el.options).some(o => o.value === old)) el.value = old;
}

function setSelectValue(el, v) {
  if (!el) return;
  const value = v == null ? '' : String(v);
  if (value && !Array.from(el.options).some(o => o.value === value)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = value + '（不在选项中）';
    el.appendChild(o);
  }
  el.value = value;
}

// 筛选用的选项 = 设置里的选项 + 记录里实际出现过、但已从设置中删掉的值。
// 否则老记录的学校/学科被删掉后，就再也没法在筛选栏里筛出来了。
function unionOptions(key, pick) {
  const set = new Set(state.settings[key] || []);
  state.records.forEach(r => {
    if (r.revokedAt) return;
    const v = pick(r);
    if (v) set.add(v);
  });
  return Array.from(set);
}

function buildSelects() {
  const s = state.settings;
  const schoolOpts = unionOptions('schools', r => r.school);
  const subjectOpts = unionOptions('subjects', r => L.subjectOf(r));
  const typeOpts = unionOptions('leaveTypes', r => r.type);

  fillOptions($('fSchool'), schoolOpts, '全部学校');
  fillOptions($('fFilterSubject'), subjectOpts, '全部学科');
  fillOptions($('fType'), typeOpts, '全部类型');

  // 录入表单里的学校必须有明确的选择，留一个"请选择学校"占位，
  // 这样列表为空时一眼就能看出来，而不是显示成空白框
  fillOptions($('fFormSchool'), s.schools, '请选择学校');
  fillOptions($('fFormSubject'), s.subjects, '请选择学科');
  fillOptions($('fFormGrade'), s.grades, '不指定');
  fillOptions($('fFormType'), s.leaveTypes, null);

  fillOptions($('todaySchool'), schoolOpts, '全部学校');
  fillOptions($('todaySubject'), subjectOpts, '全部学科');
  fillOptions($('alertSchool'), schoolOpts, '全部学校');
  fillOptions($('alertType'), typeOpts, '全部类型');
  fillOptions($('tSchool'), schoolOpts, '全部学校');
  fillOptions($('tSubject'), subjectOpts, '全部学科');

  // 选项被删掉后，筛选值要同步失效，避免出现"筛选项已不存在"的空白结果
  if (state.today.school && !schoolOpts.includes(state.today.school)) state.today.school = '';
  if (state.today.subject && !subjectOpts.includes(state.today.subject)) state.today.subject = '';
  $('todaySchool').value = state.today.school;
  $('todaySubject').value = state.today.subject;
  $('todayGroup').value = state.today.group;

  if (state.alerts.school && !schoolOpts.includes(state.alerts.school)) state.alerts.school = '';
  if (state.alerts.type && !typeOpts.includes(state.alerts.type)) state.alerts.type = '';
  $('alertSchool').value = state.alerts.school;
  $('alertType').value = state.alerts.type;
  $('alertLevel').value = state.alerts.level;

  if (state.teachers.school && !schoolOpts.includes(state.teachers.school)) state.teachers.school = '';
  if (state.teachers.subject && !subjectOpts.includes(state.teachers.subject)) state.teachers.subject = '';
  $('tSchool').value = state.teachers.school;
  $('tSubject').value = state.teachers.subject;
}

/* ---------------- events ---------------- */

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('btnAdd').addEventListener('click', () => openForm(null));
  $('btnOpenData').addEventListener('click', () => window.api.openDataFolder());

  $('modalClose').addEventListener('click', requestCloseForm);
  $('btnCancel').addEventListener('click', requestCloseForm);
  $('btnSave').addEventListener('click', saveForm);
  // 编辑时可以直接在表单里删掉这条记录，不用先关窗再去列表里找
  $('btnFormDelete').addEventListener('click', () => {
    if (state.editing) deleteRecord(state.editing.id, true);
  });
  document.querySelector('#modal .modal-mask').addEventListener('click', requestCloseForm);

  // 用户动过哪些字段：关掉自动带出，避免覆盖手动选择
  ['fFormSubject', 'fFormGrade', 'fFormPhone'].forEach(id => {
    $(id).addEventListener('change', () => {
      const k = id.replace('fForm', '').toLowerCase();
      state.formTouched[k] = true;
      state.formDirty = true;
    });
  });
  // 只要用户在表单里动过任何东西，关闭前就提醒一次（防止手滑丢掉填了一半的记录）
  ['input', 'change'].forEach(ev => {
    $('modal').addEventListener(ev, e => {
      if (e.target && e.target.closest && e.target.closest('.modal-body')) state.formDirty = true;
    }, true);
  });

  ['fFormStart', 'fFormStartHalf', 'fFormEnd', 'fFormEndHalf'].forEach(id => {
    $(id).addEventListener('change', () => {
      $('overlapWarn').hidden = true;
      updateDaysPreview();
    });
  });

  $('fFormOpenEnd').addEventListener('change', () => {
    $('overlapWarn').hidden = true;
    syncOpenEnd();
  });

  $('fFormChecked').addEventListener('change', updateCheckedNote);

  $('fFormName').addEventListener('change', () => { autofillFromName(); updateNameNote(); });
  $('fFormName').addEventListener('input', debounce(updateNameNote, 240));
  // 学校一改，姓名候选就得跟着换；姓名若已不属于这所学校，提示用户确认
  $('fFormSchool').addEventListener('change', () => {
    fillFormNameList();
    autofillFromName();
    updateNameNote();
  });

  $('fName').addEventListener('input', debounce(() => { state.page = 1; renderList(); }, 180));
  ['fSchool', 'fFilterSubject', 'fType', 'fStatus', 'fFrom', 'fTo', 'fSub'].forEach(id => {
    $(id).addEventListener('change', () => { state.page = 1; renderList(); });
  });

  $('btnReset').addEventListener('click', () => {
    ['fSchool', 'fName', 'fFilterSubject', 'fType', 'fStatus', 'fFrom', 'fTo', 'fSub'].forEach(id => { $(id).value = ''; });
    state.page = 1;
    renderList();
  });

  // 今日在假：筛选与分组
  ['todaySchool', 'todaySubject', 'todayGroup'].forEach(id => {
    $(id).addEventListener('change', () => {
      state.today.school = val('todaySchool');
      state.today.subject = val('todaySubject');
      state.today.group = val('todayGroup') || 'school';
      renderHome();
    });
  });
  $('todaySearch').addEventListener('input', debounce(() => {
    state.today.q = val('todaySearch').trim();
    renderHome();
  }, 180));

  // 未销假提醒：按学校 / 类型 / 紧急程度 / 姓名筛选
  ['alertSchool', 'alertType', 'alertLevel'].forEach(id => {
    $(id).addEventListener('change', () => {
      state.alerts.school = val('alertSchool');
      state.alerts.type = val('alertType');
      state.alerts.level = val('alertLevel');
      renderHome();
    });
  });
  $('alertSearch').addEventListener('input', debounce(() => {
    state.alerts.q = val('alertSearch').trim();
    renderHome();
  }, 180));

  // 教师档案：筛选与排序
  ['tSchool', 'tSubject', 'tState', 'tSort'].forEach(id => {
    $(id).addEventListener('change', () => {
      state.teachers.school = val('tSchool');
      state.teachers.subject = val('tSubject');
      state.teachers.state = val('tState');
      state.teachers.sort = val('tSort') || 'days';
      renderTeachers();
    });
  });

  // 「统计范围」选完自动带出起止日期，选"自定义"则交给用户填
  $('tRange').addEventListener('change', () => {
    state.teachers.range = val('tRange');
    // 「从 / 至」只在自定义时才露出来，预设区间由程序自己算，少占两格
    const custom = state.teachers.range === 'custom';
    $('tFromField').hidden = !custom;
    $('tToField').hidden = !custom;
    const now = new Date();
    if (state.teachers.range === 'term') {
      const t = L.termRange(now);
      $('tFrom').value = t.start;
      $('tTo').value = t.end;
    } else if (state.teachers.range === 'year') {
      const y = now.getFullYear();
      $('tFrom').value = y + '-01-01';
      $('tTo').value = y + '-12-31';
    } else if (state.teachers.range === 'month') {
      const m = L.monthRange(now);
      $('tFrom').value = m.start;
      $('tTo').value = m.end;
    } else if (state.teachers.range !== 'custom') {
      $('tFrom').value = '';
      $('tTo').value = '';
    }
    state.teachers.from = val('tFrom');
    state.teachers.to = val('tTo');
    renderTeachers();
  });

  ['tFrom', 'tTo'].forEach(id => {
    $(id).addEventListener('change', () => {
      state.teachers.from = val('tFrom');
      state.teachers.to = val('tTo');
      // 手动改日期就视为自定义区间，避免「本学期」显示着却按手填日期算
      if (state.teachers.from || state.teachers.to) {
        state.teachers.range = 'custom';
        $('tRange').value = 'custom';
      }
      renderTeachers();
    });
  });

  $('tName').addEventListener('input', debounce(() => {
    state.teachers.q = val('tName').trim();
    renderTeachers();
  }, 180));

  $('tReset').addEventListener('click', () => {
    state.teachers = { school: '', subject: '', range: '', from: '', to: '', state: '', q: '', sort: 'days' };
    ['tSchool', 'tSubject', 'tRange', 'tFrom', 'tTo', 'tState', 'tName'].forEach(id => { $(id).value = ''; });
    $('tSort').value = 'days';
    $('tFromField').hidden = true;
    $('tToField').hidden = true;
    state.teacherKey = null;
    renderTeachers();
  });

  // 打开 / 返回教师详情：事件委托，重绘后不用重复绑定
  document.addEventListener('click', e => {
    // 首页新手引导里的两个快捷入口
    if (e.target.closest('[data-goto-add]')) { openForm(null); return; }
    if (e.target.closest('[data-goto-settings]')) {
      switchView('settings');
      setTimeout(() => { const el = $('newSchool'); if (el) el.focus(); }, 120);
      return;
    }

    const card = e.target.closest('[data-teacher]');
    if (card) {
      state.teacherKey = card.dataset.teacher;
      // 换一位教师，明细表的筛选和页码都要回到初始状态
      state.teacherRec = { year: '', type: '', state: '', page: 1, pageSize: state.teacherRec.pageSize };
      if (state.view === 'teachers') renderTeachers();
      else switchView('teachers');
      document.querySelector('.content').scrollTop = 0;
      return;
    }
    if (e.target.closest('#tBack')) {
      state.teacherKey = null;
      renderTeachers();
      document.querySelector('.content').scrollTop = 0;
      return;
    }

    // ---- 教师详情里的明细表：新增请假 / 行操作 / 筛选 / 分页 ----
    const add = e.target.closest('[data-tadd]');
    if (add) { openFormForTeacher(add.dataset.tadd); return; }

    const dact = e.target.closest('[data-dact]');
    if (dact) { handleRowAction(dact.dataset.dact, dact.dataset.did); return; }

    const tdel = e.target.closest('[data-tdel]');
    if (tdel) { deleteTeacher(tdel.dataset.tdel); return; }

    const texp = e.target.closest('[data-texport]');
    if (texp) { exportTeacher(); return; }

    const tp = e.target.closest('[data-tp]');
    if (tp) {
      const fr = state.teacherRec;
      const total = countTeacherRecs();
      const maxPage = Math.max(1, Math.ceil(total / fr.pageSize));
      if (tp.dataset.tp === 'prev' && fr.page > 1) fr.page--;
      if (tp.dataset.tp === 'next' && fr.page < maxPage) fr.page++;
      renderTeacherDetail(new Date());
      return;
    }

    if (e.target.closest('[data-tfreset]')) {
      state.teacherRec.year = '';
      state.teacherRec.type = '';
      state.teacherRec.state = '';
      state.teacherRec.page = 1;
      renderTeacherDetail(new Date());
    }
  });

  // 明细表筛选下拉：学校/类型/状态任一变化都回到第 1 页
  document.addEventListener('change', e => {
    const sel = e.target.closest('[data-tf]');
    if (sel) {
      state.teacherRec[sel.dataset.tf] = sel.value;
      state.teacherRec.page = 1;
      renderTeacherDetail(new Date());
      return;
    }
    const size = e.target.closest('[data-tpsize]');
    if (size) {
      state.teacherRec.pageSize = Number(size.value) || 10;
      state.teacherRec.page = 1;
      renderTeacherDetail(new Date());
    }
  });

  $('btnQuickTerm').addEventListener('click', () => {
    const t = L.termRange(new Date());
    $('fFrom').value = t.start;
    $('fTo').value = t.end;
    state.page = 1;
    renderList();
  });

  $('btnExport').addEventListener('click', doExport);

  $('pageSize').addEventListener('change', () => {
    state.pageSize = Number($('pageSize').value) || 20;
    state.page = 1;
    renderList();
  });
  $('btnPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; renderList(); } });
  $('btnNext').addEventListener('click', () => {
    const total = getFilteredSorted().length;
    const max = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page < max) { state.page++; renderList(); }
  });

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        state.sort.dir = key === 'name' || key === 'school' ? 'asc' : 'desc';
      }
      renderList();
    });
  });

  ['setWarn', 'setCritical', 'setOpenWarn', 'setOpenCritical', 'setBackupKeep'].forEach(id => {
    $(id).addEventListener('change', saveSettingsFromForm);
  });

  $('btnAddType').addEventListener('click', () => addSettingItem('leaveTypes', 'newType', '类型'));
  $('btnAddSchool').addEventListener('click', () => addSettingItem('schools', 'newSchool', '学校'));
  $('btnAddSubject').addEventListener('click', () => addSettingItem('subjects', 'newSubject', '学科'));
  $('btnAddGrade').addEventListener('click', () => addSettingItem('grades', 'newGrade', '年级'));

  [['newType', 'leaveTypes', '类型'], ['newSchool', 'schools', '学校'],
   ['newSubject', 'subjects', '学科'], ['newGrade', 'grades', '年级']].forEach(([inputId, key, label]) => {
    $(inputId).addEventListener('keydown', e => { if (e.key === 'Enter') addSettingItem(key, inputId, label); });
  });

  // 删除 / 补入 chips：事件委托，避免每次重绘都要重绑
  document.addEventListener('click', e => {
    const add = e.target.closest('[data-chip-add]');
    if (add) {
      addSettingItemSilent('schools', add.dataset.chipAdd);
      return;
    }
    const btn = e.target.closest('[data-chip-del]');
    if (!btn) return;
    const key = btn.dataset.chipKey;
    const label = btn.dataset.chipDel;
    removeSettingItem(key, label);
  });

  // 表单里没有学校可选时，直接跳到设置去加
  $('btnGoSchool').addEventListener('click', () => {
    closeForm();
    switchView('settings');
    setTimeout(() => $('newSchool').focus(), 60);
  });
  $('btnOpenData2').addEventListener('click', () => window.api.openDataFolder());

  $('btnBackupNow').addEventListener('click', async () => {
    const r = await window.api.createBackup();
    if (r.ok) { toast('已备份一份', 'ok'); renderBackups(); renderDataStats(); } else { toast('备份失败', 'err'); }
  });
  $('btnOpenBackup').addEventListener('click', () => window.api.openBackupFolder());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('confirmModal').hidden) { $('confirmCancel').click(); return; }
      if (!$('modal').hidden) requestCloseForm();
    }
    // Ctrl/⌘ + S、Ctrl/⌘ + Enter 都能保存表单，录完一条不用再找鼠标
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 's' || e.key === 'Enter')) {
      if (!$('modal').hidden) { e.preventDefault(); saveForm(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if ($('modal').hidden) openForm(null);
    }
  });
}

function debounce(fn, wait) {
  let t;
  return function () {
    clearTimeout(t);
    t = setTimeout(fn, wait);
  };
}

/* ---------------- view switch ---------------- */

function switchView(name) {
  state.view = name;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');

  const titles = {
    home: ['首页', '未销假提醒与本期概况'],
    list: ['数据总览', '筛选、编辑与导出全部请假记录'],
    teachers: ['教师档案', '按教师查看历次请假明细与累计统计'],
    settings: ['设置', '学校、学科年级、提醒阈值与数据备份']
  };
  $('pageTitle').textContent = titles[name][0];
  $('pageSub').textContent = titles[name][1];

  if (name === 'home') renderHome();
  if (name === 'list') renderList();
  if (name === 'teachers') renderTeachers();
  if (name === 'settings') renderSettings();
}

function renderAll() {
  fillNameList();
  renderHome();
  renderList();
  renderTeachers();
  renderSettings();
  updateBadge();
}

function fillNameList() {
  const map = new Map();
  state.records.forEach(r => {
    const n = (r.name || '').trim();
    if (!n) return;
    const t = r.createdAt || '';
    if (!map.has(n) || map.get(n) < t) map.set(n, t);
  });
  const names = Array.from(map.entries())
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .map(x => x[0]);
  $('nameList').innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
}

// 新增/编辑表单里的姓名下拉只列当前所选学校的老师，
// 避免"选了 A 校却从下拉里挑出 B 校的人"，把学校和人绑错。
function fillFormNameList() {
  const box = $('formNameList');
  if (!box) return;
  const school = val('fFormSchool');
  const map = new Map();
  state.records.forEach(r => {
    if (school && (r.school || '') !== school) return;
    const n = (r.name || '').trim();
    if (!n) return;
    const t = r.createdAt || '';
    if (!map.has(n) || map.get(n) < t) map.set(n, t);
  });
  const names = Array.from(map.entries())
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .map(x => x[0]);
  box.innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
}

function updateBadge() {
  const now = new Date();
  const n = state.records.filter(r => L.severity(r, now, state.settings) !== null).length;
  const b = $('navBadge');
  if (n > 0) { b.hidden = false; b.textContent = n > 99 ? '99+' : n; } else { b.hidden = true; }
}

/* ---------------- home ---------------- */

// 一条记录都没有时的引导。新装软件的第一次打开最怕"空白一片不知道先点哪"，
// 这里直接把三步说清楚，能点的按钮就在旁边。
function renderOnboard() {
  const ob = $('onboard');
  if (!ob) return;
  const firstRun = state.records.length === 0;
  ob.hidden = !firstRun;
  if (!firstRun) { ob.innerHTML = ''; return; }

  const schoolCount = (state.settings.schools || []).length;
  ob.innerHTML = `
    <div class="onboard-head">
      <h2>还没有任何记录，三步就能开始用</h2>
      <p>数据只保存在这台电脑的 data 文件夹里，不联网、不上传，整个文件夹拷走就能换电脑继续用。</p>
    </div>
    <div class="onboard-steps">
      <div class="ostep${schoolCount ? ' done' : ' need'}">
        <div class="ostep-top"><span class="onum">1</span><b>先加一所学校</b></div>
        <p>${schoolCount ? `已有 ${schoolCount} 所学校，新增时可以从下拉框直接选。` : '现在一所学校都没有，新增请假时下拉框会是空的。'}</p>
        ${schoolCount ? '' : '<button class="btn btn-ghost btn-sm" data-goto-settings>去设置里添加</button>'}
      </div>
      <div class="ostep">
        <div class="ostep-top"><span class="onum">2</span><b>录第一条请假</b></div>
        <p>学校、姓名、学科、起止日期必填；结束日期不确定就勾「结束日期未定」。</p>
        <button class="btn btn-primary btn-sm" data-goto-add>新增请假</button>
      </div>
      <div class="ostep">
        <div class="ostep-top"><span class="onum">3</span><b>到期没销假会自动提醒</b></div>
        <p>「未销假提醒」里点卡片可以改，点「销假」这条请假就结束了。</p>
      </div>
    </div>`;
}

function renderHome() {
  const now = new Date();
  const month = L.monthRange(now);

  renderOnboard();

  const alive = state.records.filter(r => !r.revokedAt);
  const monthRecs = alive.filter(r => r.startDate >= month.start && r.startDate <= month.end);
  const allAlerts = alive.filter(r => L.severity(r, now, state.settings) !== null);
  // 今日在假：按日期判断（isOngoingToday），不看 endMoment。
  // 结束时刻改成 18:00 之后，当天的假在傍晚会变成"待销假"，
  // 但"今天有谁不在岗"这件事到深夜都成立，所以这里只用 !checkedAt 过滤
  const ongoing = alive.filter(r => L.isOngoingToday(r, now) && !r.checkedAt);
  // 未销假 = 所有还没销假的（含已到期该销的 + 还没到期的）
  const unchecked = alive.filter(r => !r.checkedAt);
  const notDueAll = unchecked.filter(r => L.severity(r, now, state.settings) === null);

  // 未销假提醒：学校 / 类型 / 紧急程度 / 姓名四个条件叠加
  const af = state.alerts;
  const alertFiltered = !!(af.school || af.type || af.level || af.q);
  const matchBase = (r) => {
    if (af.school && (r.school || '') !== af.school) return false;
    if (af.type && (r.type || '') !== af.type) return false;
    if (af.q) {
      const q = af.q.toLowerCase();
      if (!(r.name || '').toLowerCase().includes(q) && !(r.reason || '').toLowerCase().includes(q)) return false;
    }
    return true;
  };
  const alerts = !alertFiltered ? allAlerts : allAlerts.filter(r => {
    if (!matchBase(r)) return false;
    if (af.level && L.severity(r, now, state.settings) !== af.level) return false;
    return true;
  });
  // 还没到期的那些不受「紧急程度」筛选影响（它们本来就没有等级），
  // 但选了等级就说明只想看该销假的，所以这种情况下不显示
  const notDue = af.level ? [] : (alertFiltered ? notDueAll.filter(matchBase) : notDueAll);
  const shownTodo = alerts.length + notDue.length;

  $('statCards').innerHTML = `
    <div class="stat">
      <div class="label"><span class="dot dot-blue"></span>本月请假人次</div>
      <div class="value">${monthRecs.length}<small>人次</small></div>
    </div>
    <div class="stat">
      <div class="label"><span class="dot dot-green"></span>当前在假</div>
      <div class="value">${ongoing.length}<small>人</small></div>
    </div>
    <div class="stat ${allAlerts.length ? 'alert' : ''}">
      <div class="label"><span class="dot dot-amber"></span>未销假</div>
      <div class="value">${unchecked.length}<small>人</small></div>
    </div>`;

  $('alertCount').textContent = alertFiltered
    ? `${shownTodo} / ${unchecked.length} 条`
    : unchecked.length + ' 条';
  $('alertCount').className = 'pill ' + (unchecked.length ? 'pill-amber' : '');

  const groups = { critical: [], warn: [], today: [] };
  alerts.forEach(r => {
    const sev = L.severity(r, now, state.settings);
    if (groups[sev]) groups[sev].push(r);
  });

  const weight = (r) => L.isOpenEnded(r) ? L.elapsedDays(r, now) : L.overdueDays(r, now);
  Object.keys(groups).forEach(k => groups[k].sort((a, b) => weight(b) - weight(a)));

  const groupMeta = [
    ['critical', '已超期较久，建议优先处理'],
    ['warn', '已超期，待跟进'],
    ['today', '今天刚结束，待确认销假']
  ];

  const sc = state.settings.criticalDays;
  const oc = state.settings.openCriticalDays;

  let html = '';
  groupMeta.forEach(([key, desc]) => {
    const list = groups[key];
    if (!list.length) return;
    let tip = desc;
    if (key === 'critical') tip = `已结束满 ${sc} 天，或结束日期未定已请满 ${oc} 天`;
    if (key === 'warn') tip = '进入提醒范围，尚未销假';
    html += `<div class="alert-group">
      <div class="alert-group-title"><span class="dot ${key === 'critical' ? 'dot-red' : 'dot-amber'}"></span>${esc(tip)}
        <span class="pill${key === 'critical' ? ' pill-red' : ''}">${list.length}</span></div>
      <div class="alert-cards">`;
    list.forEach(r => {
      const label = L.alertText(r, now);
      const running = L.isRunning(r);
      html += `<div class="acard ${key === 'critical' ? 'critical' : key === 'today' ? 'today' : ''}"
        data-alert-edit="${esc(r.id)}" title="点击查看或编辑这条请假">
        <div class="acard-top">
          <span class="acard-name">${esc(r.name)}<span class="acard-type">${esc(r.type || '未填类型')}</span></span>
          <span class="acard-days">${esc(label)}</span>
        </div>
        <div class="acard-meta">${rangeHTML(r)} · 共 ${L.fmtDays(L.effectiveDays(r, now))}${running ? '（累计）' : ''}</div>
        <div class="acard-foot">
          <span class="acard-meta">${esc([r.school || '未填学校', L.subjectLabel(r)].filter(Boolean).join(' · '))}${r.reason ? ' · ' + esc(r.reason) : ''}</span>
          <button class="btn btn-ghost btn-sm" data-check="${esc(r.id)}" title="把这条请假标记为已销假">销假</button>
        </div>
      </div>`;
    });
    html += '</div></div>';
  });

  // 还没结束的：同样未销假，得让人看得见，但不做紧急提示
  if (notDue.length) {
    const sorted = notDue.slice().sort((a, b) => {
      const ka = L.notDueKind(a, now) === 'running' ? 0 : 1;
      const kb = L.notDueKind(b, now) === 'running' ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return String(a.startDate || '').localeCompare(String(b.startDate || ''));
    });
    html += `<div class="alert-group">
      <div class="alert-group-title"><span class="dot dot-blue"></span>还没结束，暂时不用销假
        <span class="pill pill-blue">${sorted.length}</span></div>
      <div class="alert-cards">`;
    sorted.forEach(r => {
      html += `<div class="acard soon" data-alert-edit="${esc(r.id)}" title="点击查看或编辑这条请假">
        <div class="acard-top">
          <span class="acard-name">${esc(r.name)}<span class="acard-type">${esc(r.type || '未填类型')}</span></span>
          <span class="acard-days">${esc(L.notDueText(r, now))}</span>
        </div>
        <div class="acard-meta">${rangeHTML(r)} · 共 ${L.fmtDays(L.effectiveDays(r, now))}${L.isRunning(r) ? '（累计）' : ''}</div>
        <div class="acard-foot">
          <span class="acard-meta">${esc([r.school || '未填学校', L.subjectLabel(r)].filter(Boolean).join(' · '))}${r.reason ? ' · ' + esc(r.reason) : ''}</span>
          ${L.isOngoingToday(r, now) ? `<button class="btn btn-ghost btn-sm" data-check="${esc(r.id)}" title="提前结束，把这条请假标记为已销假">销假</button>` : ''}
        </div>
      </div>`;
    });
    html += '</div></div>';
  }

  if (unchecked.length && !shownTodo) {
    html = `<div class="empty">
      <div class="empty-icon">⌕</div>
      <strong>当前筛选下没有未销假记录</strong>
      共有 ${unchecked.length} 条未销假，换个条件看看，或
      <button class="link-btn" data-alert-reset>清除筛选</button>
    </div>`;
  }

  $('alertList').innerHTML = html || (state.records.length === 0
    ? `<div class="empty">
      <div class="empty-icon">◷</div>
      <strong>还没有请假记录</strong>
      录了第一条请假之后，到期还没销假的记录会自动出现在这里提醒你。
    </div>`
    : `<div class="empty">
      <div class="empty-icon">✓</div>
      <strong>没有未销假的记录</strong>
      所有请假都已销假。新录的请假会先出现在这里，到期后再提醒你处理。
    </div>`);

  // 今日在假：先按学校 / 学科 / 姓名筛选，再按学校或学科分组
  const tf = state.today;
  let shown = ongoing.slice();
  if (tf.school) shown = shown.filter(r => (r.school || '') === tf.school);
  if (tf.subject) shown = shown.filter(r => L.subjectOf(r) === tf.subject);
  if (tf.q) {
    const q = tf.q.toLowerCase();
    shown = shown.filter(r => (r.name || '').toLowerCase().includes(q) || (r.reason || '').toLowerCase().includes(q));
  }
  const isFiltered = !!(tf.school || tf.subject || tf.q);
  $('todayCount').textContent = isFiltered ? `${shown.length} / ${ongoing.length} 人` : `${ongoing.length} 人`;

  $('todayList').innerHTML = renderTodayList(shown, ongoing.length, now);

  // 卡片主体：点一下打开这条记录查看/编辑；卡上的「销假」按钮独立走确认流程
  document.querySelectorAll('#alertList .acard').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-check]')) return;
      const rec = state.records.find(r => r.id === card.dataset.alertEdit);
      if (rec) openForm(rec);
    });
    const btn = card.querySelector('[data-check]');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        markChecked(btn.dataset.check);
      });
    }
  });
  const alertReset = document.querySelector('[data-alert-reset]');
  if (alertReset) alertReset.addEventListener('click', resetAlertFilter);
  document.querySelectorAll('#todayList [data-today-edit]').forEach(el => {
    el.addEventListener('click', () => {
      const rec = state.records.find(r => r.id === el.dataset.todayEdit);
      if (rec) openForm(rec);
    });
  });
  const resetBtn = document.querySelector('[data-today-reset]');
  if (resetBtn) resetBtn.addEventListener('click', resetTodayFilter);
}

function todayCard(r, now) {
  const open = L.isOpenEnded(r);
  const days = L.effectiveDays(r, now);
  const sub = [L.subjectOf(r), L.gradeOf(r)].filter(Boolean).join(' · ');
  return `<div class="tcard${open ? ' open' : ''}" data-today-edit="${esc(r.id)}" title="点击查看或编辑">
    <div class="tcard-top">
      <b>${esc(r.name)}</b>
      <span class="ttype">${esc(r.type || '未填')}</span>
    </div>
    <div class="tcard-range">${rangeHTML(r)}</div>
    <div class="tcard-foot">
      <span class="tcard-days">${L.fmtDays(days)}${open ? ' <em>累计</em>' : ''}</span>
      <span class="tcard-sub">${esc(sub || '未填学科')}</span>
    </div>
  </div>`;
}

function renderTodayList(list, total, now) {
  if (!total) return `<div class="empty"><strong>今天没有教师请假</strong>全部人员在岗。</div>`;
  if (!list.length) {
    return `<div class="empty"><strong>当前筛选下没有在假教师</strong>换个条件看看，或
      <button class="link-btn" data-today-reset>清除筛选</button></div>`;
  }

  const groupKey = state.today.group === 'school' ? 'school' : state.today.group === 'subject' ? 'subject' : null;
  if (!groupKey) {
    const sorted = list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    return `<div class="tgrid">${sorted.map(r => todayCard(r, now)).join('')}</div>`;
  }

  const buckets = new Map();
  list.forEach(r => {
    const k = groupKey === 'school'
      ? (r.school || '未填学校')
      : (L.subjectOf(r) || '未填学科');
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  });

  const keys = Array.from(buckets.keys()).sort((a, b) => {
    // 按设置里维护的顺序排列（第一中学、第二中学……），未填的放最后
    const orderList = groupKey === 'school' ? state.settings.schools : state.settings.subjects;
    const ia = (orderList || []).indexOf(a);
    const ib = (orderList || []).indexOf(b);
    if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return a.localeCompare(b, 'zh');
  });

  return keys.map(k => {
    const items = buckets.get(k).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    return `<div class="today-group">
      <div class="today-group-title">${esc(k)}<span class="pill">${items.length} 人</span></div>
      <div class="tgrid">${items.map(r => todayCard(r, now)).join('')}</div>
    </div>`;
  }).join('');
}

function resetTodayFilter() {
  state.today.school = '';
  state.today.subject = '';
  state.today.q = '';
  $('todaySchool').value = '';
  $('todaySubject').value = '';
  $('todaySearch').value = '';
  renderHome();
}

function resetAlertFilter() {
  state.alerts.school = '';
  state.alerts.type = '';
  state.alerts.level = '';
  state.alerts.q = '';
  $('alertSchool').value = '';
  $('alertType').value = '';
  $('alertLevel').value = '';
  $('alertSearch').value = '';
  renderHome();
}

/* ---------------- list ---------------- */

function getFiltered() {
  const now = new Date();
  const school = val('fSchool');
  const name = val('fName').trim().toLowerCase();
  const subject = val('fFilterSubject');
  const type = val('fType');
  const status = val('fStatus');
  const from = val('fFrom');
  const to = val('fTo');
  const sub = val('fSub');

  return state.records.filter(r => {
    if (school && (r.school || '') !== school) return false;
    if (name && !(r.name || '').toLowerCase().includes(name)) return false;
    if (subject && L.subjectOf(r) !== subject) return false;
    if (type && r.type !== type) return false;
    if (status) {
      const st = L.computeStatus(r, now);
      if (status === 'pending') {
        const isPending = st === 'pending' || (L.isOpenEnded(r) && L.severity(r, now, state.settings) !== null);
        if (!isPending) return false;
      } else if (st !== status) return false;
    }
    if (from && (!r.startDate || r.startDate < from)) return false;
    if (to && (!r.startDate || r.startDate > to)) return false;
    if (sub === '1' && !r.substitute) return false;
    if (sub === '0' && r.substitute) return false;
    return true;
  });
}

function getFilteredSorted() {
  const rows = getFiltered();
  const now = new Date();
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;

  rows.sort((a, b) => {
    let av, bv;
    if (key === 'name') { av = a.name || ''; bv = b.name || ''; return av.localeCompare(bv, 'zh') * mul; }
    if (key === 'school') { av = a.school || ''; bv = b.school || ''; return av.localeCompare(bv, 'zh') * mul; }
    if (key === 'days') { av = L.effectiveDays(a, now); bv = L.effectiveDays(b, now); }
    else if (key === 'status') { av = STATUS_RANK[L.computeStatus(a, now)]; bv = STATUS_RANK[L.computeStatus(b, now)]; }
    else { av = a.startDate || ''; bv = b.startDate || ''; }
    if (av === bv) return (a.name || '').localeCompare(b.name || '', 'zh');
    return (av > bv ? 1 : -1) * mul;
  });
  return rows;
}

function renderList() {
  const now = new Date();
  const rows = getFilteredSorted();
  const total = rows.length;
  const maxPage = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > maxPage) state.page = maxPage;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  const runningCount = rows.filter(r => L.isRunning(r)).length;
  const noSchoolCount = rows.filter(r => !r.school).length;
  let summary = `共 <b>${total}</b> 条记录`;
  if (runningCount) summary += `<span class="sep">|</span>其中 <b>${runningCount}</b> 条结束日期未定（按今日累计）`;
  if (noSchoolCount) summary += `<span class="sep">|</span><b class="warn-text">${noSchoolCount} 条未填学校</b>，请编辑补上`;
  $('listSummary').innerHTML = total ? summary : '共 0 条记录';

  if (!pageRows.length) {
    $('tbody').innerHTML = `<tr><td colspan="10">
      <div class="empty"><div class="empty-icon">○</div>
      <strong>没有符合条件的记录</strong>调整筛选条件，或点击右上角「新增请假」录入。</div>
    </td></tr>`;
  } else {
    $('tbody').innerHTML = pageRows.map(r => {
      const st = L.computeStatus(r, now);
      const running = L.isRunning(r);
      const sev = L.severity(r, now, state.settings);
      const acts = [];
      if (st === 'pending' || st === 'active') {
        acts.push(`<button class="link-btn" data-act="check" data-id="${esc(r.id)}">销假</button>`);
        acts.push(`<button class="link-btn" data-act="edit" data-id="${esc(r.id)}">编辑</button>`);
        acts.push(`<button class="link-btn danger" data-act="delete" data-id="${esc(r.id)}">删除</button>`);
      } else if (st === 'checked') {
        acts.push(`<button class="link-btn" data-act="uncheck" data-id="${esc(r.id)}">撤销销假</button>`);
        acts.push(`<button class="link-btn muted" data-act="edit" data-id="${esc(r.id)}">编辑</button>`);
        acts.push(`<button class="link-btn danger" data-act="delete" data-id="${esc(r.id)}">删除</button>`);
      } else {
        acts.push(`<button class="link-btn" data-act="restore" data-id="${esc(r.id)}">恢复</button>`);
        acts.push(`<button class="link-btn danger" data-act="delete" data-id="${esc(r.id)}">删除</button>`);
      }

      let statusTag;
      if (running) {
        const el = L.elapsedDays(r, now);
        statusTag = sev
          ? `<span class="tag amber">未销假·已请 ${el} 天</span>`
          : `<span class="tag blue">请假中·未定</span>`;
      } else if (st === 'pending') {
        const over = L.overdueDays(r, now);
        statusTag = `<span class="tag amber">${over > 0 ? '待销假·超' + over + '天' : '今日到期'}</span>`;
      } else {
        statusTag = `<span class="tag ${STATUS_TAG[st]}">${STATUS_TEXT[st]}</span>`;
      }

      const days = L.effectiveDays(r, now);
      const daysCell = L.fmtDays(days) + (running ? '<span class="mini">累计</span>' : '');

      return `<tr class="${st === 'revoked' ? 'revoked' : ''}">
        <td class="name"><button class="name-link" data-teacher="${teacherKeyOf(r)}" title="查看该教师全部请假记录">${esc(r.name)}</button>${r.phone ? `<div class="sub-line">${esc(r.phone)}</div>` : ''}</td>
        <td class="school" title="${esc(r.school || '未填学校')}">${r.school ? esc(r.school) : '<span class="tag red" title="这条记录没有学校，点右侧「编辑」补上">未填</span>'}</td>
        <td>${esc(L.subjectOf(r) || '—')}</td>
        <td>${esc(L.gradeOf(r) || '—')}</td>
        <td><span class="tag">${esc(r.type || '—')}</span></td>
        <td class="range-cell">${rangeHTML(r)}${r.reason ? `<div class="sub-line">${esc(r.reason)}</div>` : ''}</td>
        <td class="num">${daysCell}</td>
        <td>${r.substitute ? '<span class="tag green">已安排</span>' : '<span class="tag gray">未安排</span>'}</td>
        <td>${statusTag}</td>
        <td class="actions">${acts.join('')}</td>
      </tr>`;
    }).join('');
  }

  $('pageInfo').textContent = total
    ? `第 ${start + 1}–${Math.min(start + state.pageSize, total)} 条 / 共 ${total} 条　第 ${state.page} / ${maxPage} 页`
    : '第 0 条 / 共 0 条';

  $('btnPrev').disabled = state.page <= 1;
  $('btnNext').disabled = state.page >= maxPage;

  document.querySelectorAll('#tbody [data-act]').forEach(btn => {
    btn.addEventListener('click', () => handleRowAction(btn.dataset.act, btn.dataset.id));
  });
}

/* ---------------- 教师档案 ---------------- */

// 同一位教师 = 姓名 + 学校。key 编码后放进 data 属性，
// 避免中文和分隔符在 HTML 属性里出问题。
function teacherKeyOf(r) {
  return encodeURIComponent((r.school || '') + '|' + (r.name || '').trim());
}

function teacherKeyParts(key) {
  let raw = '';
  try { raw = decodeURIComponent(key); } catch (e) { raw = ''; }
  const i = raw.indexOf('|');
  return i < 0 ? { school: '', name: raw } : { school: raw.slice(0, i), name: raw.slice(i + 1) };
}

function numText(n) {
  const v = Math.round(Number(n) * 10) / 10;
  return v % 1 === 0 ? String(v) : v.toFixed(1);
}

// 记录与 [from, to] 有没有交集 —— 跨月/跨年的长假如按开始日算会被漏掉
function inDateRange(r, from, to, now) {
  if (!from && !to) return true;
  const s = r.startDate || '';
  if (!s) return false;
  const e = L.effectiveEndDate(r, now) || s;
  if (from && e < from) return false;
  if (to && s > to) return false;
  return true;
}

function teacherRange(now) {
  const f = state.teachers;
  let from = f.from, to = f.to;
  if (f.range === 'term') { const t = L.termRange(now); from = t.start; to = t.end; }
  else if (f.range === 'year') { const y = now.getFullYear(); from = y + '-01-01'; to = y + '-12-31'; }
  else if (f.range === 'month') { const m = L.monthRange(now); from = m.start; to = m.end; }
  return { from, to };
}

function buildTeachers(now) {
  const f = state.teachers;
  const { from, to } = teacherRange(now);
  const q = (f.q || '').toLowerCase();

  // 先按姓名+学校聚人；学校/学科/姓名在这里就筛掉，
  // 状态标签则用"全部记录"判断，不受统计范围影响
  const groups = new Map();
  state.records.forEach(r => {
    if (r.revokedAt) return;
    const name = (r.name || '').trim();
    if (!name) return;
    if (f.school && (r.school || '') !== f.school) return;
    if (f.subject && L.subjectOf(r) !== f.subject) return;
    if (q && !name.toLowerCase().includes(q)) return;
    const key = teacherKeyOf(r);
    if (!groups.has(key)) groups.set(key, { key, name, school: r.school || '', records: [] });
    groups.get(key).records.push(r);
  });

  const list = [];
  groups.forEach(g => {
    const scoped = g.records.filter(r => inDateRange(r, from, to, now));
    if (!scoped.length) return;

    const sorted = scoped.slice().sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
    const latest = sorted[0];

    list.push({
      key: g.key,
      name: g.name,
      school: g.school,
      subject: L.subjectLabel(latest),
      count: scoped.length,
      days: scoped.reduce((s, r) => s + L.effectiveDays(r, now), 0),
      latest,
      hasActive: g.records.some(r => L.computeStatus(r, now) === 'active'),
      hasPending: g.records.some(r => L.computeStatus(r, now) === 'pending'),
      records: sorted
    });
  });

  const by = f.sort || 'days';
  list.sort((a, b) => {
    if (by === 'count') return b.count - a.count || b.days - a.days || a.name.localeCompare(b.name, 'zh');
    if (by === 'last') return String(b.latest.startDate || '').localeCompare(String(a.latest.startDate || '')) || a.name.localeCompare(b.name, 'zh');
    if (by === 'name') return a.name.localeCompare(b.name, 'zh') || a.school.localeCompare(b.school, 'zh');
    return b.days - a.days || b.count - a.count || a.name.localeCompare(b.name, 'zh');
  });

  // 状态筛选筛的是"人"，放在最后
  return list.filter(t => {
    if (f.state === 'active') return t.hasActive;
    if (f.state === 'pending') return t.hasPending;
    if (f.state === 'idle') return !t.hasActive && !t.hasPending;
    return true;
  });
}

function renderTeachers() {
  const now = new Date();
  const hasDetail = !!(state.teacherKey && state.records.some(r => teacherKeyOf(r) === state.teacherKey));
  if (state.teacherKey && !hasDetail) state.teacherKey = null;

  $('tOverview').hidden = hasDetail;
  $('tDetail').hidden = !hasDetail;
  if (hasDetail) { renderTeacherDetail(now); return; }

  const list = buildTeachers(now);
  const totalCount = list.reduce((s, t) => s + t.count, 0);
  const totalDays = list.reduce((s, t) => s + t.days, 0);
  const { from, to } = teacherRange(now);

  let scopeText = '';
  if (from || to) scopeText = `<span class="sep">|</span>范围 ${esc(from || '—')} ~ ${esc(to || '—')}`;

  $('tSummary').innerHTML = list.length
    ? `共 <b>${list.length}</b> 位教师<span class="sep">|</span><b>${totalCount}</b> 条请假<span class="sep">|</span>合计 <b>${numText(totalDays)}</b> 天${scopeText}`
    : '共 0 位教师';

  if (!list.length) {
    $('tList').innerHTML = `<div class="empty">
      <div class="empty-icon">○</div>
      <strong>没有符合条件的教师</strong>
      调整筛选条件，或先在「数据总览」里录入请假记录。
    </div>`;
    return;
  }

  $('tList').innerHTML = '<div class="kgrid">' + list.map(t => {
    const tags = [];
    if (t.hasActive) tags.push('<span class="tag blue">正在请假</span>');
    if (t.hasPending) tags.push('<span class="tag amber">待销假</span>');
    if (!t.hasActive && !t.hasPending) tags.push('<span class="tag gray">已销假</span>');
    const sub = [t.school || '未填学校', t.subject].filter(Boolean).join(' · ');
    return `<div class="kcard${t.hasActive ? ' is-active' : ''}" data-teacher="${t.key}">
      <div class="kcard-top">
        <span class="kcard-name">${esc(t.name)}</span>
        <span class="kcard-days">${numText(t.days)}<em>天</em></span>
      </div>
      <div class="kcard-sub" title="${esc(sub)}">${esc(sub)}</div>
      <div class="kcard-foot">
        <span>${t.count} 次</span>
        <span class="kcard-last">最近 ${esc(dayLabel(t.latest.startDate))}</span>
      </div>
      <div class="kcard-tags">${tags.join('')}</div>
    </div>`;
  }).join('') + '</div>';
}

// 明细表当前筛选条件下的记录：渲染和翻页计数共用同一套条件，避免两处不一致
function filterTeacherRecs(recs, now) {
  const fr = state.teacherRec;
  return recs.filter(r => {
    if (fr.year && (r.startDate || '').slice(0, 4) !== fr.year) return false;
    if (fr.type && (r.type || '').trim() !== fr.type) return false;
    if (fr.state && L.computeStatus(r, now) !== fr.state) return false;
    return true;
  });
}

function currentTeacherRecs() {
  return state.records
    .filter(r => teacherKeyOf(r) === state.teacherKey)
    .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
}

function countTeacherRecs() {
  return filterTeacherRecs(currentTeacherRecs(), new Date()).length;
}

// 从教师详情页点「新增请假」：把这位教师的学校/姓名/学科/年级/电话预先填好，
// 用户只需要选请假类型和日期
function openFormForTeacher(key) {
  const parts = teacherKeyParts(key);
  const recs = state.records
    .filter(r => teacherKeyOf(r) === key)
    .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
  const sample = recs.find(r => !r.revokedAt) || recs[0] || {};
  openForm(null, {
    school: parts.school || sample.school || '',
    name: parts.name || sample.name || '',
    subject: L.subjectOf(sample) || '',
    grade: L.gradeOf(sample) || '',
    phone: sample.phone || ''
  });
}

function renderTeacherDetail(now) {
  const key = state.teacherKey;
  const recs = state.records
    .filter(r => teacherKeyOf(r) === key)
    .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));

  if (!recs.length) { state.teacherKey = null; return renderTeachers(); }

  const parts = teacherKeyParts(key);
  const fr = state.teacherRec;

  // 年份 / 类型下拉的可选项来自这位教师的全部记录（不受当前筛选影响）
  const recYears = Array.from(new Set(recs.map(r => (r.startDate || '').slice(0, 4)).filter(Boolean)))
    .sort().reverse();
  const recTypes = Array.from(new Set(recs.map(r => (r.type || '').trim()).filter(Boolean)));
  if (fr.year && !recYears.includes(fr.year)) fr.year = '';
  if (fr.type && !recTypes.includes(fr.type)) fr.type = '';

  const filtered = filterTeacherRecs(recs, now);
  const isFiltered = !!(fr.year || fr.type || fr.state);

  // 统计口径：选了筛选条件就按筛选结果算，否则按全部记录。
  // 已撤销的记录不计入次数和天数（与数据总览一致）。
  const statsRecs = (isFiltered ? filtered : recs).filter(r => !r.revokedAt);
  // 顶部「正在请假 / 待销假」标签始终看全部记录：
  // 否则选了「2025 年」之后，现在还在请假的教师会被标成"已全部销假"
  const allAlive = recs.filter(r => !r.revokedAt);

  const sample = allAlive[0] || recs[0];
  const count = statsRecs.length;
  const totalDays = statsRecs.reduce((s, r) => s + L.effectiveDays(r, now), 0);
  const avg = count ? totalDays / count : 0;
  const hasActive = allAlive.some(r => L.computeStatus(r, now) === 'active');
  const hasPending = allAlive.some(r => L.computeStatus(r, now) === 'pending');
  const latest = statsRecs[0];

  const tags = [];
  if (hasActive) tags.push('<span class="tag blue">正在请假</span>');
  if (hasPending) tags.push('<span class="tag amber">待销假</span>');
  if (!hasActive && !hasPending && allAlive.length) tags.push('<span class="tag green">已全部销假</span>');

  // 类型分布：按累计天数，堆叠条 + 图例
  const byType = {};
  statsRecs.forEach(r => {
    const t = (r.type || '').trim() || '未填类型';
    byType[t] = (byType[t] || 0) + L.effectiveDays(r, now);
  });
  const types = Object.keys(byType).map(t => ({ type: t, days: byType[t] })).sort((a, b) => b.days - a.days);
  const barTotal = types.reduce((s, x) => s + x.days, 0) || 1;
  const COLORS = ['#2563EB', '#0EA5E9', '#8B5CF6', '#F59E0B', '#10B981', '#EF4444', '#64748B'];

  const barHTML = types.length
    ? `<div class="dbar">${types.map((x, i) => `<i style="width:${(x.days / barTotal * 100).toFixed(2)}%;background:${COLORS[i % COLORS.length]}"></i>`).join('')}</div>
       <div class="dlegend">${types.map((x, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(x.type)} <b>${numText(x.days)}</b> 天 · ${statsRecs.filter(r => ((r.type || '').trim() || '未填类型') === x.type).length} 次</span>`).join('')}</div>`
    : '<div class="empty" style="padding:12px 0">暂无记录</div>';

  // 按年份统计
  const byYear = {};
  statsRecs.forEach(r => {
    const y = (r.startDate || '').slice(0, 4) || '未知';
    if (!byYear[y]) byYear[y] = { y, count: 0, days: 0 };
    byYear[y].count++;
    byYear[y].days += L.effectiveDays(r, now);
  });
  const years = Object.keys(byYear).map(k => byYear[k]).sort((a, b) => String(b.y).localeCompare(String(a.y)));
  const yearHTML = years.length
    ? years.map(x => `<span class="dyear"><b>${esc(x.y)}</b> 年 · ${x.count} 次 · ${numText(x.days)} 天</span>`).join('')
    : '';

  const info = [
    parts.school || '未填学校',
    L.subjectLabel(sample),
    sample.phone || ''
  ].filter(Boolean).join(' · ');

  const revokedCount = recs.length - allAlive.length;

  // ---- 明细表：分页（筛选已在上面算过，统计与表格共用同一份 filtered）----
  const pageSize = fr.pageSize;
  const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (fr.page > maxPage) fr.page = maxPage;
  const pStart = (fr.page - 1) * pageSize;
  const pageRows = filtered.slice(pStart, pStart + pageSize);

  const rowHTML = pageRows.map(r => {
    const st = L.computeStatus(r, now);
    const running = L.isRunning(r);
    let statusTag;
    if (st === 'revoked') {
      statusTag = '<span class="tag gray">已撤销</span>';
    } else if (running) {
      statusTag = '<span class="tag amber">请假中·未定</span>';
    } else if (st === 'pending') {
      const over = L.overdueDays(r, now);
      statusTag = `<span class="tag amber">${over > 0 ? '待销假·超' + over + '天' : '今日到期'}</span>`;
    } else {
      statusTag = `<span class="tag ${STATUS_TAG[st]}">${STATUS_TEXT[st]}</span>`;
    }

    const acts = [];
    if (st === 'active' || st === 'pending') {
      acts.push(`<button class="link-btn" data-dact="check" data-did="${esc(r.id)}">销假</button>`);
      acts.push(`<button class="link-btn" data-dact="edit" data-did="${esc(r.id)}">编辑</button>`);
      acts.push(`<button class="link-btn danger" data-dact="delete" data-did="${esc(r.id)}">删除</button>`);
    } else if (st === 'checked') {
      acts.push(`<button class="link-btn" data-dact="uncheck" data-did="${esc(r.id)}">撤销销假</button>`);
      acts.push(`<button class="link-btn muted" data-dact="edit" data-did="${esc(r.id)}">编辑</button>`);
      acts.push(`<button class="link-btn danger" data-dact="delete" data-did="${esc(r.id)}">删除</button>`);
    } else {
      acts.push(`<button class="link-btn" data-dact="restore" data-did="${esc(r.id)}">恢复</button>`);
      acts.push(`<button class="link-btn danger" data-dact="delete" data-did="${esc(r.id)}">删除</button>`);
    }

    return `<tr class="${st === 'revoked' ? 'revoked' : ''}">
      <td class="range-cell">${rangeHTML(r)}</td>
      <td><span class="tag">${esc(r.type || '—')}</span></td>
      <td>${esc(L.subjectLabel(r) || '—')}</td>
      <td class="num">${L.fmtDays(L.effectiveDays(r, now))}${running ? '<span class="mini">累计</span>' : ''}</td>
      <td>${statusTag}</td>
      <td class="actions">${acts.join('')}</td>
    </tr>`;
  }).join('');

  let recSummary = `请假明细 <b>${recs.length}</b> 条`;
  if (revokedCount) recSummary += `<span class="sep">|</span>其中 <b>${revokedCount}</b> 条已撤销（不计入统计）`;
  if (isFiltered) recSummary += `<span class="sep">|</span>筛出 <b>${filtered.length}</b> 条`;
  const yearOpts = recYears.map(y =>
    `<option value="${esc(y)}"${fr.year === y ? ' selected' : ''}>${esc(y)} 年</option>`).join('');
  const typeOpts = recTypes.map(t =>
    `<option value="${esc(t)}"${fr.type === t ? ' selected' : ''}>${esc(t)}</option>`).join('');
  const stateOpts = [
    ['active', '请假中'], ['pending', '待销假'], ['checked', '已销假'], ['revoked', '已撤销']
  ].map(([v, label]) =>
    `<option value="${v}"${fr.state === v ? ' selected' : ''}>${label}</option>`).join('');

  $('tDetail').innerHTML = `
    <div class="back-bar">
      <button class="btn btn-ghost" id="tBack">← 返回教师列表</button>
      <div class="back-actions">
        <button class="btn btn-ghost" data-tadd="${esc(key)}">＋ 为这位教师新增请假</button>
        <button class="btn btn-ghost danger" data-tdel="${esc(key)}" title="删除这位教师及其全部请假记录">删除这位教师</button>
      </div>
    </div>

    <div class="panel">
      <div class="dhead">
        <div class="dhead-avatar">${esc((parts.name || '?').slice(0, 1))}</div>
        <div class="dhead-main">
          <h2>${esc(parts.name || '未填姓名')}</h2>
          <p>${esc(info)}</p>
        </div>
        <div class="dhead-state">${tags.join('')}</div>
      </div>

      ${isFiltered ? `<div class="dscope">
        <span>下方统计按当前筛选计算：<b>${filtered.length}</b> 条记录${statsRecs.length !== filtered.length ? `（其中 ${filtered.length - statsRecs.length} 条已撤销不计入）` : ''}</span>
        <button class="link-btn" data-tfreset="1">改为按全部记录统计</button>
      </div>` : ''}

      <div class="dst">
        <div class="dstat"><span>${isFiltered ? '筛选内请假' : '累计请假'}</span><b>${count}<em>次</em></b></div>
        <div class="dstat"><span>${isFiltered ? '筛选内天数' : '累计天数'}</span><b>${numText(totalDays)}<em>天</em></b></div>
        <div class="dstat"><span>平均每次</span><b>${count ? numText(avg) : '—'}<em>${count ? '天' : ''}</em></b></div>
        <div class="dstat"><span>${isFiltered ? '筛选内最近' : '最近一次'}</span><b>${latest ? esc(dayLabel(latest.startDate)) : '—'}</b></div>
      </div>

      <div class="dsec">
        <div class="dsec-title">请假类型分布（按天数）${isFiltered ? '<span class="dsec-flag">当前筛选</span>' : ''}</div>
        ${barHTML}
      </div>

      <div class="dsec">
        <div class="dsec-title">按年份统计${isFiltered ? '<span class="dsec-flag">当前筛选</span>' : ''}</div>
        <div class="dyears">${yearHTML || '<span class="note-inline">暂无记录</span>'}</div>
      </div>
    </div>

    <div class="panel">
      <div class="list-bar">
        <div class="list-summary">${recSummary}</div>
        <div class="tfilter">
          <select data-tf="year" title="按年份筛选"><option value="">全部年份</option>${yearOpts}</select>
          <select data-tf="type" title="按类型筛选"><option value="">全部类型</option>${typeOpts}</select>
          <select data-tf="state" title="按状态筛选"><option value="">全部状态</option>${stateOpts}</select>
          ${isFiltered ? '<button class="btn btn-ghost btn-sm" data-tfreset="1">清除筛选</button>' : ''}
          <button class="btn btn-ghost btn-sm" data-texport="1" title="导出当前筛选出来的记录">导出 Excel</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table dtable">
          <thead>
            <tr>
              <th>请假区间</th>
              <th>类型</th>
              <th>学科</th>
              <th class="num">天数</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>${rowHTML || `<tr><td colspan="6">
            <div class="empty" style="padding:22px 0"><div class="empty-icon">○</div>
            <strong>没有符合条件的记录</strong>换一个年份、类型或状态试试。</div></td></tr>`}</tbody>
        </table>
      </div>
      <div class="pager">
        <div class="pager-info">${filtered.length
          ? `第 ${pStart + 1}–${Math.min(pStart + pageSize, filtered.length)} 条 / 共 ${filtered.length} 条　第 ${fr.page} / ${maxPage} 页`
          : '第 0 条 / 共 0 条'}</div>
        <div class="pager-btns">
          <select data-tpsize="1" title="每页条数">
            ${[10, 20, 50].map(n => `<option value="${n}"${pageSize === n ? ' selected' : ''}>每页 ${n} 条</option>`).join('')}
          </select>
          <button class="btn btn-ghost btn-sm" data-tp="prev"${fr.page <= 1 ? ' disabled' : ''}>上一页</button>
          <button class="btn btn-ghost btn-sm" data-tp="next"${fr.page >= maxPage ? ' disabled' : ''}>下一页</button>
        </div>
      </div>
    </div>`;
}

// 删除一位教师：连同他（姓名 + 学校）名下的全部请假记录一起删掉。
// 破坏性操作，弹窗里逐条列出会删什么，并说明可以先去备份里找回。
async function deleteTeacher(key) {
  const parts = teacherKeyParts(key);
  const recs = state.records
    .filter(r => teacherKeyOf(r) === key)
    .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
  if (!recs.length) { toast('这位教师已经没有请假记录了', 'err'); return; }

  const aliveCount = recs.filter(r => !r.revokedAt).length;
  const revokedCount = recs.length - aliveCount;
  const lines = recs.slice(0, 6)
    .map(r => `· ${L.rangeLabel(r)}（${r.type || '未填类型'}）`)
    .join('\n');
  const more = recs.length > 6 ? `\n· 另有 ${recs.length - 6} 条…` : '';

  const text = `即将删除「${parts.name || '未填姓名'}」（${parts.school || '未填学校'}），`
    + `以及这位教师名下全部 ${recs.length} 条请假记录：\n\n${lines}${more}\n\n`
    + `其中 ${aliveCount} 条有效记录${revokedCount ? `、${revokedCount} 条已撤销记录` : ''}会一起清掉，`
    + `删除后不会出现在数据总览、提醒和统计里，也无法撤销。\n\n`
    + `程序会在删除前自动备份一份，万一删错，可到「设置 → 数据与备份」里恢复。`
    + `如果只是想删掉其中几条记录，可以点进这位教师的档案，在明细里逐条删除。`;

  const ok = await askConfirm('删除这位教师', text, '确认删除', { danger: true });
  if (!ok) return;

  const before = state.records.length;
  state.records = state.records.filter(r => teacherKeyOf(r) !== key);
  const removed = before - state.records.length;

  if (!(await persist())) {
    // 保存失败就把记录放回去，避免界面和数据文件不一致
    state.records = state.records.concat(recs);
    return;
  }

  state.teacherKey = null;
  toast(`已删除「${parts.name || '该教师'}」及 ${removed} 条记录`, 'ok');
  refreshAfterChange();
}

// 教师详情导出：只导出「当前筛选出来的」记录，表头带上这位教师的基本信息
async function exportTeacher() {
  const key = state.teacherKey;
  if (!key) return;
  const now = new Date();
  const parts = teacherKeyParts(key);
  const allRecs = currentTeacherRecs();
  const rows = filterTeacherRecs(allRecs, now);
  if (!rows.length) { toast('当前筛选下没有记录，无法导出', 'err'); return; }

  const statsRecs = rows.filter(r => !r.revokedAt);
  const count = statsRecs.length;
  const totalDays = statsRecs.reduce((s, r) => s + L.effectiveDays(r, now), 0);
  const sample = statsRecs[0] || allRecs[0] || {};
  const fr = state.teacherRec;
  const isFiltered = !!(fr.year || fr.type || fr.state);

  const teacher = {
    name: parts.name || '',
    school: parts.school || '',
    subject: L.subjectLabel(sample) || '',
    grade: L.gradeOf(sample) || '',
    phone: sample.phone || '',
    count,
    days: Math.round(totalDays * 10) / 10,
    avg: count ? Math.round(totalDays / count * 10) / 10 : 0,
    latest: statsRecs.length ? String(statsRecs[0].startDate || '') : '',
    hasActive: allRecs.some(r => L.computeStatus(r, now) === 'active'),
    hasPending: allRecs.some(r => L.computeStatus(r, now) === 'pending'),
    totalCount: allRecs.length,
    revokedCount: allRecs.length - allRecs.filter(r => !r.revokedAt).length,
    filteredCount: rows.length,
    isFiltered
  };

  const btn = document.querySelector('[data-texport]');
  if (btn) btn.disabled = true;
  try {
    const res = await window.api.exportExcel({
      records: rows,
      filterText: teacherFilterText(isFiltered),
      teacher
    });
    if (res.canceled) return;
    if (!res.ok) { toast(res.error || '导出失败', 'err'); return; }
    toast(`已导出 ${res.count} 条记录`, 'ok');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function teacherFilterText(isFiltered) {
  const fr = state.teacherRec;
  if (!isFiltered) return '全部请假记录';
  const parts = [];
  if (fr.year) parts.push(fr.year + ' 年');
  if (fr.type) parts.push('类型=' + fr.type);
  if (fr.state) parts.push('状态=' + (STATUS_TEXT[fr.state] || fr.state));
  return parts.join(' · ');
}

async function handleRowAction(act, id) {
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;

  if (act === 'check') return markChecked(id);
  if (act === 'uncheck') return markUnchecked(id);
  if (act === 'edit') return openForm(rec);

  if (act === 'restore') {
    delete rec.revokedAt;
    if (await persist()) { toast('已恢复', 'ok'); refreshAfterChange(); }
    return;
  }

  if (act === 'delete') return deleteRecord(id);
}

// 删除单条请假记录。数据总览和教师档案的明细表共用同一个确认框，
// 文案写清是谁、哪一段、多少天，删错时一眼能看出来。
async function deleteRecord(id, fromForm) {
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;

  const now = new Date();
  const who = rec.name + (rec.school ? '（' + rec.school + '）' : '');
  const text = `即将删除「${who}」的这条请假记录：\n\n`
    + `· ${L.rangeLabel(rec)}（${rec.type || '未填类型'}，共 ${L.fmtDays(L.effectiveDays(rec, now))}）\n\n`
    + '删除后这条记录不会再出现在数据总览、教师档案、提醒和统计里，也无法撤销。\n'
    + '程序会在删除前自动备份一份当前数据，万一删错，可到「设置 → 数据与备份」里恢复。';

  const ok = await askConfirm('删除记录', text, '确认删除', { danger: true });
  if (!ok) return;

  const snapshot = state.records;
  state.records = state.records.filter(r => r.id !== id);
  if (!(await persist())) {
    // 保存失败就把记录放回去，避免界面和数据文件不一致
    state.records = snapshot;
    refreshAfterChange();
    return;
  }

  if (fromForm) closeForm();
  toast(`已删除 ${rec.name} 的 1 条记录`, 'ok');
  refreshAfterChange();
}

async function markChecked(id) {
  // 防止连点：首页卡片销假成功后立刻重绘，后面的卡片会顶到刚才的位置，
  // 双击的第二下就会点到另一位教师身上（之前出现的"销了别人的假"就这么来的）
  if (state.checkBusy) return;
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;

  state.checkBusy = true;
  try {
    const now = new Date();
    const today = L.todayStr(now);
    const who = rec.name + (rec.school ? '（' + rec.school + '）' : '');

    if (L.isOpenEnded(rec)) {
      if (today < rec.startDate) { toast('该请假还未开始，不需要销假', 'err'); return; }
      const d = L.calcDays(rec.startDate, rec.startHalf, today, 'pm');
      const ok = await askConfirm(
        '销假确认',
        `${who} 的请假结束日期未定（${L.rangeLabel(rec)}）。\n` +
        `确认按今天（${today}）返校销假？实际请假 ${L.fmtDays(d)}。\n` +
        '若实际返校日期不是今天，请点「取消」，先编辑这条记录把日期改准确再销假。',
        '确认销假'
      );
      if (!ok) return;
      rec.endDate = today;
      rec.endHalf = 'pm';
      rec.days = d;
      rec.autoEnd = true;
      rec.checkedAt = now.toISOString();
      delete rec.revokedAt;
      if (await persist()) {
        toast(`${rec.name} 已销假，实际请假 ${L.fmtDays(d)}`, 'ok');
        refreshAfterChange();
      }
      return;
    }

    // 普通记录也确认一次，并在提示里写清是哪位老师、哪一段请假：
    // 名字相近（或同一人有多条记录）时，光看卡片很容易销错
    const ok = await askConfirm(
      '销假确认',
      `${who} 的 ${L.rangeLabel(rec)}（${rec.type || '未填类型'}，共 ${L.fmtDays(L.effectiveDays(rec, now))}）\n` +
      '确认标记为已销假？销假后这条记录会从「未销假提醒」里移除。\n' +
      '若日期不对，请点「取消」，先编辑这条记录改准确再销假。',
      '确认销假',
      { safe: true }
    );
    if (!ok) return;

    rec.checkedAt = now.toISOString();
    delete rec.revokedAt;
    if (await persist()) {
      toast(`${rec.name} 已销假`, 'ok');
      refreshAfterChange();
    }
  } finally {
    state.checkBusy = false;
  }
}

async function markUnchecked(id) {
  const rec = state.records.find(r => r.id === id);
  if (!rec) return;
  delete rec.checkedAt;
  if (rec.autoEnd) {
    delete rec.endDate;
    rec.endHalf = 'pm';
    delete rec.days;
    delete rec.autoEnd;
    rec.openEnded = true;
  }
  if (await persist()) {
    toast('已撤销销假', 'ok');
    refreshAfterChange();
  }
}

async function persist() {
  const res = await window.api.saveLeaves(state.records);
  if (!res.ok) {
    toast(res.error || '保存失败', 'err');
    return false;
  }
  // 主进程落盘后会把流水号计数器往前推，同步回本地快照
  if (res.noSeq) state.settings.noSeq = res.noSeq;
  return true;
}

function refreshAfterChange() {
  fillNameList();
  updateBadge();
  if (state.view === 'home') renderHome();
  if (state.view === 'list') renderList();
  if (state.view === 'teachers') renderTeachers();
  if (state.view === 'settings') renderSettings();
}

/* ---------------- form ---------------- */

// 输入姓名后带出学科/年级/电话，只在「同学校同名」时生效。
// 以前会自动把学校改成该姓名既有记录的学校，若同名者分属两校，
// 就会把 A 校的人记到 B 校去，这个副作用必须去掉。
function autofillFromName() {
  const name = val('fFormName').trim();
  if (!name) return;
  const school = val('fFormSchool');
  const prev = state.records.find(r => (r.name || '').trim() === name
    && (r.school || '') === school
    && !r.revokedAt);
  if (!prev) return;
  // 用户自己动过的字段不覆盖，其余按这位老师上一次的记录带出来。
  // 学科是必填项，新增时若留着"上次用的学科"很容易记错人，所以已知教师优先用他自己的。
  const touched = state.formTouched || {};
  if (!touched.subject && L.subjectOf(prev)) setSelectValue($('fFormSubject'), L.subjectOf(prev));
  if (!touched.grade && L.gradeOf(prev)) setSelectValue($('fFormGrade'), L.gradeOf(prev));
  if (!touched.phone && prev.phone) $('fFormPhone').value = prev.phone;
}

// 同校同名教师的既有记录（编辑时排除自己）
function dupRecords(name, school) {
  const key = (name || '').trim();
  if (!key) return [];
  const sc = school === undefined ? val('fFormSchool') : school;
  return state.records
    .filter(r => (r.name || '').trim() === key
      && (r.school || '') === sc
      && !r.revokedAt
      && !(state.editing && r.id === state.editing.id))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// 同名但不在当前学校的人 —— 只提示，不参与冲突判断
function sameNameOtherSchools(name) {
  const key = (name || '').trim();
  if (!key) return [];
  const sc = val('fFormSchool');
  return state.records.filter(r => (r.name || '').trim() === key
    && (r.school || '') !== sc
    && !r.revokedAt);
}

// 姓名输入框下方的即时提示，不拦截操作，只告知"这位老师已有记录"
function updateNameNote() {
  const note = $('nameDupNote');
  if (!note) return;
  const name = val('fFormName').trim();
  if (!name) {
    note.hidden = true;
    note.textContent = '';
    return;
  }

  const list = dupRecords(name);
  const others = sameNameOtherSchools(name);

  if (!list.length) {
    if (others.length) {
      const sc = Array.from(new Set(others.map(r => r.school).filter(Boolean)));
      note.hidden = false;
      note.className = 'field-note warn';
      note.textContent = `「${name}」在${sc.length ? '「' + sc.join('、') + '」' : '其他学校'}有记录，当前学校还没有。`
        + `姓名+学校视为同一位教师，确认没选错学校。`;
      return;
    }
    note.hidden = true;
    note.textContent = '';
    return;
  }

  const last = list[0];
  note.hidden = false;
  note.className = 'field-note warn';
  const prefix = state.editing ? '该教师另有' : '本校已有';
  note.textContent = `${prefix} ${list.length} 条记录 · 最近 ${shortDate(last.startDate)} ${last.type || ''}`.trim();
}

function syncOpenEnd() {
  const on = $('fFormOpenEnd').checked;
  $('fFormEnd').disabled = on;
  $('fFormEndHalf').disabled = on;
  document.querySelector('#modal .form-grid').classList.toggle('has-openend', on);
  syncCheckedBox();
  updateDaysPreview();
}

// 「结束日期未定」和「已销假」互斥：未知返校日就无从销假
function syncCheckedBox() {
  const openEnd = $('fFormOpenEnd').checked;
  const box = $('fFormChecked');
  if (openEnd) box.checked = false;
  box.disabled = openEnd;
  box.parentElement.classList.toggle('is-disabled', openEnd);
  box.parentElement.title = openEnd
    ? '结束日期未定时无法销假，取消勾选后才能销假'
    : '';
  updateCheckedNote();
}

function updateCheckedNote() {
  const note = $('checkedNote');
  if (!note) return;
  note.hidden = !$('fFormChecked').checked;
}

// preset 用于「在教师档案里给某位教师新增请假」，
// 传入 { school, name, subject, grade, phone } 即可预填，避免重新挑一遍人
async function openForm(rec, preset) {
  state.editing = rec || null;
  $('overlapWarn').hidden = true;
  $('btnSave').textContent = '保存';

  const today = L.todayStr(new Date());

  if (rec) {
    $('modalTitle').textContent = '编辑请假';
    $('modalNo').textContent = rec.no || '';
    $('btnFormDelete').hidden = false;
    setSelectValue($('fFormSchool'), rec.school || (state.settings.schools[0] || ''));
    $('fFormName').value = rec.name || '';
    setSelectValue($('fFormSubject'), L.subjectOf(rec));
    setSelectValue($('fFormGrade'), L.gradeOf(rec));
    $('fFormPhone').value = rec.phone || '';
    setSelectValue($('fFormType'), rec.type || (state.settings.leaveTypes[0] || ''));
    $('fFormStart').value = rec.startDate || today;
    $('fFormEnd').value = rec.endDate || today;
    $('fFormStartHalf').value = rec.startHalf || 'am';
    $('fFormEndHalf').value = rec.endHalf || 'pm';
    $('fFormOpenEnd').checked = L.isOpenEnded(rec);
    $('fFormReason').value = rec.reason || '';
    $('fFormRemark').value = rec.remark || '';
    $('fFormSub').checked = !!rec.substitute;
    $('fFormChecked').checked = !!rec.checkedAt;
  } else {
    // 顺序要求：先定学校，姓名下拉才能按学校过滤
    const p = preset || {};
    // 记不住上次的话，每天第一条都要重选一遍学校/学科/类型；
    // 但绝不能用"列表第一所"当默认值，那会把 A 校的人记到 B 校去
    const lu = state.settings.lastUsed || {};
    $('modalTitle').textContent = p.name ? '为「' + p.name + '」新增请假' : '新增请假';
    setSelectValue($('fFormSchool'), p.school || lu.school || state.settings.schools[0] || '');
    $('fFormName').value = p.name || '';
    setSelectValue($('fFormSubject'), p.subject || lu.subject || '');
    setSelectValue($('fFormGrade'), p.grade || lu.grade || '');
    $('fFormPhone').value = p.phone || '';
    setSelectValue($('fFormType'), p.type || lu.type || state.settings.leaveTypes[0] || '');
    $('fFormStart').value = today;
    $('fFormEnd').value = today;
    $('fFormStartHalf').value = 'am';
    $('fFormEndHalf').value = 'pm';
    $('fFormOpenEnd').checked = false;
    $('fFormReason').value = '';
    $('fFormRemark').value = '';
    $('fFormSub').checked = false;
    $('fFormChecked').checked = false;
    $('modalNo').textContent = '';
    $('btnFormDelete').hidden = true;
    try {
      const r = await window.api.nextNo(today);
      if (r.ok) $('modalNo').textContent = r.no;
    } catch (e) { /* ignore */ }
  }

  syncOpenEnd();
  syncSchoolState();
  fillFormNameList();
  updateNameNote();
  state.formPreset = preset && preset.name ? { ...preset } : null;
  // 记录用户手动改过哪些字段：自动带出信息时不覆盖用户的选择
  state.formTouched = { subject: false, grade: false, phone: false };
  state.formDirty = false;
  $('modal').hidden = false;
  setTimeout(() => {
    // 已带入教师信息时，光标落到开始日期，省一次 Tab
    const target = state.formPreset ? $('fFormStart') : $('fFormName');
    if (target) target.focus();
  }, 50);
}

// 没有任何学校可选时，直接锁住保存按钮并给出明确提示，
// 而不是让用户填完一整张表单才被告知"学校没选"
function syncSchoolState() {
  const list = state.settings.schools || [];
  const has = list.length > 0;
  $('schoolWarn').hidden = has;
  $('btnSave').disabled = !has;
  $('btnSave').title = has ? '' : '请先在设置里添加学校';
  if (!has) {
    $('schoolWarnText').textContent = '还没有可用的学校，这条记录无法保存。';
  }
}

// 关闭表单统一入口：填了内容却没保存时先问一句，
// 免得点遮罩、按 Esc 或手滑点叉就把整张表弄丢
async function requestCloseForm() {
  if ($('modal').hidden) return;
  if (state.formDirty) {
    const ok = await askConfirm(
      '还没保存，确定关闭？',
      '这条请假记录还没保存，关闭后填过的内容需要重新填一遍。',
      '放弃并关闭'
    );
    if (!ok) return;
  }
  closeForm();
}

function closeForm() {
  $('modal').hidden = true;
  state.editing = null;
  state.formPreset = null;
  state.formDirty = false;
  state.formTouched = { subject: false, grade: false, phone: false };
  $('btnFormDelete').hidden = true;
  $('fFormEnd').disabled = false;
  $('fFormEndHalf').disabled = false;
  $('nameDupNote').hidden = true;
  $('btnSave').disabled = false;
  $('fFormChecked').disabled = false;
  $('fFormChecked').parentElement.classList.remove('is-disabled');
  $('checkedNote').hidden = true;
}

function updateDaysPreview() {
  const s = val('fFormStart');
  const openEnd = $('fFormOpenEnd').checked;
  const sh = val('fFormStartHalf');
  const bar = document.querySelector('.calc-bar');
  const today = L.todayStr(new Date());

  function invalid(text) {
    $('daysPreview').textContent = '—';
    $('calcNote').textContent = text;
    bar.classList.add('invalid');
  }

  if (!s) { invalid('请选择开始日期'); return; }

  if (openEnd) {
    const days = L.calcDays(s, sh, today, 'pm');
    if (days <= 0) {
      bar.classList.remove('invalid');
      $('daysPreview').textContent = '0 天';
      $('calcNote').textContent = '开始日期在未来，到那天起才开始累计';
      return;
    }
    bar.classList.remove('invalid');
    $('daysPreview').textContent = L.fmtDays(days);
    $('calcNote').textContent = `结束日期未定，按今天（${today}）累计；销假时以实际返校日结算`;
    return;
  }

  const e = val('fFormEnd');
  const eh = val('fFormEndHalf');
  if (!e) { invalid('请选择结束日期，或勾选「结束日期未定」'); return; }
  if (e < s) { invalid('结束日期不能早于开始日期'); return; }

  const days = L.calcDays(s, sh, e, eh);
  if (days <= 0) { invalid('该时段组合不足半天，请检查'); return; }

  bar.classList.remove('invalid');
  $('daysPreview').textContent = L.fmtDays(days);
  const span = Math.round((L.toUTC(e) - L.toUTC(s)) / 86400000) + 1;
  $('calcNote').textContent = `按自然日计算，含周末（共 ${span} 个日历日）`;
}

async function saveForm() {
  const school = val('fFormSchool');
  const name = val('fFormName').trim();
  const subject = val('fFormSubject');
  const grade = val('fFormGrade');
  const type = val('fFormType');
  const startDate = val('fFormStart');
  const startHalf = val('fFormStartHalf');
  const openEnded = $('fFormOpenEnd').checked;
  const endDate = openEnded ? '' : val('fFormEnd');
  const endHalf = openEnded ? 'pm' : val('fFormEndHalf');
  const checkedNow = $('fFormChecked').checked;
  const today = L.todayStr(new Date());

  if (!school) {
    toast('请选择学校；若下拉框里没有学校，先到「设置 → 学校」添加', 'err');
    markInvalid('fFormSchool');
    $('fFormSchool').focus();
    return;
  }
  if (!name) { toast('请填写教师姓名', 'err'); markInvalid('fFormName'); $('fFormName').focus(); return; }
  if (!subject) { toast('请选择学科，可在设置里添加', 'err'); markInvalid('fFormSubject'); $('fFormSubject').focus(); return; }
  if (!type) { toast('请选择请假类型', 'err'); markInvalid('fFormType'); return; }
  if (!startDate) { toast('请选择开始日期', 'err'); markInvalid('fFormStart'); return; }
  if (!openEnded && !endDate) { toast('请选择结束日期，或勾选「结束日期未定」', 'err'); markInvalid('fFormEnd'); return; }
  if (!openEnded && endDate < startDate) { toast('结束日期不能早于开始日期', 'err'); markInvalid('fFormEnd'); return; }

  const days = openEnded
    ? Math.max(0, L.calcDays(startDate, startHalf, today < startDate ? startDate : today, 'pm'))
    : L.calcDays(startDate, startHalf, endDate, endHalf);

  if (!openEnded && days <= 0) { toast('请假时长不足半天，请检查时段', 'err'); return; }

  // ---- 时段冲突：硬性拦截，不允许保存 ----
  // 唯一键是「姓名 + 学校」，所以只和本校同名教师的记录比。
  // 半天粒度下「上午」与「下午」不算重叠，同一天分段登记仍然可以
  // ——前提是把 startHalf/endHalf 一起传进去，否则会被当成"全天"误判。
  const candidate = {
    id: state.editing ? state.editing.id : null,
    school, name, startDate, startHalf, endDate, endHalf, openEnded
  };

  // 编辑已有记录时，这条记录原本就可能与别的记录重叠（旧版本录入、
  // 或当天分段后改了日期）。那种"历史上就存在的重叠"不算新冲突，
  // 否则用户连改个备注都保存不了。只拦"这次改动新撞上的"。
  let beforeIds = [];
  if (state.editing) {
    const prev = state.editing;
    beforeIds = L.findOverlaps(state.records, {
      id: prev.id,
      school: prev.school || '',
      name: prev.name || '',
      startDate: prev.startDate,
      startHalf: prev.startHalf,
      endDate: prev.endDate,
      endHalf: prev.endHalf,
      openEnded: L.isOpenEnded(prev)
    }).map(r => r.id);
  }

  const overs = L.findOverlaps(state.records, candidate);
  const blockers = overs.filter(r => !beforeIds.includes(r.id));

  if (blockers.length) {
    const list = blockers
      .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
      .map(o => `<b>${esc(L.rangeLabel(o))}</b>（${esc(o.type || '未填类型')}，${L.fmtDays(L.effectiveDays(o, new Date()))}，流水号 ${esc(o.no || '—')}）`)
      .join('；');
    // 结束日期未定的记录会一直占用时间，是最容易被误认为"系统坏了"的情况，
    // 单独点出来告诉用户先销假或补结束日期
    const openBlocker = blockers.find(o => L.isOpenEnded(o) && !o.checkedAt);
    const openTip = openBlocker
      ? `<br><b>其中 ${esc(L.rangeLabel(openBlocker))} 这条还没销假</b>——未定结束日期的请假会一直占着时间。`
        + `请先点它的「销假」（或编辑补上实际结束日期），再录这次请假。`
      : '';
    $('overlapWarn').hidden = false;
    $('overlapWarn').innerHTML = `<b>无法保存：请假时段与已有记录重叠。</b><br>`
      + `「${esc(name)}」在${esc(school || '本校')}此时段已有：${list}。`
      + openTip
      + `<br>同一位教师的请假时段不能交叉；同一天拆成「上午」「下午」两条分别登记是可以的。`
      + `若之前那条录错了，请先到「数据总览」或该教师档案里编辑或删除它。`;
    const mbody = document.querySelector('#modal .modal-body');
    if (mbody) mbody.scrollTop = 0;
    toast('时段冲突，记录未保存', 'err');
    return;
  }

  // 同名教师提醒：无时段冲突、但本校已有这位老师的记录时，确认一次不是重复录入
  if (!state.editing) {
    const dups = dupRecords(name, school);
    if (dups.length) {
      const lines = dups.slice(0, 4).map(r => `· ${L.rangeLabel(r)}（${r.type || '未填类型'}）`).join('\n');
      const more = dups.length > 4 ? `\n· 另有 ${dups.length - 4} 条…` : '';
      const text = `本校已有「${name}」的 ${dups.length} 条请假记录：\n${lines}${more}\n\n`
        + '本次时段与它们不冲突。若是这位老师的新一次请假，点「继续保存」；若是姓名输错，请点「取消」返回检查。';

      const go = await askConfirm('该教师已有记录', text, '继续保存', { safe: true });
      if (!go) { $('fFormName').focus(); return; }
      if ($('modal').hidden) return;
    }
  }

  let no = state.editing ? state.editing.no : '';
  if (!no) {
    const r = await window.api.nextNo(startDate);
    no = r.ok ? r.no : 'QJ' + startDate.replace(/-/g, '') + '-000';
  }

  const now = new Date().toISOString();
  const payload = {
    id: state.editing ? state.editing.id : uid(),
    no,
    school,
    name,
    subject,
    grade,
    phone: val('fFormPhone').trim(),
    type,
    startDate,
    startHalf,
    endDate,
    endHalf,
    openEnded,
    days,
    reason: val('fFormReason').trim(),
    substitute: $('fFormSub').checked,
    remark: val('fFormRemark').trim(),
    createdAt: state.editing ? state.editing.createdAt || now : now,
    updatedAt: now,
    // 勾了「已销假」才写销假时间；新增时用当前时间，编辑时保留原销假时间。
    // 原来填过、现在取消勾选 = 撤销销假，销假时间一并清掉。
    checkedAt: checkedNow ? ((state.editing && state.editing.checkedAt) || now) : null,
    revokedAt: state.editing ? state.editing.revokedAt || null : null
  };

  if (state.editing && state.editing.autoEnd && openEnded) payload.autoEnd = true;
  if (state.editing && !openEnded) delete payload.autoEnd;

  if (state.editing) {
    const idx = state.records.findIndex(r => r.id === state.editing.id);
    if (idx >= 0) state.records[idx] = payload;
  } else {
    state.records.unshift(payload);
  }

  const ok = await persist();
  if (!ok) {
    if (state.editing) {
      const idx = state.records.findIndex(r => r.id === state.editing.id);
      if (idx >= 0) state.records[idx] = state.editing;
    } else {
      state.records = state.records.filter(r => r.id !== payload.id);
    }
    return;
  }

  // 这条记录用的学校如果还没进「设置 → 学校」列表，自动补进去，
  // 否则这条记录的学校在标签列表、筛选里都看不到（旧数据常见）
  await ensureSchoolInSettings(school);

  // 记住这一条用的学校/学科/年级/类型，下次新增直接带出来
  rememberLastUsed({ school, subject, grade, type });

  toast(state.editing ? '已保存修改' : '已新增记录', 'ok');
  closeForm();
  refreshAfterChange();
}

// 新增表单的"上次用的选项"：写进设置文件，换电脑拷走也能带着
function rememberLastUsed(used) {
  try {
    state.settings.lastUsed = used;
    window.api.saveSettings(state.settings).then(res => {
      if (res && res.ok) state.settings = Object.assign(state.settings, res.settings);
    }).catch(() => { /* 记住默认值失败不影响主流程 */ });
  } catch (e) { /* ignore */ }
}

/* ---------------- export ---------------- */

function buildFilterText() {
  const parts = [];
  const school = val('fSchool');
  if (school) parts.push('学校=' + school);
  const name = val('fName').trim();
  if (name) parts.push('姓名含「' + name + '」');
  const subject = val('fFilterSubject');
  if (subject) parts.push('学科=' + subject);
  const type = val('fType');
  if (type) parts.push('类型=' + type);
  const st = val('fStatus');
  if (st) parts.push('状态=' + STATUS_TEXT[st]);
  const from = val('fFrom'), to = val('fTo');
  if (from || to) parts.push('开始日期 ' + (from || '不限') + ' 至 ' + (to || '不限'));
  const sub = val('fSub');
  if (sub === '1') parts.push('已安排代课');
  if (sub === '0') parts.push('未安排代课');
  return parts.length ? parts.join(' · ') : '全部记录';
}

async function doExport() {
  const rows = getFilteredSorted();
  if (!rows.length) { toast('当前筛选结果为空，无可导出内容', 'err'); return; }

  const btn = $('btnExport');
  btn.disabled = true;
  try {
    const res = await window.api.exportExcel({ records: rows, filterText: buildFilterText() });
    if (res.canceled) return;
    if (!res.ok) { toast(res.error || '导出失败', 'err'); return; }
    toast(`已导出 ${res.count} 条记录`, 'ok');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- settings ---------------- */

function renderSettings() {
  $('setWarn').value = state.settings.warnDays;
  $('setCritical').value = state.settings.criticalDays;
  $('setOpenWarn').value = state.settings.openWarnDays;
  $('setOpenCritical').value = state.settings.openCriticalDays;
  $('dataPath').textContent = (state.info && state.info.dataDir) || '';

  const keep = Number(state.settings.backupKeep) || 30;
  const keepSel = $('setBackupKeep');
  if (!Array.from(keepSel.options).some(o => Number(o.value) === keep)) {
    const o = document.createElement('option');
    o.value = String(keep);
    o.textContent = '保留最近 ' + keep + ' 份';
    keepSel.appendChild(o);
  }
  keepSel.value = String(keep);

  renderChips('schoolChips', 'schools');
  renderChips('typeChips', 'leaveTypes');
  renderChips('subjectChips', 'subjects');
  renderChips('gradeChips', 'grades');
  $('schoolCount').textContent = (state.settings.schools || []).length + ' 所';

  renderDataStats();
  renderBackups();
}

async function renderDataStats() {
  const box = $('dataStats');
  if (!box) return;
  let res;
  try { res = await window.api.stats(); } catch (e) { return; }
  if (!res || !res.ok) return;
  const size = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B';
  box.innerHTML = `
    <div class="ds"><span>请假记录</span><b>${res.recordCount} 条</b></div>
    <div class="ds"><span>数据文件</span><b>${size(res.leavesSize)}</b></div>
    <div class="ds"><span>备份文件</span><b>${res.backupCount} 份 · ${size(res.backupSize)}</b></div>`;
}

// 统计每个选项被多少条有效记录引用（已撤销的不算）
function usageOf(key) {
  const map = {};
  const bump = (k) => { if (k) map[k] = (map[k] || 0) + 1; };
  const pick = {
    schools: (r) => r.school,
    subjects: (r) => L.subjectOf(r),
    grades: (r) => L.gradeOf(r),
    leaveTypes: (r) => r.type
  }[key];
  if (!pick) return map;
  state.records.forEach(r => { if (!r.revokedAt) bump(pick(r)); });
  return map;
}

function renderChips(elId, key) {
  const items = state.settings[key] || [];
  const box = $(elId);
  if (!box) return;
  const use = usageOf(key);
  const html = items.map(t => {
    const n = use[t] || 0;
    const locked = key === 'schools' && n > 0;
    const count = n ? `<span class="chip-count" title="已有 ${n} 条请假记录使用">${n}</span>` : '';
    const del = locked
      ? `<button class="chip-del" disabled title="还有 ${n} 条请假记录在用，不能删除">×</button>`
      : `<button class="chip-del" data-chip-del="${esc(t)}" data-chip-key="${key}" title="删除">×</button>`;
    return `<span class="chip${locked ? ' is-used' : ''}">${esc(t)}${count}${del}</span>`;
  }).join('');

  // 学校：记录里出现过、但已经从列表删掉的学校，用虚线标签提示，可一键补回
  let ghosts = '';
  if (key === 'schools') {
    const set = new Set(items);
    ghosts = Object.keys(use).filter(t => !set.has(t)).map(t =>
      `<span class="chip is-orphan" title="有 ${use[t]} 条记录在用这个学校，但它不在上方列表中">${esc(t)}<span class="chip-count">${use[t]}</span><button class="chip-add" data-chip-add="${esc(t)}" title="点击补入列表">+</button></span>`
    ).join('');
  }

  box.innerHTML = html || ghosts || '<span class="hint">还没有内容</span>';
  if (html && ghosts) box.innerHTML = html + ghosts;
}

const CHIP_LABEL = { schools: '学校', leaveTypes: '类型', subjects: '学科', grades: '年级' };

async function removeSettingItem(key, label) {
  const list = state.settings[key] || [];
  if (!list.includes(label)) return;
  if (list.length <= 1) {
    toast('至少要保留一项' + CHIP_LABEL[key], 'err');
    return;
  }

  if (key === 'schools') {
    const n = usageOf('schools')[label] || 0;
    if (n > 0) {
      toast(`「${label}」还有 ${n} 条请假记录在用，不能删除。请先把这些记录的学校改到别的学校。`, 'err');
      return;
    }
  } else {
    const n = usageOf(key)[label] || 0;
    if (n > 0) {
      const ok = await askConfirm(
        '该' + CHIP_LABEL[key] + '仍在使用',
        `「${label}」还有 ${n} 条请假记录在用。\n删除后这些记录的${CHIP_LABEL[key]}文字不会改变，只是新增时的下拉框里不再出现该选项。确认删除？`,
        '确认删除'
      );
      if (!ok) return;
    }
  }

  state.settings[key] = list.filter(x => x !== label);
  await saveSettingsFromForm(true);
  toast(`已删除「${label}」`, 'ok');
}

async function addSettingItem(key, inputId, name) {
  const input = $(inputId);
  const v = (input.value || '').trim();
  // 空着点「添加」什么都不发生，用户会以为按钮坏了，这里给一句明确提示
  if (!v) {
    toast(`请先输入${name}名称，再点「添加」`, 'err');
    markInvalid(inputId);
    input.focus();
    return;
  }
  const arr = state.settings[key] || [];
  if (arr.includes(v)) { toast('该' + name + '已存在', 'err'); input.select(); return; }
  arr.push(v);
  state.settings[key] = arr;
  input.value = '';
  await saveSettingsFromForm(true);
  toast(`已添加「${v}」`, 'ok');
}

// 一键把"记录在用但列表里没有"的学校补进设置
async function addSettingItemSilent(key, value) {
  const v = String(value || '').trim();
  if (!v) return;
  const arr = state.settings[key] || [];
  if (arr.includes(v)) { toast('该' + CHIP_LABEL[key] + '已在列表中', 'err'); return; }
  arr.push(v);
  state.settings[key] = arr;
  await saveSettingsFromForm(true);
  toast('已补入「' + v + '」', 'ok');
}

async function ensureSchoolInSettings(school) {
  const name = String(school || '').trim();
  if (!name) return;
  const list = state.settings.schools || [];
  if (list.includes(name)) return;
  state.settings.schools = list.concat([name]);
  try {
    const rs = await window.api.saveSettings(state.settings);
    if (rs && rs.ok) state.settings = Object.assign(state.settings, rs.settings);
  } catch (e) { /* 写不进去也不影响这条记录本身 */ }
  buildSelects();
  renderSettings();
}

async function saveSettingsFromForm(silent) {
  const warn = Math.max(0, Number($('setWarn').value) || 0);
  const critical = Math.max(warn + 1, Number($('setCritical').value) || 1);
  const openWarn = Math.max(1, Number($('setOpenWarn').value) || 1);
  const openCritical = Math.max(openWarn + 1, Number($('setOpenCritical').value) || 2);
  const backupKeep = Math.max(1, Number($('setBackupKeep').value) || 30);

  state.settings.warnDays = warn;
  state.settings.criticalDays = critical;
  state.settings.openWarnDays = openWarn;
  state.settings.openCriticalDays = openCritical;
  state.settings.backupKeep = backupKeep;

  const res = await window.api.saveSettings(state.settings);
  if (!res.ok) { toast(res.error || '设置保存失败', 'err'); return; }

  state.settings = Object.assign(state.settings, res.settings);

  // 保留份数调小后立即生效，不用等到下一次备份
  try { await window.api.pruneBackups(); } catch (e) { /* ignore */ }

  buildSelects();
  renderSettings();
  // 增删标签这类操作自己有更具体的提示（「已添加 X」），不再叠一条「设置已保存」
  if (!silent) toast('设置已保存', 'ok');
  fillNameList();
  updateBadge();
  if (state.view === 'home') renderHome();
  if (state.view === 'list') renderList();
}

async function renderBackups() {
  const res = await window.api.listBackups();
  if (!res.ok) return;
  const items = res.items || [];
  const box = $('backupList');
  if (!items.length) {
    box.innerHTML = '<div class="empty" style="padding:18px">暂无备份</div>';
    return;
  }

  const manualCount = items.filter(b => b.tag === 'manual').length;

  box.innerHTML = `
    <div class="backup-head">
      <span>共 ${items.length} 份，最近的在前${manualCount ? `（手动备份 ${manualCount} 份，不参与自动清理）` : ''}</span>
      <span>每份都标了里面有多少条记录，挑对再恢复</span>
    </div>
    <div class="backup-scroll">${items.map(b => {
      const meta = backupTagOf(b.tag);
      const when = b.takenAt ? L.formatDateTime(new Date(b.takenAt)) : '未知时间';
      const detail = b.corrupt
        ? '文件无法读取，不能用来恢复'
        : `${b.records} 条记录 · ${b.teachers} 位教师` +
          (b.sample && b.sample.length
            ? '：' + b.sample.join('、') + (b.teachers > b.sample.length ? ' 等' : '')
            : '');
      return `<div class="backup-item${b.tag === 'manual' ? ' manual' : ''}">
        <span class="bleft">
          <span class="bt">${esc(when)}<span class="${meta[1]}">${esc(meta[0])}</span></span>
          <span class="bs">${esc(detail)}</span>
        </span>
        ${b.corrupt ? '<span class="bs">不可用</span>' : `<button class="link-btn" data-restore="${esc(b.name)}">恢复</button>`}
      </div>`;
    }).join('')}</div>`;

  document.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.restore;
      const item = items.find(b => b.name === name);
      const when = item && item.takenAt ? L.formatDateTime(new Date(item.takenAt)) : name;
      const tagText = item ? backupTagOf(item.tag)[0] : '备份';
      const detail = item && !item.corrupt
        ? `${item.records} 条记录、${item.teachers} 位教师` +
          (item.sample && item.sample.length
            ? `（${item.sample.join('、')}${item.teachers > item.sample.length ? ' 等' : ''}）`
            : '')
        : '';
      const text =
        '要用这份备份覆盖当前数据吗？\n\n' +
        `备份时间：${when}（${tagText}）\n` +
        (detail ? `备份内容：${detail}\n` : '') +
        `当前数据：${state.records.length} 条记录\n\n` +
        '恢复前会先把当前数据自动备份一份，恢复错了还能再恢复回来。';
      const ok = await askConfirm('恢复数据', text, '确认恢复');
      if (!ok) return;

      const rs = await window.api.restoreBackup(name);
      if (!rs.ok) { toast(rs.error || '恢复失败', 'err'); return; }

      state.records = (rs.records || []).map(normalize);
      state.page = 1;
      state.teacherKey = null;
      state.teacherRec.page = 1;
      if (!$('modal').hidden) closeForm();

      const teacherCount = new Set(state.records.map(r => (r.school || '') + '|' + (r.name || ''))).size;
      toast(`已恢复 ${state.records.length} 条记录（${teacherCount} 位教师）`, 'ok');
      // 设置页会顺带重绘备份列表（里面会多出一条「恢复前自动备份」）
      refreshAfterChange();
    });
  });
}

/* ---------------- start ---------------- */

window.addEventListener('error', (e) => {
  try {
    window.api.logError({
      message: e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''),
      stack: e.error && e.error.stack ? e.error.stack : ''
    });
  } catch (err) { /* ignore */ }
});

window.addEventListener('unhandledrejection', (e) => {
  try {
    const r = e.reason;
    window.api.logError({
      message: '未处理的异常：' + (r && r.message ? r.message : String(r)),
      stack: r && r.stack ? r.stack : ''
    });
  } catch (err) { /* ignore */ }
});

boot().catch(err => {
  console.error(err);
  toast('启动失败：' + err.message, 'err');
  try { window.api.logError({ message: '启动失败：' + err.message, stack: err.stack || '' }); } catch (e) { /* ignore */ }
});
