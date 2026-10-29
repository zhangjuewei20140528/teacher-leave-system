'use strict';

// 数据层回归用例：流水号不复用、写失败不留垃圾备份
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../electron/store.js');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-store-'));
  return new Store(dir);
}

const mkRec = (no, extra) => Object.assign({
  id: no, no, school: '一中', name: '张三', type: '事假',
  startDate: '2026-10-29', startHalf: 'am', endDate: '2026-10-29', endHalf: 'pm',
  openEnded: false, days: 1, checkedAt: null, revokedAt: null
}, extra || {});

const backupCount = (store) => fs.readdirSync(store.backupDir).filter(f => f.endsWith('.json')).length;

/* ---------- 3. 流水号单调递增、删除不复用 ---------- */

test('流水号按天生成 001 / 002 / 003', () => {
  const store = tmpStore();
  assert.strictEqual(store.nextLeaveNo([], '2026-10-29'), 'QJ20261029-001');
  store.saveLeaves({ records: [mkRec('QJ20261029-001')] });
  assert.strictEqual(store.nextLeaveNo(store.loadLeaves().records, '2026-10-29'), 'QJ20261029-002');
  store.saveLeaves({ records: [mkRec('QJ20261029-001'), mkRec('QJ20261029-002')] });
  assert.strictEqual(store.nextLeaveNo(store.loadLeaves().records, '2026-10-29'), 'QJ20261029-003');
});

test('删掉当天最后一条后，号不被复用', () => {
  const store = tmpStore();
  store.saveLeaves({ records: [mkRec('QJ20261029-001'), mkRec('QJ20261029-002')] });
  // 删掉 002，只剩 001
  store.saveLeaves({ records: [mkRec('QJ20261029-001')] });
  assert.strictEqual(store.nextLeaveNo(store.loadLeaves().records, '2026-10-29'), 'QJ20261029-003');
  // 全删光也一样
  store.saveLeaves({ records: [] });
  assert.strictEqual(store.nextLeaveNo([], '2026-10-29'), 'QJ20261029-003');
});

test('每天独立计数，跨天从 001 起', () => {
  const store = tmpStore();
  store.saveLeaves({ records: [mkRec('QJ20261029-001'), mkRec('QJ20261029-002')] });
  assert.strictEqual(store.nextLeaveNo(store.loadLeaves().records, '2026-10-30'), 'QJ20261030-001');
});

test('手工改过 leaves.json 留下大号时，计数器会跟上（不回退）', () => {
  const store = tmpStore();
  store.saveLeaves({ records: [mkRec('QJ20261029-001')] });
  store.saveLeaves({ records: [mkRec('QJ20261029-001'), mkRec('QJ20261029-007')] });
  assert.strictEqual(store.nextLeaveNo(store.loadLeaves().records, '2026-10-29'), 'QJ20261029-008');
  // 把 007 删掉，仍是 008（因为计数器已经到 7）
  store.saveLeaves({ records: [mkRec('QJ20261029-001')] });
  assert.strictEqual(store.nextLeaveNo(store.loadLeaves().records, '2026-10-29'), 'QJ20261029-008');
});

test('保存设置时不会把计数器写旧（渲染进程持有旧快照）', () => {
  const store = tmpStore();
  store.saveLeaves({ records: [mkRec('QJ20261029-003')] });
  // 模拟渲染进程拿的是启动时的 settings 快照（noSeq 为空）
  const merged = store.saveSettings({ noSeq: {} , schools: ['一中'] });
  assert.strictEqual(merged.noSeq['20261029'], 3);
  assert.strictEqual(store.nextLeaveNo([], '2026-10-29'), 'QJ20261029-004');
});

/* ---------- 4. 写失败不留无意义的自动备份 ---------- */

test('saveLeaves 写入失败时，刚产生的备份会被删掉', () => {
  const store = tmpStore();
  store.saveLeaves({ records: [mkRec('QJ20261029-001')] });
  const before = backupCount(store);

  const orig = store.writeAtomic;
  store.writeAtomic = () => { throw new Error('磁盘满了'); };
  assert.throws(() => store.saveLeaves({ records: [mkRec('QJ20261029-001'), mkRec('QJ20261029-002')] }), /磁盘满了/);
  store.writeAtomic = orig;

  assert.strictEqual(backupCount(store), before);
  // 原数据没被破坏
  assert.strictEqual(store.loadLeaves().records.length, 1);
});

test('写入成功时仍保留一份「操作前」的备份', () => {
  const store = tmpStore();
  store.saveLeaves({ records: [mkRec('QJ20261029-001')] });
  const first = backupCount(store);
  store.saveLeaves({ records: [mkRec('QJ20261029-001'), mkRec('QJ20261029-002')] });
  assert.strictEqual(backupCount(store), first + 1);
  // 最新一份备份里是「上一次」的状态（1 条），不是刚写的 2 条
  const list = store.listBackups();
  assert.strictEqual(list[0].records, 1);
});

test('写失败时计数器不前进（下次还拿到同一个号）', () => {
  const store = tmpStore();
  store.saveLeaves({ records: [mkRec('QJ20261029-001')] });
  const orig = store.writeAtomic;
  store.writeAtomic = () => { throw new Error('boom'); };
  assert.throws(() => store.saveLeaves({ records: [mkRec('QJ20261029-001'), mkRec('QJ20261029-002')] }));
  store.writeAtomic = orig;
  // 002 没落盘，计数器仍是 1 → 下一个号还是 002
  assert.strictEqual(store.nextLeaveNo(store.loadLeaves().records, '2026-10-29'), 'QJ20261029-002');
});
