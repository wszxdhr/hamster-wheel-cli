import path from 'node:path';
import fs from 'fs-extra';

export interface QualityCommand {
  readonly label: string;
  readonly command: string;
}

export interface QualityCheckResult {
  readonly label: string;
  readonly command: string;
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface QualityConfigSnapshot {
  readonly scripts: Record<string, string>;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly configFiles: string[];
  readonly hasTsconfig: boolean;
  readonly hasEslintConfig: boolean;
  readonly hasPrettierConfig: boolean;
}

interface PackageJson {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly eslintConfig?: unknown;
  readonly prettier?: unknown;
}

const ESLINT_CONFIG_FILES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs'
];

const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'prettier.config.js',
  'prettier.config.cjs'
];

const TS_CONFIG_FILE = 'tsconfig.json';

async function readPackageJson(workDir: string): Promise<PackageJson | null> {
  const filePath = path.join(workDir, 'package.json');
  const exists = await fs.pathExists(filePath);
  if (!exists) return null;
  try {
    const content = await fs.readJson(filePath);
    if (!content || typeof content !== 'object') return null;
    return content as PackageJson;
  } catch {
    return null;
  }
}

async function resolveExistingFiles(workDir: string, files: string[]): Promise<string[]> {
  const checks = await Promise.all(files.map(file => fs.pathExists(path.join(workDir, file))));
  return files.filter((_, index) => checks[index]);
}

function pickDeps(source?: Record<string, string>): Record<string, string> {
  return source ?? {};
}

function hasDependency(snapshot: QualityConfigSnapshot, name: string): boolean {
  return Boolean(snapshot.dependencies[name] || snapshot.devDependencies[name]);
}

/**
 * 读取质量检查相关配置快照。
 */
export async function readQualityConfigSnapshot(workDir: string): Promise<QualityConfigSnapshot> {
  const packageJson = await readPackageJson(workDir);
  const scripts = packageJson?.scripts ?? {};
  const dependencies = pickDeps(packageJson?.dependencies);
  const devDependencies = pickDeps(packageJson?.devDependencies);
  const eslintFiles = await resolveExistingFiles(workDir, ESLINT_CONFIG_FILES);
  const prettierFiles = await resolveExistingFiles(workDir, PRETTIER_CONFIG_FILES);
  const tsFiles = await resolveExistingFiles(workDir, [TS_CONFIG_FILE]);

  return {
    scripts,
    dependencies,
    devDependencies,
    configFiles: [...eslintFiles, ...prettierFiles, ...tsFiles],
    hasTsconfig: tsFiles.length > 0,
    hasEslintConfig: eslintFiles.length > 0 || Boolean(packageJson?.eslintConfig),
    hasPrettierConfig: prettierFiles.length > 0 || Boolean(packageJson?.prettier)
  };
}

function createCommand(label: string, command: string): QualityCommand {
  return { label, command };
}

/**
 * 基于脚本与配置推断默认质量检查命令。
 */
export function defaultQualityCommands(snapshot: QualityConfigSnapshot): QualityCommand[] {
  const commands: QualityCommand[] = [];
  const scripts = snapshot.scripts;
  const scriptOrder = ['lint', 'typecheck', 'format:check', 'prettier:check'];
  scriptOrder.forEach(name => {
    if (scripts[name]) {
      commands.push(createCommand(name, `yarn ${name}`));
    }
  });

  if (commands.length > 0) return commands;

  if (snapshot.hasEslintConfig && hasDependency(snapshot, 'eslint')) {
    commands.push(createCommand('eslint', 'yarn eslint .'));
  }

  if (snapshot.hasTsconfig && hasDependency(snapshot, 'typescript')) {
    commands.push(createCommand('tsc', 'yarn tsc --noEmit'));
  }

  if (snapshot.hasPrettierConfig && hasDependency(snapshot, 'prettier')) {
    commands.push(createCommand('prettier', 'yarn prettier --check .'));
  }

  return commands;
}

function compactJson(value: Record<string, string>): string {
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return JSON.stringify(
    entries.reduce<Record<string, string>>((acc, [key, val]) => {
      acc[key] = val;
      return acc;
    }, {}),
    null,
    2
  );
}

/**
 * 构建质量检查上下文文本。
 */
export function formatQualityContext(snapshot: QualityConfigSnapshot): string {
  const relatedDeps = ['eslint', '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin', 'typescript', 'prettier', 'stylelint'];
  const presentDeps = relatedDeps.filter(dep => snapshot.dependencies[dep] || snapshot.devDependencies[dep]);
  const lines = [
    `scripts: ${compactJson(snapshot.scripts)}`,
    `相关依赖: ${presentDeps.length > 0 ? presentDeps.join(', ') : '未检测到'}`,
    `配置文件: ${snapshot.configFiles.length > 0 ? snapshot.configFiles.join(', ') : '未检测到'}`
  ];
  return lines.join('\n');
}

/**
 * 格式化质量检查结果到 notes。
 */
export function formatQualityResults(results: QualityCheckResult[], round: number, timestamp: string): string {
  const lines = [`### 质量检查 ${round} ｜ ${timestamp}`, ''];
  results.forEach(result => {
    const status = result.success ? '✅ 通过' : '❌ 失败';
    lines.push(`${status} ｜ ${result.label} ｜ 命令: ${result.command} ｜ 退出码: ${result.exitCode}`);
    if (!result.success) {
      const output = result.stderr || result.stdout || '（无输出）';
      lines.push('```');
      lines.push(output);
      lines.push('```');
    }
  });
  return lines.join('\n');
}

/**
 * 校验并过滤 AI 输出的命令列表。
 */
export function sanitizeQualityCommands(commands: QualityCommand[]): QualityCommand[] {
  return commands
    .map(cmd => ({
      label: cmd.label.trim(),
      command: cmd.command.trim()
    }))
    .filter(cmd => cmd.label.length > 0 && cmd.command.length > 0)
    .filter(cmd => cmd.command.startsWith('yarn '));
}
