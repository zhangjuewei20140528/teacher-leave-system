'use strict';

const fs = require('fs');
const ExcelJS = require('../vendor/exceljs.min.js');
const logic = require('../common/logic');

const STATUS_TEXT = {
  active: '进行中',
  pending: '待销假',
  checked: '已销假',
  revoked: '已撤销'
};

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } };
const HEADER_FONT = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FF334155' } };
const BODY_FONT = { name: '微软雅黑', size: 10, color: { argb: 'FF1F2937' } };
const MUTED_FONT = { name: '微软雅黑', size: 10, color: { argb: 'FF94A3B8' } };
const THIN = { style: 'thin', color: { argb: 'FFD8DEE9' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

function dateCell(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function dtCell(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()));
}

function styleHeaderRow(row, colCount) {
  row.height = 22;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  }
}

// Excel 工作表名不能出现 \ / ? * [ ] :，且最长 31 个字符
function safeSheetName(name, fallback) {
  const s = String(name || '').replace(/[\\\/\?\*\[\]:]/g, '_').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 31) : fallback;
}

async function exportWorkbook(options) {
  const records = options.records || [];
  const filterText = options.filterText || '全部记录';
  const teacher = options.teacher || null;
  const now = new Date();

  const wb = new ExcelJS.Workbook();
  wb.creator = '教师请假管理系统';
  wb.created = now;

  const ws = wb.addWorksheet(safeSheetName(teacher ? teacher.name + ' 请假明细' : '请假明细', '请假明细'), {
    views: [{ state: 'frozen', ySplit: 5 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const widths = [6, 18, 12, 16, 10, 8, 13, 10, 12, 8, 12, 8, 9, 26, 9, 14, 16, 18, 16];
  ws.columns = widths.map(w => ({ width: w }));

  const totalDays = records.reduce((s, r) => s + logic.effectiveDays(r, now), 0);
  const runningCount = records.filter(r => logic.isRunning(r)).length;

  const titleRow = ws.addRow([
    teacher ? '教师请假明细表 · ' + (teacher.name || '未填姓名') + (teacher.school ? '（' + teacher.school + '）' : '') : '教师请假明细表'
  ]);
  titleRow.font = { name: '微软雅黑', size: 14, bold: true, color: { argb: 'FF1F2937' } };
  titleRow.height = 26;
  ws.mergeCells(1, 1, 1, widths.length);
  titleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };

  const infoStyle = { name: '微软雅黑', size: 9, color: { argb: 'FF64748B' } };
  const r2 = ws.addRow(['导出时间：' + logic.formatDateTime(now)]);
  r2.font = infoStyle;
  ws.mergeCells(2, 1, 2, widths.length);
  const r3 = ws.addRow(['筛选条件：' + filterText]);
  r3.font = infoStyle;
  ws.mergeCells(3, 1, 3, widths.length);

  let note = '记录条数：' + records.length + ' 条　　合计天数：' + logic.fmtDays(totalDays);
  if (runningCount) {
    note += '　　其中 ' + runningCount + ' 条结束日期未定，天数为导出当日累计值，销假后按实际返校日期结算';
  }
  if (teacher) {
    const bits = [];
    if (teacher.school) bits.push('学校：' + teacher.school);
    if (teacher.subject) bits.push('学科：' + teacher.subject);
    if (teacher.grade) bits.push('年级：' + teacher.grade);
    if (teacher.phone) bits.push('联系电话：' + teacher.phone);
    if (bits.length) note = bits.join('　　') + '　　' + note;
  }
  const r4 = ws.addRow([note]);
  r4.font = infoStyle;
  ws.mergeCells(4, 1, 4, widths.length);

  const headers = ['序号', '流水号', '教师姓名', '学校', '学科', '年级', '联系电话', '请假类型',
    '开始日期', '开始时段', '结束日期', '结束时段', '请假天数',
    '事由', '安排代课', '状态', '销假时间', '备注', '录入时间'];
  const headerRow = ws.addRow(headers);
  styleHeaderRow(headerRow, headers.length);

  const LEFT_COLS = [14, 18];

  records.forEach((r, i) => {
    const status = logic.computeStatus(r, now);
    const running = logic.isRunning(r);
    const statusText = running ? '请假中（结束未定）' : (STATUS_TEXT[status] || '待销假');

    const row = ws.addRow([
      i + 1,
      r.no || '',
      r.name || '',
      r.school || '',
      logic.subjectOf(r),
      logic.gradeOf(r),
      r.phone || '',
      r.type || '',
      dateCell(r.startDate),
      r.startHalf === 'am' ? '上午' : '下午',
      running ? '未定' : dateCell(r.endDate),
      running ? '—' : (r.endHalf === 'am' ? '上午' : '下午'),
      logic.effectiveDays(r, now),
      r.reason || '',
      r.substitute ? '是' : '否',
      statusText,
      r.checkedAt ? dtCell(r.checkedAt) : '',
      r.remark || '',
      dtCell(r.createdAt)
    ]);
    row.font = BODY_FONT;
    row.height = 20;
    for (let c = 1; c <= headers.length; c++) {
      const cell = row.getCell(c);
      cell.border = BORDER;
      cell.alignment = { vertical: 'middle', horizontal: LEFT_COLS.indexOf(c) >= 0 ? 'left' : 'center', wrapText: false };
    }
    row.getCell(9).numFmt = 'yyyy-mm-dd';
    if (!running) row.getCell(11).numFmt = 'yyyy-mm-dd';
    row.getCell(13).numFmt = '#,##0.0#';
    if (r.checkedAt) row.getCell(17).numFmt = 'yyyy-mm-dd hh:mm';
    row.getCell(19).numFmt = 'yyyy-mm-dd hh:mm';

    if (running) {
      row.getCell(11).font = MUTED_FONT;
      row.getCell(12).font = MUTED_FONT;
      row.getCell(13).font = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FF1D4ED8' } };
    }
    if (status === 'pending') {
      row.getCell(16).font = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FFB45309' } };
    } else if (status === 'revoked') {
      row.getCell(16).font = MUTED_FONT;
    } else if (status === 'checked') {
      row.getCell(16).font = { name: '微软雅黑', size: 10, color: { argb: 'FF047857' } };
    }
  });

  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: headers.length } };

  /* ---------------- 第二个工作表：单人导出给教师汇总，整体导出给全校汇总 ---------------- */

  if (teacher) {
    buildTeacherSheet(wb, teacher, records, filterText, now);
  } else {

  const sum = logic.summarize(records, now);
  const ws2 = wb.addWorksheet('汇总统计');
  const W2 = 5;
  ws2.columns = [{ width: 16 }, { width: 18 }, { width: 16 }, { width: 12 }, { width: 12 }];

  const t2 = ws2.addRow(['汇总统计']);
  t2.font = { name: '微软雅黑', size: 14, bold: true, color: { argb: 'FF1F2937' } };
  t2.height = 26;
  ws2.mergeCells(1, 1, 1, W2);

  const s0 = ws2.addRow(['统计范围：' + filterText]);
  s0.font = infoStyle;
  ws2.mergeCells(2, 1, 2, W2);

  let sText = '合计：' + sum.totalCount + ' 条记录，累计 ' + logic.fmtDays(sum.totalDays);
  if (sum.runningCount) sText += '（含 ' + sum.runningCount + ' 条结束日期未定，按导出当日累计）';
  const s1 = ws2.addRow([sText]);
  s1.font = infoStyle;
  ws2.mergeCells(3, 1, 3, W2);

  function section(title, headers2, rows) {
    const n = headers2.length;
    ws2.addRow([]);
    const tr = ws2.addRow([title]);
    tr.font = { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FF1F2937' } };
    ws2.mergeCells(tr.number, 1, tr.number, n);
    const hr = ws2.addRow(headers2);
    styleHeaderRow(hr, n);
    rows.forEach(vals => {
      const row = ws2.addRow(vals);
      row.font = BODY_FONT;
      for (let c = 1; c <= n; c++) {
        const cell = row.getCell(c);
        cell.border = BORDER;
        cell.alignment = { vertical: 'middle', horizontal: c === 1 || c === 3 ? 'left' : 'center' };
      }
      row.getCell(n - 1).numFmt = '#,##0';
      row.getCell(n).numFmt = '#,##0.0#';
    });
    if (!rows.length) {
      const row = ws2.addRow(['（无记录）']);
      row.font = { name: '微软雅黑', size: 9, color: { argb: 'FF94A3B8' } };
      ws2.mergeCells(row.number, 1, row.number, n);
    }
  }

  section('按学校汇总',
    ['学校', '', '', '人次', '合计天数'],
    sum.bySchool.map(s => [s.school, '', '', s.count, Math.round(s.days * 10) / 10]));

  section('按教师汇总',
    ['教师姓名', '学校', '学科/年级', '次数', '合计天数'],
    sum.byPerson.map(p => [p.name, p.school || '', p.subject || '', p.count, Math.round(p.days * 10) / 10]));

  section('按请假类型汇总',
    ['请假类型', '', '', '次数', '合计天数'],
    sum.byType.map(t => [t.type, '', '', t.count, Math.round(t.days * 10) / 10]));

  section('按学科汇总',
    ['学科', '', '', '次数', '合计天数'],
    sum.bySubject.map(s => [s.subject, '', '', s.count, Math.round(s.days * 10) / 10]));

  }

  const buf = await wb.xlsx.writeBuffer();
  fs.writeFileSync(options.outPath, Buffer.from(buf));
  return { ok: true, path: options.outPath, count: records.length };
}

// 单人导出时的「教师汇总」页：先给这位老师的基本信息，再给统计与分布，
// 打印出来可以直接当证明材料附在请假档案后面
function buildTeacherSheet(wb, teacher, records, filterText, now) {
  const infoStyle = { name: '微软雅黑', size: 9, color: { argb: 'FF64748B' } };
  const labelFont = { name: '微软雅黑', size: 10, color: { argb: 'FF64748B' } };
  const valueFont = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FF1F2937' } };

  const ws = wb.addWorksheet('教师汇总');
  const W = 4;
  ws.columns = [{ width: 16 }, { width: 28 }, { width: 14 }, { width: 22 }];

  const title = ws.addRow(['教师请假汇总']);
  title.font = { name: '微软雅黑', size: 14, bold: true, color: { argb: 'FF1F2937' } };
  title.height = 26;
  ws.mergeCells(1, 1, 1, W);

  const sub = ws.addRow(['导出时间：' + logic.formatDateTime(now) + '　　统计范围：' + filterText]);
  sub.font = infoStyle;
  ws.mergeCells(2, 1, 2, W);

  function kv(l1, v1, l2, v2) {
    const row = ws.addRow([l1, v1, l2, v2]);
    row.height = 20;
    for (let c = 1; c <= W; c++) {
      const cell = row.getCell(c);
      cell.border = BORDER;
      cell.font = c % 2 === 1 ? labelFont : valueFont;
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    }
    return row;
  }

  ws.addRow([]);
  const tInfo = ws.addRow(['教师信息']);
  tInfo.font = { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FF1F2937' } };
  ws.mergeCells(tInfo.number, 1, tInfo.number, W);

  const alive = records.filter(r => !r.revokedAt);
  const count = alive.length;
  const days = alive.reduce((s, r) => s + logic.effectiveDays(r, now), 0);
  const latest = alive
    .map(r => String(r.startDate || ''))
    .filter(Boolean)
    .sort()
    .pop() || '—';

  const statusText = teacher.hasActive ? '正在请假'
    : (teacher.hasPending ? '有待销假' : '已全部销假');

  kv('教师姓名', teacher.name || '未填', '学校', teacher.school || '未填学校');
  kv('学科', teacher.subject || '未填', '年级', teacher.grade || '未指定');
  kv('联系电话', teacher.phone || '—', '当前状态', statusText);

  ws.addRow([]);
  const tStat = ws.addRow(['累计统计']);
  tStat.font = { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FF1F2937' } };
  ws.mergeCells(tStat.number, 1, tStat.number, W);

  kv('累计请假次数', count + ' 次', '累计请假天数', logic.fmtDays(days));
  kv('平均每次', count ? logic.fmtDays(days / count) : '—', '最近一次', latest);
  kv('全部记录', teacher.totalCount + ' 条',
    '其中已撤销', (teacher.revokedCount || 0) + ' 条（不计入统计）');

  // 按类型 / 按年份分布
  const byType = {};
  const byYear = {};
  alive.forEach(r => {
    const t = (r.type || '').trim() || '未填类型';
    if (!byType[t]) byType[t] = { key: t, count: 0, days: 0 };
    byType[t].count++;
    byType[t].days += logic.effectiveDays(r, now);

    const y = (r.startDate || '').slice(0, 4) || '未知';
    if (!byYear[y]) byYear[y] = { key: y, count: 0, days: 0 };
    byYear[y].count++;
    byYear[y].days += logic.effectiveDays(r, now);
  });

  function block(name, firstCol, rows) {
    ws.addRow([]);
    const t = ws.addRow([name]);
    t.font = { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FF1F2937' } };
    ws.mergeCells(t.number, 1, t.number, W);

    const hr = ws.addRow([firstCol, '次数', '合计天数', '占比']);
    styleHeaderRow(hr, W);

    const total = rows.reduce((s, x) => s + x.days, 0) || 1;
    rows.forEach(x => {
      const row = ws.addRow([x.key, x.count, Math.round(x.days * 10) / 10,
        (x.days / total * 100).toFixed(1) + '%']);
      row.font = BODY_FONT;
      row.height = 18;
      for (let c = 1; c <= W; c++) {
        const cell = row.getCell(c);
        cell.border = BORDER;
        cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'center' };
      }
      row.getCell(3).numFmt = '#,##0.0#';
    });

    if (!rows.length) {
      const row = ws.addRow(['（无记录）']);
      row.font = { name: '微软雅黑', size: 9, color: { argb: 'FF94A3B8' } };
      ws.mergeCells(row.number, 1, row.number, W);
    }
  }

  block('按请假类型分布（按天数）', '请假类型',
    Object.values(byType).sort((a, b) => b.days - a.days));
  block('按年份分布', '年份',
    Object.values(byYear).sort((a, b) => String(b.key).localeCompare(String(a.key))));
}

module.exports = { exportWorkbook };
