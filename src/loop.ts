import fs from 'fs-extra';
import path from 'node:path';
import { buildPrompt, formatIterationRecord, mergeTokenUsage, runAi } from './ai';
import { createPr, listFailedRuns, viewPr } from './gh';
import { Logger } from './logger';
import { commitAll, ensureWorktree, getCurrentBranch, getRepoRoot, pushBranch } from './git';
import { LoopConfig, SingleTestResult, TestRunResult, TokenUsage } from './types';
import { appendSection, ensureFile, isoNow, readFileSafe, resolvePath, runCommand } from './utils';

async function ensureWorkflowFiles(config: LoopConfig): Promise<void> {
  await ensureFile(config.workflowFiles.workflowDoc, '# AI 工作流程基线\n');
  await ensureFile(config.workflowFiles.planFile, '# 计划\n');
  await ensureFile(config.workflowFiles.notesFile, '# 持久化记忆\n');
}

function describeTestResult(result: SingleTestResult): string {
  const label = result.kind === 'unit' ? '单元测试' : 'e2e 测试';
  if (result.status === 'skipped') return `- ${label}: 未执行`;
  if (result.status === 'passed') return `- ${label}: 通过`;
  const exit = result.exitCode !== undefined ? `（退出码 ${result.exitCode}）` : '';
  const reason = result.message ? `，原因：${result.message}` : '';
  return `- ${label}: 失败${exit}${reason}`;
}

function formatTestSection(iteration: number, result: TestRunResult): string {
  return [
    `### 测试结果｜迭代 ${iteration}`,
    describeTestResult(result.unit),
    describeTestResult(result.e2e),
    ''
  ].join('\n');
}

async function runSingleTest(
  kind: 'unit' | 'e2e',
  enabled: boolean,
  command: string | undefined,
  workDir: string,
  logger: Logger
): Promise<SingleTestResult> {
  if (!enabled || !command) return { kind, status: 'skipped' };

  const readableName = kind === 'unit' ? '单元测试' : 'e2e 测试';
  logger.info(`执行${readableName}: ${command}`);
  const result = await runCommand('bash', ['-lc', command], { cwd: workDir });

  if (result.exitCode === 0) {
    logger.success(`${readableName}完成`);
    return { kind, status: 'passed', command };
  }

  const message = (result.stderr || result.stdout || `退出码 ${result.exitCode}`).trim();
  logger.warn(`${readableName}失败（退出码 ${result.exitCode}）`);
  return {
    kind,
    status: 'failed',
    command,
    exitCode: result.exitCode,
    message
  };
}

async function runTests(config: LoopConfig, workDir: string, logger: Logger): Promise<TestRunResult> {
  const unit = await runSingleTest('unit', config.runTests, config.tests.unitCommand, workDir, logger);
  const e2e = await runSingleTest('e2e', config.runE2e, config.tests.e2eCommand, workDir, logger);
  const hasFailure = unit.status === 'failed' || e2e.status === 'failed';
  return { unit, e2e, hasFailure };
}

function buildBodyFile(workDir: string): string {
  const output = path.join(workDir, 'memory', 'pr-body.md');
  return output;
}

async function writePrBody(bodyPath: string, notes: string, plan: string): Promise<void> {
  const lines = [
    '# 变更摘要',
    plan,
    '\n# 关键输出',
    notes
  ];
  await fs.mkdirp(path.dirname(bodyPath));
  await fs.writeFile(bodyPath, lines.join('\n\n'), 'utf8');
}

export async function runLoop(config: LoopConfig): Promise<void> {
  const logger = new Logger({ verbose: config.verbose });
  const repoRoot = await getRepoRoot(config.cwd);
  await ensureWorkflowFiles(config);

  const workDir = config.git.useWorktree
    ? await ensureWorktree(config.git, repoRoot, logger)
    : repoRoot;

  const planContent = await readFileSafe(config.workflowFiles.planFile);
  if (planContent.trim().length === 0) {
    logger.warn('plan 文件为空，建议 AI 首轮生成计划');
  }

  let branchName = config.git.branchName;
  if (!branchName) {
    branchName = await getCurrentBranch(workDir);
  }

  let accumulatedUsage: TokenUsage | null = null;
  let lastTestResult: TestRunResult | null = null;
  let prFailed = false;

  for (let i = 1; i <= config.iterations; i += 1) {
    const workflowGuide = await readFileSafe(config.workflowFiles.workflowDoc);
    const plan = await readFileSafe(config.workflowFiles.planFile);
    const notes = await readFileSafe(config.workflowFiles.notesFile);

    const prompt = buildPrompt({
      task: config.task,
      workflowGuide,
      plan,
      notes,
      iteration: i
    });

    logger.info(`第 ${i} 轮提示构建完成，调用 AI CLI...`);
    const aiResult = await runAi(prompt, config.ai, logger, workDir);
    accumulatedUsage = mergeTokenUsage(accumulatedUsage, aiResult.usage);

    const record = formatIterationRecord({
      iteration: i,
      prompt,
      aiOutput: aiResult.output,
      timestamp: isoNow()
    });

    await appendSection(config.workflowFiles.notesFile, record);
    logger.success(`已将第 ${i} 轮输出写入 ${config.workflowFiles.notesFile}`);

    const hitStop = aiResult.output.includes(config.stopSignal);
    const shouldRunTests = config.runTests || config.runE2e;
    if (shouldRunTests) {
      lastTestResult = await runTests(config, workDir, logger).catch(error => {
        logger.warn(`测试执行失败: ${String(error)}`);
        return null;
      });

      if (lastTestResult) {
        await appendSection(config.workflowFiles.notesFile, formatTestSection(i, lastTestResult));
        logger.info('已记录测试结果至 notes，供下一轮参考');
      }
    }

    const hasTestFailure = lastTestResult?.hasFailure === true;

    if (hitStop && !hasTestFailure) {
      logger.info(`检测到停止标记 ${config.stopSignal}，提前结束循环`);
      break;
    }
    if (hitStop && hasTestFailure) {
      logger.info(`检测到停止标记 ${config.stopSignal}，但测试失败，继续进入下一轮修复`);
    }
  }

  const lastTestFailed = lastTestResult?.hasFailure === true;

  if (lastTestFailed) {
    logger.warn('存在未通过的测试，已跳过自动提交/推送/PR');
  }

  if (config.autoCommit && !lastTestFailed) {
    await commitAll('chore: fuxi 自动迭代提交', workDir, logger).catch(error => {
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
    const bodyFile = config.pr.bodyPath ?? buildBodyFile(workDir);
    const notes = await readFileSafe(config.workflowFiles.notesFile);
    const plan = await readFileSafe(config.workflowFiles.planFile);
    await writePrBody(bodyFile, notes, plan);

    const prInfo = await createPr(branchName, { ...config.pr, bodyPath: bodyFile }, workDir, logger);
    if (prInfo) {
      logger.success(`PR 已创建: ${prInfo.url}`);
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
    const prInfo = await viewPr(branchName, workDir, logger);
    if (prInfo) logger.info(`已有 PR: ${prInfo.url}`);
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

  logger.success(`fuxi 迭代流程结束｜Token 总计 ${accumulatedUsage?.totalTokens ?? '未知'}`);
}
