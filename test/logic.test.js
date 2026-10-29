'use strict';

// 逻辑层回归用例：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const L = require('../common/logic.js');

const SETTINGS = { warnDays: 1, criticalDays: 3, openWarnDays: 7, openCriticalDays: 14 };

function rec(o) {
  return Object.assign({
    id: 't1', school: '一中', name: '张三', type: '事假',
    startDate: '2026-10-28', startHalf: 'am',
    endDate: '2026-10-28', endHalf: 'pm',
    openEnded: false, days: 1, checkedAt: null, revokedAt: null
  }, o || {});
}

const at = (h, m) => new Date(2026, 9, 28, h, m || 0, 0);
const atDay = (d, h) => new Date(2026, 9, d, h || 0, 0, 0);

/* ---------- 1. 「今日到期」对下午结束的假当天生效 ---------- */

test('endMoment：下午结束算到当天 18:00，上午结束算到 12:00', () => {
  const pm = L.endMoment(rec({ endHalf: 'pm' }));
  assert.strictEqual(pm.getHours(), 18);
  assert.strictEqual(pm.getDate(), 28);
  const am = L.endMoment(rec({ endHalf: 'am' }));
  assert.strictEqual(am.getHours(), 12);
});

test('结束当天：18:00 前是进行中、不提醒；18:00 起进「今日到期」', () => {
  const r = rec({ endHalf: 'pm' });
  assert.strictEqual(L.computeStatus(r, at(10)), 'active');
  assert.strictEqual(L.severity(r, at(10), SETTINGS), null);

  assert.strictEqual(L.computeStatus(r, at(18)), 'pending');
  assert.strictEqual(L.severity(r, at(18), SETTINGS), 'today');
  assert.strictEqual(L.severity(r, at(23), SETTINGS), 'today'); // 以前这里拿到的是 null
});

test('上午结束的假：当天 12:00 起进「今日到期」', () => {
  const r = rec({ endHalf: 'am' });
  assert.strictEqual(L.severity(r, at(11), SETTINGS), null);
  assert.strictEqual(L.severity(r, at(12), SETTINGS), 'today');
});

test('超期等级不受影响：昨天结束=warn，四天前结束=critical', () => {
  assert.strictEqual(L.severity(rec({ endDate: '2026-10-27' }), at(19), SETTINGS), 'warn');
  assert.strictEqual(L.severity(rec({ endDate: '2026-10-24' }), at(19), SETTINGS), 'critical');
});

test('「今日在假」口径不变：晚上十点仍算今天在假', () => {
  const r = rec({ endHalf: 'pm' });
  assert.strictEqual(L.isOngoingToday(r, at(22)), true);
  assert.strictEqual(L.isOngoingToday(r, atDay(29, 9)), false);
});

test('未定的假、已销假/已撤销的记录都不会被「今日到期」误伤', () => {
  const open = rec({ endDate: '', openEnded: true, startDate: '2026-10-28' });
  assert.strictEqual(L.severity(open, at(22), SETTINGS), null);
  const checked = rec({ checkedAt: '2026-10-28T02:00:00.000Z' });
  assert.strictEqual(L.severity(checked, at(22), SETTINGS), null);
  const revoked = rec({ revokedAt: '2026-10-28T02:00:00.000Z' });
  assert.strictEqual(L.severity(revoked, at(22), SETTINGS), null);
});

/* ---------- 2. 未来才开始的「未定」记录文案 ---------- */

test('未定 + 开始日期在未来：显示「N 天后开始」而不是「已请 0 天」', () => {
  const r = rec({ startDate: '2026-10-31', endDate: '', openEnded: true, days: 0 });
  assert.strictEqual(L.notDueKind(r, at(9)), 'upcoming');
  assert.strictEqual(L.notDueText(r, at(9)), '3 天后开始');

  const tomorrow = rec({ startDate: '2026-10-29', endDate: '', openEnded: true, days: 0 });
  assert.strictEqual(L.notDueText(tomorrow, at(9)), '明天开始');
});

test('未定 + 已经开始：仍显示「已请 N 天，未销假」', () => {
  const r = rec({ startDate: '2026-10-26', endDate: '', openEnded: true, days: 0 });
  assert.strictEqual(L.notDueKind(r, at(9)), 'running');
  assert.strictEqual(L.notDueText(r, at(9)), '已请 3 天，未销假');
});

test('普通未来请假 / 进行中的文案不变', () => {
  const future = rec({ startDate: '2026-11-02', endDate: '2026-11-03', days: 2 });
  assert.strictEqual(L.notDueText(future, at(9)), '5 天后开始');
  const running = rec({ startDate: '2026-10-26', endDate: '2026-10-30', days: 5 });
  assert.strictEqual(L.notDueText(running, at(9)), '还剩 2 天');
  assert.strictEqual(L.notDueText(rec(), at(9)), '今天最后一天');
});

/* ---------- 回归：半天分段与天数（v2.0 已修，不能回退） ---------- */

test('同一天 上午 + 下午 两条不冲突；同半天才冲突', () => {
  const a = rec({ id: 'a', startHalf: 'am', endHalf: 'am', days: 0.5 });
  const b = rec({ id: 'b', startHalf: 'pm', endHalf: 'pm', days: 0.5 });
  const c = rec({ id: 'c', startHalf: 'am', endHalf: 'am', days: 0.5 });
  assert.deepStrictEqual(L.findOverlaps([a], b).map(r => r.id), []);
  assert.deepStrictEqual(L.findOverlaps([a], c).map(r => r.id), ['a']);
});

test('跨天上下午交叉仍能拦住', () => {
  const a = rec({ id: 'a', startDate: '2026-10-26', startHalf: 'pm', endDate: '2026-10-28', endHalf: 'am' });
  const b = rec({ id: 'b', startDate: '2026-10-28', startHalf: 'am', endDate: '2026-10-30', endHalf: 'pm' });
  assert.deepStrictEqual(L.findOverlaps([a], b).map(r => r.id), ['a']);
});

test('天数按自然日算，半天 0.5', () => {
  assert.strictEqual(L.calcDays('2026-10-28', 'am', '2026-10-28', 'pm'), 1);
  assert.strictEqual(L.calcDays('2026-10-28', 'am', '2026-10-28', 'am'), 0.5);
  assert.strictEqual(L.calcDays('2026-10-28', 'pm', '2026-10-30', 'am'), 2);
  assert.strictEqual(L.calcDays('2026-10-28', 'am', '2026-10-31', 'pm'), 4);
});
