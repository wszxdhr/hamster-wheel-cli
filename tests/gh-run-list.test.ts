import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGhRunList } from '../src/gh';

test('parseGhRunList 可解析 databaseId 与 null conclusion', () => {
  const output = JSON.stringify([
    {
      databaseId: 101,
      name: 'CI',
      status: 'completed',
      conclusion: null,
      url: 'https://example.com/ci'
    },
    {
      databaseId: 102,
      name: 'Lint',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://example.com/lint'
    }
  ]);

  const runs = parseGhRunList(output);

  assert.equal(runs.length, 2);
  assert.equal(runs[0].databaseId, 101);
  assert.equal(runs[0].conclusion, null);
  assert.equal(runs[1].conclusion, 'failure');
});

test('parseGhRunList 遇到非法 JSON 返回空数组', () => {
  const runs = parseGhRunList('not-json');

  assert.deepEqual(runs, []);
});
