import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

test('CLI 帮助信息可正常输出', async () => {
  const cliPath = path.join(process.cwd(), 'src', 'cli.ts');
  const { execa } = await import('execa');
  const result = await execa('node', ['--require', 'ts-node/register', cliPath, '--help'], {
    env: {
      ...process.env,
      FORCE_COLOR: '0'
    }
  });

  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('基于 AI CLI 的持续迭代开发工具'));
});
