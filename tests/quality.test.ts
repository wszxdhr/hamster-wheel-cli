import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultQualityCommands, sanitizeQualityCommands, QualityConfigSnapshot } from '../src/quality';

test('defaultQualityCommands 优先使用脚本', () => {
  const snapshot: QualityConfigSnapshot = {
    scripts: {
      lint: 'eslint .',
      typecheck: 'tsc --noEmit'
    },
    dependencies: {},
    devDependencies: {},
    configFiles: [],
    hasTsconfig: false,
    hasEslintConfig: false,
    hasPrettierConfig: false
  };
  const commands = defaultQualityCommands(snapshot);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].command, 'yarn lint');
  assert.equal(commands[1].command, 'yarn typecheck');
});

test('sanitizeQualityCommands 过滤非 yarn 命令', () => {
  const commands = sanitizeQualityCommands([
    { label: 'lint', command: 'yarn lint' },
    { label: 'bad', command: 'npm run lint' }
  ]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].label, 'lint');
});
