import fs from "fs-extra";
import path from "node:path";
import type { Logger } from "./logger";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "\"":
        return "\"";
      case "\\":
        return "\\";
      default:
        return char;
    }
  });
}

function stripInlineComment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
    return trimmed;
  }
  const commentIndex = trimmed.search(/\s#/);
  if (commentIndex === -1) return trimmed;
  return trimmed.slice(0, commentIndex).trimEnd();
}

function unquoteValue(value: string): string {
  const trimmed = value.trim();
  const hasDouble = trimmed.startsWith("\"") && trimmed.endsWith("\"");
  const hasSingle = trimmed.startsWith("'") && trimmed.endsWith("'");
  if (hasDouble) {
    return unescapeDoubleQuoted(trimmed.slice(1, -1));
  }
  if (hasSingle) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? "";
    value = stripInlineComment(value);
    value = unquoteValue(value);
    env[key] = value;
  }
  return env;
}

export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      throw new Error(`AI 环境变量格式错误: ${pair}，请使用 KEY=VALUE`);
    }
    const key = pair.slice(0, index).trim();
    if (!isValidEnvKey(key)) {
      throw new Error(`AI 环境变量名称非法: ${key}`);
    }
    const value = pair.slice(index + 1);
    env[key] = value;
  }
  return env;
}

function normalizeProcessEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export async function resolveEnvFiles(explicitFiles: string[], repoRoot: string, workDir: string): Promise<string[]> {
  if (explicitFiles.length > 0) {
    return uniquePaths(explicitFiles);
  }

  const candidates: string[] = [];
  const workEnv = path.join(workDir, ".env");
  if (workDir !== repoRoot) {
    const repoEnv = path.join(repoRoot, ".env");
    candidates.push(repoEnv);
  }
  candidates.push(workEnv);

  const resolved: string[] = [];
  for (const filePath of candidates) {
    if (await fs.pathExists(filePath)) {
      resolved.push(filePath);
    }
  }

  return uniquePaths(resolved);
}

export async function loadEnvFiles(files: string[], logger?: Logger): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const filePath of files) {
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      logger?.debug(`AI 环境变量文件不存在，已跳过: ${filePath}`);
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const parsed = parseEnvContent(content);
    Object.assign(env, parsed);
    logger?.debug(`AI 环境变量文件已加载: ${filePath}（${Object.keys(parsed).length} 项）`);
  }
  return env;
}

export function mergeEnv(...sources: Array<Record<string, string>>): Record<string, string> {
  return sources.reduce<Record<string, string>>((acc, current) => ({
    ...acc,
    ...current
  }), {});
}

export async function buildAiEnv(options: {
  readonly envFiles: string[];
  readonly envOverrides?: Record<string, string>;
  readonly repoRoot: string;
  readonly workDir: string;
  readonly logger?: Logger;
}): Promise<Record<string, string>> {
  const resolvedFiles = await resolveEnvFiles(options.envFiles, options.repoRoot, options.workDir);
  const fileEnv = await loadEnvFiles(resolvedFiles, options.logger);
  return mergeEnv(fileEnv, normalizeProcessEnv(process.env), options.envOverrides ?? {});
}
