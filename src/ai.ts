import { AiCliConfig, AiResult, IterationRecord, TokenUsage } from './types';
import { runCommand } from './utils';
import { Logger } from './logger';
import { QualityCommand } from './quality';

interface PromptInput {
  readonly task: string;
  readonly workflowGuide: string;
  readonly plan: string;
  readonly notes: string;
  readonly iteration: number;
}

export interface PlanningPromptInput {
  readonly task: string;
  readonly workflowGuide: string;
  readonly plan: string;
}

export interface ExecutionPromptInput {
  readonly task: string;
  readonly workflowGuide: string;
  readonly plan: string;
  readonly notes: string;
  readonly pendingItem: string;
  readonly iteration: number;
}

export interface QualityPromptInput {
  readonly task: string;
  readonly workflowGuide: string;
  readonly plan: string;
  readonly notes: string;
  readonly configContext: string;
}

export interface QualityFixPromptInput {
  readonly task: string;
  readonly workflowGuide: string;
  readonly plan: string;
  readonly notes: string;
  readonly failures: string;
}

export interface PlanSessionOutput {
  readonly branchName?: string;
  readonly planDecision: 'keep' | 'update';
  readonly plan?: string;
}

function extractJsonFromText(text: string, tag?: string): string | null {
  if (tag) {
    const tagged = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, 'i').exec(text);
    if (tagged?.[1]) return tagged[1].trim();
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1).trim();
  }
  return null;
}

function parseCommandList(value: unknown): QualityCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) return [];
      return [{ label: trimmed.split(' ')[0] ?? 'check', command: trimmed }];
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const label = typeof record.label === 'string' ? record.label.trim() : '';
      const command = typeof record.command === 'string' ? record.command.trim() : '';
      if (!label || !command) return [];
      return [{ label, command }];
    }
    return [];
  });
}

/**
 * 构建 AI 提示文本。
 */
export function buildPrompt(input: PromptInput): string {
  const sections = [
    '# 背景任务',
    input.task,
    '# 工作流程基线（供 AI 自主执行）',
    input.workflowGuide,
    '# 当前持久化计划',
    input.plan || '（暂无计划，首轮请生成可执行计划并写入 plan 文件）',
    '# 历史迭代与记忆',
    input.notes || '（首次执行，暂无历史）',
    '# 本轮执行要求',
    [
      '1. 自我检查并补全需求；明确交付物与验收标准。',
      '2. 更新/细化计划，必要时在 plan 文件中重写任务树与优先级。',
      '3. 设计开发步骤并直接生成代码（无需再次请求确认）。',
      '4. 进行代码自审，给出风险与改进清单。',
      '5. 生成单元测试与 e2e 测试代码并给出运行命令；如果环境允许可直接运行命令。',
      '6. 维护持久化记忆文件：摘要本轮关键结论、遗留问题、下一步建议。',
      '7. 准备提交 PR 所需的标题与描述（含变更摘要、测试结果、风险）。',
      '8. 当所有目标完成时，在输出中加入标记 <<DONE>> 以便外层停止循环。'
    ].join('\n')
  ];

  return sections.join('\n\n');
}

/**
 * 构建计划阶段提示文本。
 */
export function buildPlanningPrompt(input: PlanningPromptInput): string {
  const sections = [
    '# 背景任务',
    input.task,
    '# 工作流程基线（供 AI 自主执行）',
    input.workflowGuide,
    '# 当前 plan.md',
    input.plan || '（当前 plan 为空）',
    '# 本轮目标（计划会话）',
    [
      '1. 基于任务生成分支名，格式必须为 wheel-ai/<slug>，全小写，短横线分隔，不能包含中文/空格/特殊符号。',
      '2. 判断现有 plan 是否合理：合理则保持不变，不合理则输出新的完整 plan。',
      '3. plan 只包含开发相关任务，不包含测试、质量检查、PR 等内容。',
      '4. 输出严格 JSON（不要 markdown、不要多余文字），字段：',
      '{"branchName":"wheel-ai/xxx","planDecision":"keep|update","plan":"（当 planDecision 为 update 时提供完整计划内容）"}'
    ].join('\n')
  ];
  return sections.join('\n\n');
}

/**
 * 构建执行阶段提示文本。
 */
export function buildExecutionPrompt(input: ExecutionPromptInput): string {
  const sections = [
    '# 背景任务',
    input.task,
    '# 工作流程基线（供 AI 自主执行）',
    input.workflowGuide,
    '# 当前 plan',
    input.plan || '（plan 为空）',
    '# 历史 notes',
    input.notes || '（notes 为空）',
    '# 本轮执行目标',
    [
      `仅执行以下未完成任务（计划中的最后一条未完成项）：${input.pendingItem}`,
      '执行完成后标记该计划项为 ✅（保持 plan 结构不变）。',
      '如遇阻塞说明原因并给出下一步建议。',
      '输出中避免包含测试计划（测试在后续阶段执行）。'
    ].join('\n')
  ];
  return sections.join('\n\n');
}

/**
 * 构建质量检查命令规划提示文本。
 */
export function buildQualityCommandPrompt(input: QualityPromptInput): string {
  const sections = [
    '# 角色',
    '你是负责代码质量检查的工程师。',
    '# 任务',
    [
      '根据下方项目配置，选择应执行的代码质量检查命令。',
      '命令必须使用 yarn（例如 yarn lint / yarn tsc --noEmit / yarn prettier --check .）。',
      '只输出检查命令，不要执行修复或格式化写入。',
      '若无可执行命令，输出空数组。',
      '输出严格 JSON（不要 markdown、不要多余文字）。'
    ].join('\n'),
    '# 输出 JSON',
    '<quality_commands>{"commands":[{"label":"lint","command":"yarn lint"}]}</quality_commands>',
    '# 背景任务',
    input.task,
    '# 计划（节选）',
    input.plan || '（plan 为空）',
    '# notes（节选）',
    input.notes || '（notes 为空）',
    '# 项目配置',
    input.configContext
  ];
  return sections.join('\n\n');
}

/**
 * 构建质量检查修复提示文本。
 */
export function buildQualityFixPrompt(input: QualityFixPromptInput): string {
  const sections = [
    '# 角色',
    '你是负责修复质量检查失败的工程师。',
    '# 任务',
    [
      '根据失败信息修复代码，使质量检查命令通过。',
      '修复后无需自行重新运行命令，系统会自动重试。'
    ].join('\n'),
    '# 背景任务',
    input.task,
    '# 计划（节选）',
    input.plan || '（plan 为空）',
    '# notes（节选）',
    input.notes || '（notes 为空）',
    '# 失败信息',
    input.failures
  ];
  return sections.join('\n\n');
}

/**
 * 解析计划阶段输出。
 */
export function parsePlanSessionOutput(output: string): PlanSessionOutput | null {
  const jsonText = extractJsonFromText(output, 'plan_output') ?? extractJsonFromText(output);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const branchName = typeof parsed.branchName === 'string' ? parsed.branchName.trim() : undefined;
    const decisionRaw = typeof parsed.planDecision === 'string'
      ? parsed.planDecision
      : typeof parsed.plan_action === 'string'
        ? parsed.plan_action
        : '';
    const planDecision = decisionRaw.trim().toLowerCase() === 'keep' ? 'keep' : 'update';
    const plan = typeof parsed.plan === 'string' ? parsed.plan.trim() : undefined;
    return { branchName, planDecision, plan };
  } catch {
    return null;
  }
}

/**
 * 解析质量检查命令输出。
 */
export function parseQualityCommands(output: string): QualityCommand[] {
  const jsonText = extractJsonFromText(output, 'quality_commands') ?? extractJsonFromText(output);
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return parseCommandList(parsed.commands);
  } catch {
    return [];
  }
}

function pickNumber(pattern: RegExp, text: string): number | undefined {
  const match = pattern.exec(text);
  if (!match || match.length < 2) return undefined;
  const value = Number.parseInt(match[match.length - 1], 10);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * 从日志文本中解析 token 使用量。
 */
export function parseTokenUsage(logs: string): TokenUsage | null {
  const total = pickNumber(/total[_\s]tokens:\s*(\d+)/i, logs);
  const input = pickNumber(/(input|prompt)[_\s]tokens:\s*(\d+)/i, logs);
  const output = pickNumber(/(output|completion)[_\s]tokens:\s*(\d+)/i, logs);
  const consumed = pickNumber(/tokens?\s+used:\s*(\d+)/i, logs) ?? pickNumber(/consumed\s+(\d+)\s+tokens?/i, logs);

  const totalTokens = total ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : consumed);
  if (totalTokens === undefined) return null;

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens
  };
}

function addOptional(a?: number, b?: number): number | undefined {
  if (typeof a !== 'number' && typeof b !== 'number') return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * 合并多轮 token 统计。
 */
export function mergeTokenUsage(previous: TokenUsage | null, current?: TokenUsage | null): TokenUsage | null {
  if (!current) return previous;
  if (!previous) return { ...current };
  return {
    inputTokens: addOptional(previous.inputTokens, current.inputTokens),
    outputTokens: addOptional(previous.outputTokens, current.outputTokens),
    totalTokens: previous.totalTokens + current.totalTokens
  };
}

/**
 * 调用 AI CLI 并返回输出。
 */
export async function runAi(prompt: string, ai: AiCliConfig, logger: Logger, cwd: string): Promise<AiResult> {
  const args = [...ai.args];
  const verboseCommand = ai.promptArg
    ? [ai.command, ...ai.args, ai.promptArg, '<prompt>'].join(' ')
    : [ai.command, ...ai.args, '<stdin>'].join(' ');
  const streamPrefix = `[${ai.command}] `;
  const streamErrorPrefix = `[${ai.command} stderr] `;

  let result;
  if (ai.promptArg) {
    args.push(ai.promptArg, prompt);
    result = await runCommand(ai.command, args, {
      cwd,
      logger,
      verboseLabel: 'ai',
      verboseCommand,
      stream: {
        enabled: true,
        stdoutPrefix: streamPrefix,
        stderrPrefix: streamErrorPrefix
      }
    });
  } else {
    result = await runCommand(ai.command, args, {
      cwd,
      input: prompt,
      logger,
      verboseLabel: 'ai',
      verboseCommand,
      stream: {
        enabled: true,
        stdoutPrefix: streamPrefix,
        stderrPrefix: streamErrorPrefix
      }
    });
  }

  if (result.exitCode !== 0) {
    throw new Error(`AI CLI 执行失败: ${result.stderr || result.stdout}`);
  }

  logger.success('AI 输出完成');
  const usage = parseTokenUsage([result.stdout, result.stderr].filter(Boolean).join('\n'));
  return {
    output: result.stdout.trim(),
    usage
  };
}

/**
 * 生成 notes 迭代记录文本。
 */
export function formatIterationRecord(record: IterationRecord): string {
  const title = record.stage ? record.stage : `迭代 ${record.iteration}`;
  const lines = [
    `### ${title} ｜ ${record.timestamp}`,
    '',
    '#### 提示上下文',
    '```',
    record.prompt,
    '```',
    '',
    '#### AI 输出',
    '```',
    record.aiOutput,
    '```',
    ''
  ];

  if (record.testResults && record.testResults.length > 0) {
    lines.push('#### 测试结果');
    record.testResults.forEach(result => {
      const label = result.kind === 'unit' ? '单元测试' : 'e2e 测试';
      const status = result.success ? '✅ 通过' : '❌ 失败';
      lines.push(`${status} ｜ ${label} ｜ 命令: ${result.command} ｜ 退出码: ${result.exitCode}`);
      if (!result.success) {
        lines.push('```');
        lines.push(result.stderr || result.stdout || '（无输出）');
        lines.push('```');
        lines.push('');
      }
    });
  }

  return lines.join('\n');
}
