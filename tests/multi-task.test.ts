import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTaskPlans, normalizeTaskList, parseMultiTaskMode } from '../src/multi-task';

test('parseMultiTaskMode 支持默认与中文别名', () => {
  assert.equal(parseMultiTaskMode(undefined), 'relay');
  assert.equal(parseMultiTaskMode(''), 'relay');
  assert.equal(parseMultiTaskMode('relay'), 'relay');
  assert.equal(parseMultiTaskMode('串行执行'), 'serial');
  assert.equal(parseMultiTaskMode('串行执行但是失败也继续'), 'serial-continue');
  assert.equal(parseMultiTaskMode('并行执行'), 'parallel');
});

test('parseMultiTaskMode 对未知模式抛错', () => {
  assert.throws(() => parseMultiTaskMode('unknown-mode'));
});

test('normalizeTaskList 过滤空白任务', () => {
  assert.deepEqual(normalizeTaskList(undefined), []);
  assert.deepEqual(normalizeTaskList('  '), []);
  assert.deepEqual(normalizeTaskList('task-a'), ['task-a']);
  assert.deepEqual(normalizeTaskList(['task-a', '  ', 'task-b ']), ['task-a', 'task-b']);
});

test('buildTaskPlans 在接力模式下使用上一任务分支作为基线', () => {
  const plans = buildTaskPlans({
    tasks: ['task-a', 'task-b', 'task-c'],
    mode: 'relay',
    useWorktree: true,
    baseBranch: 'main',
    branchInput: 'feat/demo',
    worktreePath: '/tmp/wt/demo',
    logFile: '/tmp/logs/demo.log'
  });

  assert.equal(plans.length, 3);
  assert.equal(plans[0].branchName, 'feat/demo');
  assert.equal(plans[1].branchName, 'feat/demo-2');
  assert.equal(plans[2].branchName, 'feat/demo-3');
  assert.equal(plans[0].baseBranch, 'main');
  assert.equal(plans[1].baseBranch, 'feat/demo');
  assert.equal(plans[2].baseBranch, 'feat/demo-2');
  assert.equal(plans[0].worktreePath, '/tmp/wt/demo');
  assert.equal(plans[1].worktreePath, '/tmp/wt/demo-task-2');
  assert.equal(plans[2].worktreePath, '/tmp/wt/demo-task-3');
  assert.equal(plans[0].logFile, '/tmp/logs/demo.log');
  assert.equal(plans[1].logFile, '/tmp/logs/demo-task-2.log');
  assert.equal(plans[2].logFile, '/tmp/logs/demo-task-3.log');
});

test('buildTaskPlans 在串行模式下保持基线分支不变', () => {
  const plans = buildTaskPlans({
    tasks: ['task-a', 'task-b'],
    mode: 'serial',
    useWorktree: true,
    baseBranch: 'develop',
    branchInput: 'feat/serial',
    worktreePath: '/tmp/wt/serial',
    logFile: '/tmp/logs/serial.log'
  });

  assert.equal(plans[0].baseBranch, 'develop');
  assert.equal(plans[1].baseBranch, 'develop');
});

test('buildTaskPlans 在非 worktree 下保留传入分支名', () => {
  const plans = buildTaskPlans({
    tasks: ['task-a', 'task-b'],
    mode: 'serial',
    useWorktree: false,
    baseBranch: 'main',
    branchInput: 'feat/no-worktree'
  });

  assert.equal(plans[0].branchName, 'feat/no-worktree');
  assert.equal(plans[1].branchName, 'feat/no-worktree');
});
