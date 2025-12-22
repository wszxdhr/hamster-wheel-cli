import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Logger } from '../src/logger';
import { runCommand } from '../src/utils';

type ConsoleMethodName = 'log';

const ansiPattern = /\u001b\[[0-9;]*m/g;
const timestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /;

const originalConsole: Record<ConsoleMethodName, Console['log']> = {
  log: console.log
};

const outputs: string[] = [];

const stripAnsi = (value: string): string => value.replace(ansiPattern, '');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const capture = (method: ConsoleMethodName, sink: string[]): void => {
  const writer = (...data: unknown[]): void => {
    sink.push(data.map(item => String(item)).join(' '));
  };
  console[method] = writer as Console['log'];
};

const hasLine = (lines: string[], message: string): boolean => {
  const pattern = new RegExp(`^${timestampPattern.source}info\\s+${escapeRegExp(message)}$`);
  return lines.some(line => pattern.test(line));
};

beforeEach(() => {
  outputs.length = 0;
  capture('log', outputs);
});

afterEach(() => {
  console.log = originalConsole.log;
});

test('runCommand 流式输出会写入日志', async () => {
  const logger = new Logger({ verbose: false });
  const script = "process.stdout.write('alpha\\nbeta\\n'); process.stderr.write('gamma\\n');";

  await runCommand(process.execPath, ['-e', script], {
    logger,
    stream: {
      enabled: true,
      stdoutPrefix: '[AI] ',
      stderrPrefix: '[AI-err] '
    }
  });

  const cleaned = outputs.map(stripAnsi);
  assert.ok(hasLine(cleaned, '[AI] alpha'));
  assert.ok(hasLine(cleaned, '[AI] beta'));
  assert.ok(hasLine(cleaned, '[AI-err] gamma'));
});
