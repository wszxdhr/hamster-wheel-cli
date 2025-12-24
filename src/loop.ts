import fs from 'fs-extra';
import path from 'node:path';
import {
  buildExecutionPrompt,
  buildPlanningPrompt,
  buildQualityCommandPrompt,
  buildQualityFixPrompt,
  formatIterationRecord,
  mergeTokenUsage,
  parsePlanSessionOutput,
  parseQualityCommands,
  runAi
} from './ai';
import { ensureDependencies } from './deps';
import { GhPrInfo, createPr, listFailedRuns, viewPr } from './gh';
import { Logger } from './logger';
import {
  commitAll,
  ensureWorktree,
  generateBranchName,
  getCurrentBranch,
  getRepoRoot,
  isBranchPushed,
  isWorktreeClean,
  normalizeBranchName,
  pushBranch,
  removeWorktree
} from './git';
import { formatCommandLine } from './logs';
import { createRunTracker } from './runtime-tracker';
import { buildFallbackSummary, buildSummaryPrompt, ensurePrBodySections, parseDeliverySummary } from './summary';
import { CommitMessage, DeliverySummary, LoopConfig, TestRunResult, TokenUsage, WorkflowFiles, WorktreeResult } from './types';
import {
  ensurePlanHeader,
  findLastPendingPlanItem,
  findPendingPlanItemByText,
  markPlanItemDone,
  parsePlanItems
} from './plan';
import {
  QualityCheckResult,
  QualityCommand,
  defaultQualityCommands,
  formatQualityContext,
  formatQualityResults,
  readQualityConfigSnapshot,
  sanitizeQualityCommands
} from './quality';
import { appendSection, ensureFile, isoNow, readFileSafe, runCommand } from './utils';
import { buildWebhookPayload, sendWebhookNotifications } from './webhook';

async function ensureWorkflowFiles(workflowFiles: WorkflowFiles): Promise<void> {
  await ensureFile(workflowFiles.workflowDoc, '# AI 工作流程基线\n');
  await ensureFile(workflowFiles.planFile, '# 计划\n');
  await ensureFile(workflowFiles.notesFile, '# 持久化记忆\n');
}

const MAX_TEST_LOG_LENGTH = 4000;
const QUALITY_SKIP_PATTERNS = [
  /不要检查代码质量/,
  /不进行代码质量检查/,
  /跳过代码质量/,
  /跳过质量检查/,
  /skip\s+quality\s+check/i
];

function trimOutput(output: string, limit = MAX_TEST_LOG_LENGTH): string {
  if (!output) return '';
  if (output.length <= limit) return output;
  return `${output.slice(0, limit)}\n……（输出已截断，原始长度 ${output.length} 字符）`;
}

function shouldSkipQualityFromAgents(content: string): boolean {
  return QUALITY_SKIP_PATTERNS.some(pattern => pattern.test(content));
}

function formatTestResultsSection(results: TestRunResult[], timestamp: string): string {
  const lines = [`### 测试结果 ｜ ${timestamp}`, ''];
  if (results.length === 0) {
    lines.push('- 未运行（本次未执行测试）');
    return lines.join('\n');
  }
  results.forEach(result => {
    const label = result.kind === 'unit' ? '单元测试' : 'e2e 测试';
    const status = result.success ? '✅ 通过' : '❌ 失败';
    lines.push(`${status} ｜ ${label} ｜ 命令: ${result.command} ｜ 退出码: ${result.exitCode}`);
    if (!result.success) {
      const output = result.stderr || result.stdout || '（无输出）';
      lines.push('```');
      lines.push(output);
      lines.push('```');
    }
  });
  return lines.join('\n');
}

async function safeCommandOutput(command: string, args: string[], cwd: string, logger: Logger, label: string, verboseCommand: string): Promise<string> {
  const result = await runCommand(command, args, {
    cwd,
    logger,
    verboseLabel: label,
    verboseCommand
  });
  if (result.exitCode !== 0) {
    logger.warn(`${label} 命令失败: ${result.stderr || result.stdout}`);
    return '';
  }
  return result.stdout.trim();
}

async function runSingleTest(kind: 'unit' | 'e2e', command: string, cwd: string, logger: Logger): Promise<TestRunResult> {
  const label = kind === 'unit' ? '单元测试' : 'e2e 测试';
  logger.info(`执行${label}: ${command}`);
  const result = await runCommand('bash', ['-lc', command], {
    cwd,
    logger,
    verboseLabel: 'shell',
    verboseCommand: `bash -lc "${command}"`
  });
  const success = result.exitCode === 0;
  if (success) {
    logger.success(`${label}完成`);
  } else {
    logger.warn(`${label}失败（退出码 ${result.exitCode}）`);
  }

  return {
    kind,
    command,
    success,
    exitCode: result.exitCode,
    stdout: trimOutput(result.stdout.trim()),
    stderr: trimOutput(result.stderr.trim())
  };
}

async function runTests(config: LoopConfig, workDir: string, logger: Logger): Promise<TestRunResult[]> {
  const results: TestRunResult[] = [];

  if (config.runTests && config.tests.unitCommand) {
    const unitResult = await runSingleTest('unit', config.tests.unitCommand, workDir, logger);
    results.push(unitResult);
  }

  if (config.runE2e && config.tests.e2eCommand) {
    const e2eResult = await runSingleTest('e2e', config.tests.e2eCommand, workDir, logger);
    results.push(e2eResult);
  }

  return results;
}

async function runQualityCommands(commands: QualityCommand[], workDir: string, logger: Logger): Promise<QualityCheckResult[]> {
  const results: QualityCheckResult[] = [];
  for (const command of commands) {
    logger.info(`执行质量检查: ${command.command}`);
    const result = await runCommand('bash', ['-lc', command.command], {
      cwd: workDir,
      logger,
      verboseLabel: 'quality',
      verboseCommand: `bash -lc "${command.command}"`
    });
    const success = result.exitCode === 0;
    if (success) {
      logger.success(`质量检查通过: ${command.label}`);
    } else {
      logger.warn(`质量检查失败: ${command.label}（退出码 ${result.exitCode}）`);
    }
    results.push({
      label: command.label,
      command: command.command,
      success,
      exitCode: result.exitCode,
      stdout: trimOutput(result.stdout.trim()),
      stderr: trimOutput(result.stderr.trim())
    });
  }
  return results;
}

function reRootPath(filePath: string, repoRoot: string, workDir: string): string {
  const relative = path.relative(repoRoot, filePath);
  if (relative.startsWith('..')) return filePath;
  return path.join(workDir, relative);
}

function reRootWorkflowFiles(workflowFiles: WorkflowFiles, repoRoot: string, workDir: string): WorkflowFiles {
  if (repoRoot === workDir) return workflowFiles;
  return {
    workflowDoc: reRootPath(workflowFiles.workflowDoc, repoRoot, workDir),
    notesFile: reRootPath(workflowFiles.notesFile, repoRoot, workDir),
    planFile: reRootPath(workflowFiles.planFile, repoRoot, workDir)
  };
}

function buildBodyFile(workDir: string): string {
  return path.join(workDir, 'memory', 'pr-body.md');
}

async function writePrBody(bodyPath: string, content: string, appendExisting: boolean): Promise<void> {
  await fs.mkdirp(path.dirname(bodyPath));
  let finalContent = content.trim();
  if (appendExisting) {
    const existing = await readFileSafe(bodyPath);
    const trimmedExisting = existing.trim();
    if (trimmedExisting.length > 0) {
      finalContent = `${trimmedExisting}\n\n---\n\n${finalContent}`;
    }
  }
  await fs.writeFile(bodyPath, `${finalContent}\n`, 'utf8');
}

interface WorktreeCleanupContext {
  readonly repoRoot: string;
  readonly workDir: string;
  readonly branchName?: string;
  readonly prInfo: GhPrInfo | null;
  readonly worktreeCreated: boolean;
  readonly logger: Logger;
}

async function cleanupWorktreeIfSafe(context: WorktreeCleanupContext): Promise<void> {
  const { repoRoot, workDir, branchName, prInfo, worktreeCreated, logger } = context;
  if (!worktreeCreated) {
    logger.debug('worktree 并非本次创建，跳过自动清理');
    return;
  }
  if (workDir === repoRoot) {
    logger.debug('当前未使用独立 worktree，跳过自动清理');
    return;
  }
  if (!branchName) {
    logger.warn('未能确定 worktree 分支名，保留工作目录以免丢失进度');
    return;
  }

  const clean = await isWorktreeClean(workDir, logger);
  if (!clean) {
    logger.warn('worktree 仍有未提交变更，已保留工作目录');
    return;
  }

  const pushed = await isBranchPushed(branchName, workDir, logger);
  if (!pushed) {
    logger.warn(`分支 ${branchName} 尚未推送到远端，已保留 worktree`);
    return;
  }

  if (!prInfo) {
    logger.warn('未检测到关联 PR，已保留 worktree');
    return;
  }

  await removeWorktree(workDir, repoRoot, logger);
}

/**
 * 执行主迭代循环。
 */
export async function runLoop(config: LoopConfig): Promise<void> {
  const logger = new Logger({ verbose: config.verbose, logFile: config.logFile });
  const repoRoot = await getRepoRoot(config.cwd, logger);
  logger.debug(`仓库根目录: ${repoRoot}`);

  let branchName = config.git.branchName;
  let workDir = repoRoot;
  let worktreeCreated = false;
  let accumulatedUsage: TokenUsage | null = null;
  let lastTestResults: TestRunResult[] | null = null;
  let lastAiOutput = '';
  let prInfo: GhPrInfo | null = null;
  let prFailed = false;
  let lastRound = 0;
  let runError: string | null = null;
  let sessionCount = 0;
  let runTracker: Awaited<ReturnType<typeof createRunTracker>> | null = null;
  let preWorktreePlan = '';

  const pendingNoteSections: string[] = [];

  const notifyWebhook = async (event: 'task_start' | 'iteration_start' | 'task_end', iteration: number, stage: string): Promise<void> => {
    const payload = buildWebhookPayload({
      event,
      task: config.task,
      branch: branchName,
      iteration,
      stage
    });
    await sendWebhookNotifications(config.webhooks, payload, logger);
  };

  const recordAiSession = async (
    stage: string,
    prompt: string,
    aiResult: { output: string; usage: TokenUsage | null },
    notesFile?: string
  ): Promise<void> => {
    sessionCount += 1;
    accumulatedUsage = mergeTokenUsage(accumulatedUsage, aiResult.usage);
    lastAiOutput = aiResult.output;
    lastRound = sessionCount;
    const record = formatIterationRecord({
      iteration: sessionCount,
      stage,
      prompt,
      aiOutput: aiResult.output,
      timestamp: isoNow()
    });
    if (notesFile) {
      await appendSection(notesFile, record);
      logger.success(`已将${stage}输出写入 ${notesFile}`);
    } else {
      pendingNoteSections.push(record);
    }
    await runTracker?.update(sessionCount, accumulatedUsage?.totalTokens ?? 0);
  };

  try {
    await notifyWebhook('task_start', 0, '任务开始');

    const aiConfig = config.ai;
    const workflowGuideRoot = await readFileSafe(config.workflowFiles.workflowDoc);
    let planSessionOutput = null as ReturnType<typeof parsePlanSessionOutput> | null;

    if (config.resolveBranchByAi && !branchName) {
      preWorktreePlan = await readFileSafe(config.workflowFiles.planFile);
      const prompt = buildPlanningPrompt({
        task: config.task,
        workflowGuide: workflowGuideRoot,
        plan: preWorktreePlan
      });
      await notifyWebhook('iteration_start', sessionCount + 1, '计划阶段');
      const aiResult = await runAi(prompt, aiConfig, logger, repoRoot);
      planSessionOutput = parsePlanSessionOutput(aiResult.output);
      const fallbackBranch = generateBranchName();
      branchName = normalizeBranchName(planSessionOutput?.branchName, fallbackBranch);
      await recordAiSession('计划阶段', prompt, aiResult);
    }

    if (config.git.useWorktree && !branchName) {
      branchName = generateBranchName();
    }

    const worktreeResult: WorktreeResult = config.git.useWorktree
      ? await ensureWorktree({ ...config.git, branchName }, repoRoot, logger)
      : { path: repoRoot, created: false };
    workDir = worktreeResult.path;
    worktreeCreated = worktreeResult.created;
    logger.debug(`工作目录: ${workDir}`);

    const commandLine = formatCommandLine(process.argv);
    runTracker = await createRunTracker({
      logFile: config.logFile,
      command: commandLine,
      path: workDir,
      logger
    });
    if (accumulatedUsage) {
      await runTracker?.update(sessionCount, accumulatedUsage.totalTokens ?? 0);
    }

    if (!branchName) {
      try {
        branchName = await getCurrentBranch(workDir, logger);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`读取分支名失败，webhook 中将缺失分支信息：${message}`);
      }
    }

    if (config.skipInstall) {
      logger.info('已跳过依赖检查');
    } else {
      await ensureDependencies(workDir, logger);
    }

    const workflowFiles = reRootWorkflowFiles(config.workflowFiles, repoRoot, workDir);
    await ensureWorkflowFiles(workflowFiles);

    if (pendingNoteSections.length > 0) {
      for (const section of pendingNoteSections) {
        await appendSection(workflowFiles.notesFile, section);
      }
      logger.success(`已同步计划阶段输出到 ${workflowFiles.notesFile}`);
    }

    if (!planSessionOutput) {
      const workflowGuide = await readFileSafe(workflowFiles.workflowDoc);
      const plan = await readFileSafe(workflowFiles.planFile);
      const prompt = buildPlanningPrompt({
        task: config.task,
        workflowGuide,
        plan
      });
      await notifyWebhook('iteration_start', sessionCount + 1, '计划阶段');
      const aiResult = await runAi(prompt, aiConfig, logger, workDir);
      planSessionOutput = parsePlanSessionOutput(aiResult.output);
      await recordAiSession('计划阶段', prompt, aiResult, workflowFiles.notesFile);
    }

    const currentPlan = await readFileSafe(workflowFiles.planFile);
    const basePlan = currentPlan.trim() ? currentPlan : preWorktreePlan;
    let finalPlan = basePlan;
    if (planSessionOutput?.planDecision === 'update') {
      finalPlan = planSessionOutput.plan?.trim() || '';
    }
    if (!finalPlan.trim()) {
      finalPlan = `- [ ] ${config.task}`;
    }
    const normalizedPlan = ensurePlanHeader(finalPlan);
    if (normalizedPlan.trim() !== currentPlan.trim()) {
      await fs.writeFile(workflowFiles.planFile, normalizedPlan, 'utf8');
      logger.success(`已更新计划文件: ${workflowFiles.planFile}`);
    }

    let executionRound = 0;
    while (true) {
      const planSnapshot = await readFileSafe(workflowFiles.planFile);
      const items = parsePlanItems(planSnapshot);
      const pending = findLastPendingPlanItem(items);
      if (!pending) {
        logger.info('plan 已全部执行完成');
        break;
      }
      if (executionRound >= config.iterations) {
        throw new Error(`计划未完成，已达到最大执行轮次 ${config.iterations}`);
      }
      executionRound += 1;
      const workflowGuide = await readFileSafe(workflowFiles.workflowDoc);
      const notes = await readFileSafe(workflowFiles.notesFile);
      const prompt = buildExecutionPrompt({
        task: config.task,
        workflowGuide,
        plan: planSnapshot,
        notes,
        pendingItem: pending.text,
        iteration: executionRound
      });
      await notifyWebhook('iteration_start', sessionCount + 1, `执行计划 ${executionRound}`);
      const aiResult = await runAi(prompt, aiConfig, logger, workDir);
      await recordAiSession(`执行计划 ${executionRound}`, prompt, aiResult, workflowFiles.notesFile);

      const planAfter = await readFileSafe(workflowFiles.planFile);
      const itemsAfter = parsePlanItems(planAfter || planSnapshot);
      const matched = findPendingPlanItemByText(itemsAfter, pending.text);
      if (matched) {
        const updatedPlan = markPlanItemDone(planAfter || planSnapshot, matched);
        if (updatedPlan.trim() !== (planAfter || planSnapshot).trim()) {
          await fs.writeFile(workflowFiles.planFile, ensurePlanHeader(updatedPlan), 'utf8');
        }
      } else {
        logger.warn('未能在 plan 中定位已执行项，未更新完成标记');
      }
    }

    const remaining = findLastPendingPlanItem(parsePlanItems(await readFileSafe(workflowFiles.planFile)));
    if (remaining) {
      throw new Error(`仍有未完成计划项：${remaining.text}`);
    }

    const agentsContent = await readFileSafe(path.join(workDir, 'AGENTS.md'));
    const skipQuality = config.skipQuality || shouldSkipQualityFromAgents(agentsContent);
    if (skipQuality) {
      logger.info('已跳过代码质量检查');
    } else {
      const snapshot = await readQualityConfigSnapshot(workDir);
      const context = formatQualityContext(snapshot);
      const workflowGuide = await readFileSafe(workflowFiles.workflowDoc);
      const plan = await readFileSafe(workflowFiles.planFile);
      const notes = await readFileSafe(workflowFiles.notesFile);
      const commandPrompt = buildQualityCommandPrompt({
        task: config.task,
        workflowGuide,
        plan,
        notes,
        configContext: context
      });
      await notifyWebhook('iteration_start', sessionCount + 1, '质量检查命令规划');
      const commandResult = await runAi(commandPrompt, aiConfig, logger, workDir);
      await recordAiSession('质量检查命令规划', commandPrompt, commandResult, workflowFiles.notesFile);
      let commands = sanitizeQualityCommands(parseQualityCommands(commandResult.output));
      if (commands.length === 0) {
        logger.warn('AI 未返回可用的质量检查命令，使用默认推断结果');
        commands = defaultQualityCommands(snapshot);
      }
      if (commands.length === 0) {
        logger.info('未检测到可执行的质量检查命令，跳过质量检查');
      } else {
        let qualityRound = 0;
        while (true) {
          qualityRound += 1;
          const results = await runQualityCommands(commands, workDir, logger);
          await appendSection(workflowFiles.notesFile, formatQualityResults(results, qualityRound, isoNow()));
          const failed = results.filter(result => !result.success);
          if (failed.length === 0) {
            break;
          }
          if (qualityRound >= config.iterations) {
            throw new Error('质量检查多次失败，请检查并重试');
          }
          const failureText = failed.map(result => {
            const output = result.stderr || result.stdout || '（无输出）';
            return `命令: ${result.command}\n退出码: ${result.exitCode}\n${output}`;
          }).join('\n\n');
          const latestPlan = await readFileSafe(workflowFiles.planFile);
          const latestNotes = await readFileSafe(workflowFiles.notesFile);
          const fixPrompt = buildQualityFixPrompt({
            task: config.task,
            workflowGuide,
            plan: latestPlan,
            notes: latestNotes,
            failures: failureText
          });
          await notifyWebhook('iteration_start', sessionCount + 1, `质量修复 ${qualityRound}`);
          const fixResult = await runAi(fixPrompt, aiConfig, logger, workDir);
          await recordAiSession(`质量修复 ${qualityRound}`, fixPrompt, fixResult, workflowFiles.notesFile);
        }
      }
    }

    const shouldRunTests = config.runTests || config.runE2e;
    if (shouldRunTests) {
      try {
        lastTestResults = await runTests(config, workDir, logger);
      } catch (error) {
        const errorMessage = String(error);
        logger.warn(`测试执行异常: ${errorMessage}`);
        lastTestResults = [{
          kind: 'unit',
          command: config.tests.unitCommand ?? '未知测试命令',
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: trimOutput(errorMessage)
        }];
      }
    } else {
      lastTestResults = [];
    }

    if (lastTestResults) {
      await appendSection(workflowFiles.notesFile, formatTestResultsSection(lastTestResults, isoNow()));
    }

    const lastTestFailed = lastTestResults?.some(result => !result.success) ?? false;
    if (lastTestFailed) {
      logger.warn('存在未通过的测试，已跳过自动提交/推送/PR');
    }

    let deliverySummary: DeliverySummary | null = null;
    const shouldPrepareDelivery = !lastTestFailed && (config.autoCommit || config.pr.enable);
    if (shouldPrepareDelivery) {
      const [gitStatus, diffStat] = await Promise.all([
        safeCommandOutput('git', ['status', '--short'], workDir, logger, 'git', 'git status --short'),
        safeCommandOutput('git', ['diff', '--stat'], workDir, logger, 'git', 'git diff --stat')
      ]);
      const summaryPrompt = buildSummaryPrompt({
        task: config.task,
        plan: await readFileSafe(workflowFiles.planFile),
        notes: await readFileSafe(workflowFiles.notesFile),
        lastAiOutput,
        testResults: lastTestResults,
        gitStatus,
        diffStat,
        branchName
      });
      try {
        const summaryResult = await runAi(summaryPrompt, aiConfig, logger, workDir);
        accumulatedUsage = mergeTokenUsage(accumulatedUsage, summaryResult.usage);
        deliverySummary = parseDeliverySummary(summaryResult.output);
        if (!deliverySummary) {
          logger.warn('AI 总结输出解析失败，使用兜底文案');
        }
      } catch (error) {
        logger.warn(`AI 总结生成失败: ${String(error)}`);
      }
      if (!deliverySummary) {
        deliverySummary = buildFallbackSummary({ task: config.task, testResults: lastTestResults });
      }
    }
    await runTracker?.update(lastRound, accumulatedUsage?.totalTokens ?? 0);

    if (config.autoCommit && !lastTestFailed) {
      const summary = deliverySummary ?? buildFallbackSummary({ task: config.task, testResults: lastTestResults });
      const commitMessage: CommitMessage = {
        title: summary.commitTitle,
        body: summary.commitBody
      };
      await commitAll(commitMessage, workDir, logger).catch(error => {
        logger.warn(String(error));
      });
    }

    if (config.autoPush && branchName && !lastTestFailed) {
      await pushBranch(branchName, workDir, logger).catch(error => {
        logger.warn(String(error));
      });
    }

    if (config.pr.enable && branchName && !lastTestFailed) {
      logger.info('开始创建 PR...');
      const summary = deliverySummary ?? buildFallbackSummary({ task: config.task, testResults: lastTestResults });
      const prTitleCandidate = config.pr.title?.trim() || summary.prTitle;
      const prBodyContent = ensurePrBodySections(summary.prBody, {
        commitTitle: summary.commitTitle,
        commitBody: summary.commitBody,
        testResults: lastTestResults
      });
      const bodyFile = config.pr.bodyPath ?? buildBodyFile(workDir);
      await writePrBody(bodyFile, prBodyContent, Boolean(config.pr.bodyPath));

      const createdPr = await createPr(branchName, { ...config.pr, title: prTitleCandidate, bodyPath: bodyFile }, workDir, logger);
      prInfo = createdPr;
      if (createdPr) {
        logger.success(`PR 已创建: ${createdPr.url}`);
        const failedRuns = await listFailedRuns(branchName, workDir, logger);
        if (failedRuns.length > 0) {
          failedRuns.forEach(run => {
            logger.warn(`Actions 失败: ${run.name} (${run.status}/${run.conclusion ?? 'unknown'}) ${run.url}`);
          });
        }
      } else {
        prFailed = true;
        logger.error('PR 创建失败，详见上方 gh 输出');
      }
    } else if (branchName && !config.pr.enable) {
      logger.info('未开启 PR 创建（--pr 未传），尝试查看已有 PR');
      const existingPr = await viewPr(branchName, workDir, logger);
      prInfo = existingPr;
      if (existingPr) logger.info(`已有 PR: ${existingPr.url}`);
    }

    if (accumulatedUsage) {
      const input = accumulatedUsage.inputTokens ?? '-';
      const output = accumulatedUsage.outputTokens ?? '-';
      logger.info(`Token 消耗汇总：输入 ${input}｜输出 ${output}｜总计 ${accumulatedUsage.totalTokens}`);
    } else {
      logger.info('未解析到 Token 消耗信息，可检查 AI CLI 输出格式是否包含 token 提示');
    }

    if (lastTestFailed || prFailed) {
      throw new Error('流程存在未解决的问题（测试未通过或 PR 创建失败）');
    }

    if (config.git.useWorktree && workDir !== repoRoot) {
      await cleanupWorktreeIfSafe({
        repoRoot,
        workDir,
        branchName,
        prInfo,
        worktreeCreated,
        logger
      });
    }

    logger.success(`wheel-ai 迭代流程结束｜Token 总计 ${accumulatedUsage?.totalTokens ?? '未知'}`);
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const stage = runError ? '任务结束（失败）' : '任务结束';
    await notifyWebhook('task_end', lastRound, stage);
    await runTracker?.finalize();
  }
}
