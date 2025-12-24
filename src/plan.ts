export interface PlanItem {
  readonly index: number;
  readonly line: string;
  readonly text: string;
  readonly done: boolean;
}

const DONE_MARKERS = ['✅', '✔', '✓'];

function stripCompletionMarkers(text: string): string {
  return text
    .replace(/^\s*\[[xX ]\]\s*/, '')
    .replace(new RegExp(`[${DONE_MARKERS.join('')}]`, 'g'), '')
    .trim();
}

function isCompleted(text: string): boolean {
  if (/\[[xX]\]/.test(text)) return true;
  return DONE_MARKERS.some(marker => text.includes(marker));
}

function matchPlanLine(line: string): { rawText: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const bulletMatch = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (bulletMatch?.[1]) {
    return { rawText: bulletMatch[1] };
  }
  const numberedMatch = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (numberedMatch?.[1]) {
    return { rawText: numberedMatch[1] };
  }
  return null;
}

/**
 * 解析 plan 文本中的任务列表。
 */
export function parsePlanItems(plan: string): PlanItem[] {
  const lines = plan.split(/\r?\n/);
  const items: PlanItem[] = [];
  lines.forEach((line, index) => {
    const match = matchPlanLine(line);
    if (!match) return;
    const rawText = match.rawText.trim();
    const done = isCompleted(rawText);
    const text = stripCompletionMarkers(rawText);
    items.push({
      index,
      line,
      text,
      done
    });
  });
  return items;
}

/**
 * 获取最后一条未完成的计划项。
 */
export function findLastPendingPlanItem(items: PlanItem[]): PlanItem | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item.done) return item;
  }
  return null;
}

/**
 * 按文本匹配未完成计划项（从末尾向前）。
 */
export function findPendingPlanItemByText(items: PlanItem[], text: string): PlanItem | null {
  const normalized = text.trim();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item.done && item.text === normalized) return item;
  }
  return null;
}

function markLineDone(line: string): string {
  if (/\[[xX]\]/.test(line) || DONE_MARKERS.some(marker => line.includes(marker))) {
    return line;
  }
  if (/\[[ ]\]/.test(line)) {
    return line.replace(/\[[ ]\]/, '[x]');
  }
  const bulletMatch = /^(\s*[-*+]\s+)(.*)$/.exec(line);
  if (bulletMatch?.[1]) {
    const prefix = bulletMatch[1];
    const rest = bulletMatch[2]?.trimEnd() ?? '';
    return `${prefix}${rest} ✅`;
  }
  const numberMatch = /^(\s*\d+[.)]\s+)(.*)$/.exec(line);
  if (numberMatch?.[1]) {
    const prefix = numberMatch[1];
    const rest = numberMatch[2]?.trimEnd() ?? '';
    return `${prefix}${rest} ✅`;
  }
  return `${line.trimEnd()} ✅`;
}

/**
 * 标记指定计划项为完成状态。
 */
export function markPlanItemDone(plan: string, item: PlanItem): string {
  const lines = plan.split(/\r?\n/);
  const target = lines[item.index];
  if (typeof target !== 'string') return plan;
  lines[item.index] = markLineDone(target);
  return lines.join('\n');
}

/**
 * 确保 plan 带有标准标题。
 */
export function ensurePlanHeader(plan: string): string {
  const trimmed = plan.trim();
  if (!trimmed) return '# 计划\n';
  if (trimmed.startsWith('# 计划')) return `${trimmed}\n`;
  return `# 计划\n\n${trimmed}\n`;
}
