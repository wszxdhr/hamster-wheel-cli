import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensurePlanHeader, findLastPendingPlanItem, markPlanItemDone, parsePlanItems } from '../src/plan';

test('parsePlanItems 能识别完成与未完成项', () => {
  const plan = `# 计划\n- [x] 已完成任务\n- 待办任务 A\n- 待办任务 B ✅\n`;
  const items = parsePlanItems(plan);
  assert.equal(items.length, 3);
  assert.equal(items[0].done, true);
  assert.equal(items[1].done, false);
  assert.equal(items[2].done, true);
  assert.equal(items[1].text, '待办任务 A');
});

test('findLastPendingPlanItem 返回最后一条未完成任务', () => {
  const plan = `# 计划\n- [x] 已完成\n- 待办任务 A\n- 待办任务 B\n`;
  const items = parsePlanItems(plan);
  const pending = findLastPendingPlanItem(items);
  assert.ok(pending);
  assert.equal(pending?.text, '待办任务 B');
});

test('markPlanItemDone 可标记任务完成', () => {
  const plan = `# 计划\n- 待办任务 A\n`;
  const items = parsePlanItems(plan);
  const pending = findLastPendingPlanItem(items);
  assert.ok(pending);
  const updated = markPlanItemDone(plan, pending!);
  assert.ok(updated.includes('✅'));
});

test('ensurePlanHeader 会补齐标题', () => {
  const plan = '- [ ] 任务';
  const normalized = ensurePlanHeader(plan);
  assert.ok(normalized.startsWith('# 计划'));
});
