/**
 * Non-interactive CLI verbs: `ralphflow status|list|doctor|cancel|continue`.
 *
 * These reach the same state machine as the ralphflow_* tools without
 * starting the chat, so scripts and CI can inspect, unblock, and stop
 * workflows. The formatting helpers are the engine's own, so headless output
 * and the in-chat tool responses stay in sync. `continue` is the one verb
 * that also drives the instance afterward (via a real runner, blocking until
 * the next stopping point) rather than being a pure read/mutate-and-return —
 * see its own doc comment for why that's still a bounded, one-shot operation
 * and not a background daemon.
 *
 * There is no session id out here — every instance looks "owned by someone
 * else", which is exactly right: a headless invocation is not a chat session.
 */

import fs from "fs";
import path from "path";
import { createEngine, MANUAL_GATE_MARKER, type Engine } from "./engine/core.js";
import { abortActiveCheck, adversarialCheck } from "./engine/check.js";
import { isInstanceGone, withInstanceLock } from "./engine/lock.js";
import { createRunner, type RunnerDeps } from "./engine/runner.js";
import { formatSkillReport, loadSkillIndex } from "./engine/skills.js";
import { isSubWorkflowStep } from "./engine/types.js";
import { resolveContinueAction } from "./commands/tools.js";

export interface HeadlessResult {
  text: string;
  /** Process exit code: 0 = fine, 1 = the user asked about something that isn't there. */
  code: number;
}

export function runStatus(engine: Engine, explicit?: string): HeadlessResult {
  const instances = engine.listInstances();

  let target = null as (typeof instances)[number] | null;
  if (explicit) {
    const wanted = String(explicit).trim();
    const exact = instances.filter((i) => i.id === wanted);
    const matches = exact.length > 0 ? exact : instances.filter((i) => i.id.startsWith(wanted));
    if (matches.length === 1) target = matches[0];
    else if (matches.length === 0) {
      return {
        code: 1,
        text: instances.length === 0
          ? `没有找到实例 "${wanted}"。当前没有活跃的工作流实例。`
          : `没有找到匹配 "${wanted}" 的实例。\n\n${engine.formatInstanceList(instances)}`,
      };
    } else {
      return { code: 1, text: `前缀 "${wanted}" 匹配到多个实例：\n\n${engine.formatInstanceList(matches)}` };
    }
  } else if (instances.length === 1) {
    target = instances[0];
  }

  if (!target) {
    if (instances.length === 0) return { code: 0, text: "没有活跃的工作流实例。运行 `ralphflow` 进入交互界面后用 /ralphflow-start 启动一个。" };
    return {
      code: 0,
      text: engine.formatInstanceList(instances, "查看某个实例详情：`ralphflow status <实例ID>`（支持唯一前缀）。"),
    };
  }

  const state = target.state;
  const workflow = engine.loadWorkflow(state.workflow_name);
  const currentStep = workflow ? engine.getStep(workflow, state.current_step) : null;
  const driver = engine.foreignRunnerPid(target.id);

  let status = `## 工作流状态

- **实例**: \`${target.id}\`
- **工作流**: ${state.workflow_name}
- **状态**: ${engine.instanceStatusLabel(target)}
- **当前步骤**: ${state.current_step}
- **当前阶段**: ${state.current_phase}
- **失败次数**: ${state.fail_count}
- **属主会话**: ${target.owner ? `\`${target.owner.slice(0, 8)}\`` : "无"}
- **最后活动**: ${engine.formatLastActivity(target.lastActivity)}`;

  if (driver) status += `\n- **驱动进程**: pid ${driver}（正在执行中）`;
  if (state.last_failure_reason) status += `\n- **上次失败原因**: ${state.last_failure_reason}`;

  if (target.manualGate) {
    status += `\n\n> 📋 该实例正在等待手动审查。审查完成后在 TUI 中调用 \`/ralphflow-continue\` 进入验证阶段。`;
  }

  if (currentStep) {
    if (isSubWorkflowStep(currentStep)) {
      status += `

## 当前步骤详情

- **描述**: ${currentStep.desc}
- **类型**: 子工作流
- **子工作流**: ${currentStep.workflow}
- **输入**: ${currentStep.inputs ? JSON.stringify(currentStep.inputs) : "无"}
- **最大失败次数**: ${currentStep.max_fail_count}`;
    } else {
      status += `

## 当前步骤详情

- **描述**: ${currentStep.desc}
- **任务**: ${currentStep.do}
- **输入**: ${currentStep.input || "无"}
- **输出**: ${currentStep.output || "无"}
- **检查**: ${currentStep.check}
- **最大失败次数**: ${currentStep.max_fail_count}`;
    }
  }

  if (instances.length > 1) {
    status += `\n\n> ℹ️ 本目录共有 ${instances.length} 个活跃实例。\`ralphflow status\` 不带参数会列出全部。`;
  }

  return { code: 0, text: status };
}

export function runList(engine: Engine): HeadlessResult {
  const workflows = engine.listWorkflows();
  let text = workflows.length > 0
    ? `## 可用工作流\n\n${workflows.map((w) => `- **${w.name}**: ${w.desc}`).join("\n")}`
    : "没有找到工作流。请在 .ralph-flow/workflows/ 目录创建工作流定义文件。";
  const instances = engine.listInstances();
  if (instances.length > 0) {
    text += `\n\n---\n\n${engine.formatInstanceList(instances)}`;
  }
  return { code: 0, text };
}

export function runDoctor(engine: Engine): HeadlessResult {
  // Skills get the same treatment as workflows: a shadowed skill is exactly as
  // confusing as a shadowed workflow ("I edited it and nothing changed").
  const index = loadSkillIndex(engine.getRalphFlowDir(), engine.getGlobalConfigHome());
  return { code: 0, text: `${engine.buildDoctorReport()}\n\n## Skill\n\n${formatSkillReport(index)}` };
}

/**
 * Cancel an instance. Takes the cross-process lock so a cancel can't interleave
 * with a runner committing a check verdict in another process. The runner there
 * notices the instance is gone on its next state read and discards its result.
 */
export async function runCancel(engine: Engine, explicit?: string): Promise<HeadlessResult> {
  const instances = engine.listInstances();
  if (instances.length === 0) return { code: 1, text: "没有活跃的工作流实例。" };

  let target = null as (typeof instances)[number] | null;
  if (explicit) {
    const wanted = String(explicit).trim();
    const exact = instances.filter((i) => i.id === wanted);
    const matches = exact.length > 0 ? exact : instances.filter((i) => i.id.startsWith(wanted));
    if (matches.length === 1) target = matches[0];
    else if (matches.length === 0) return { code: 1, text: `没有找到匹配 "${wanted}" 的实例。\n\n${engine.formatInstanceList(instances)}` };
    else return { code: 1, text: `前缀 "${wanted}" 匹配到 ${matches.length} 个实例，请提供更长的前缀：\n\n${engine.formatInstanceList(matches)}` };
  } else if (instances.length === 1) {
    target = instances[0];
  } else {
    return { code: 1, text: engine.formatInstanceList(instances, "存在多个实例，请指定要取消的实例：`ralphflow cancel <实例ID>`（支持唯一前缀）。") };
  }

  const instId = target.id;
  const state = engine.readState(instId);
  const workflowName = state ? state.workflow_name : instId;
  const driver = engine.foreignRunnerPid(instId);

  try {
    const reportPath = await withInstanceLock(engine.getInstanceDir(instId), instId, () => {
      engine.logEvent(instId, "info", "workflow_cancelled", { workflow: workflowName, instance: instId });
      return engine.destroyInstance(instId, "cancelled");
    });
    let text = `工作流 "${workflowName}"（实例 \`${instId}\`）已取消。`;
    if (reportPath) text += `\n执行报告：${path.relative(engine.projectDir, reportPath)}`;
    if (driver) {
      // destroyInstance's abort handles only reach sessions in THIS process.
      text += `\n\n> ⚠️ 该实例正被 pid ${driver} 的 ralph 进程驱动。它在下一次读取状态时会发现实例已消失并停止；已在途的模型调用可能还会跑完当前一轮。`;
    }
    return { code: 0, text };
  } catch (e: any) {
    if (isInstanceGone(e)) return { code: 0, text: `实例 \`${instId}\` 已经不存在（可能刚被其他进程取消或完成）。` };
    return { code: 1, text: `取消失败：${e.message}` };
  }
}

/**
 * `ralphflow continue [实例ID]` — approve a manual review / resume a paused
 * workflow / recover from a crash, without an interactive session. Reuses
 * ralphflow_continue's exact state machine (`resolveContinueAction`,
 * commands/tools.ts) — the only difference is what happens after: an
 * interactive session hands off to the run view; this drives the instance
 * with a real runner and blocks until it reaches its NEXT stopping point
 * (another gate/pause, or completion) instead of returning immediately.
 * That is a deliberate, bounded scope for "headless" — it does not turn this
 * into a background daemon; the process exits once the instance stops moving
 * on its own again, exactly as if a human were watching it.
 *
 * `attached: true` always — a one-shot CLI invocation has no standing session
 * identity to already "be" the owner of anything, so the crash-recovery
 * re-attach branch (resolveContinueAction's #5) is always reachable here,
 * which is the right default for a headless caller.
 *
 * `runnerDeps` is a test seam (real callers never pass it) — same shape as
 * `RunnerDeps` in engine/runner.ts, so a test can inject `createSession`/
 * `checkDeps` fakes to drive the "runs to the next stop" behavior without
 * API credentials, the same way runner.test.ts already does for the runner
 * itself.
 */
export async function runContinue(engine: Engine, explicit?: string, runnerDeps?: RunnerDeps): Promise<HeadlessResult> {
  const instances = engine.listInstances();
  if (instances.length === 0) return { code: 1, text: "没有活跃的工作流实例。" };

  let target = null as (typeof instances)[number] | null;
  if (explicit) {
    const wanted = String(explicit).trim();
    const exact = instances.filter((i) => i.id === wanted);
    const matches = exact.length > 0 ? exact : instances.filter((i) => i.id.startsWith(wanted));
    if (matches.length === 1) target = matches[0];
    else if (matches.length === 0) return { code: 1, text: `没有找到匹配 "${wanted}" 的实例。\n\n${engine.formatInstanceList(instances)}` };
    else return { code: 1, text: `前缀 "${wanted}" 匹配到 ${matches.length} 个实例，请提供更长的前缀：\n\n${engine.formatInstanceList(matches)}` };
  } else if (instances.length === 1) {
    target = instances[0];
  } else {
    return { code: 1, text: engine.formatInstanceList(instances, "存在多个实例，请指定要继续的实例：`ralphflow continue <实例ID>`（支持唯一前缀）。") };
  }

  const instId = target.id;
  const driver = engine.foreignRunnerPid(instId);
  if (driver) {
    return { code: 1, text: `实例 \`${instId}\` 正被另一个 ralph 进程（pid ${driver}）驱动。请在那个进程里操作它，或先结束该进程。` };
  }

  const sessionId = `ralphflow-headless-${process.pid}-${Date.now().toString(36)}`;
  let response: string;
  try {
    response = await withInstanceLock(engine.getInstanceDir(instId), instId, () =>
      resolveContinueAction(engine, instId, sessionId, /* attached */ true));
  } catch (e: any) {
    if (isInstanceGone(e)) return { code: 0, text: `实例 \`${instId}\` 已经不存在（可能刚被其他进程取消或完成）。` };
    return { code: 1, text: `继续失败：${e.message}` };
  }

  if (!engine.instanceExists(instId)) {
    return { code: 0, text: response };
  }

  // Drive it to its next stopping point — same bounded semantics as watching
  // it in an interactive session, just without a UI.
  const runner = createRunner(engine, {}, {
    skillPaths: () => loadSkillIndex(engine.getRalphFlowDir(), engine.getGlobalConfigHome()).paths,
    ...runnerDeps,
  });
  engine.setAbortActiveStep?.(runner.abortActiveStep);
  runner.ensureRunning(instId);
  await runner.idle();

  let outcome: string;
  if (!engine.instanceExists(instId)) {
    outcome = "工作流已完成。";
    const reports = fs.readdirSync(engine.getReportsDir()).filter((f) => f.startsWith(instId)).sort();
    if (reports.length > 0) outcome += `\n执行报告：${path.relative(engine.projectDir, path.join(engine.getReportsDir(), reports[reports.length - 1]))}`;
  } else if (engine.markerExists(MANUAL_GATE_MARKER, instId)) {
    outcome = "工作流到达人工审查门，等待审查。再次运行 `ralphflow continue` 通过。";
  } else {
    const finalState = engine.readState(instId);
    outcome = finalState?.paused
      ? `工作流再次暂停（${finalState.pause_reason || "未知原因"}）：${finalState.last_failure_reason || "（无详情）"}`
      : "工作流仍在运行中。";
  }

  return { code: 0, text: `${response}\n\n---\n\n${outcome}` };
}

/**
 * `ralphflow _check-once <workflow> <step> [task]` — run ONE real CHECK against the
 * current directory and print the verdict. Hidden and underscore-prefixed: it is
 * the vertical smoke test for the check path (real model, real sandbox) without
 * needing a whole workflow run. Creates a throwaway instance and destroys it.
 */
async function runCheckOnce(engine: Engine, args: string[]): Promise<HeadlessResult> {
  const [workflowName, stepId, ...taskParts] = args;
  if (!workflowName || !stepId) {
    return { code: 1, text: "用法：ralphflow _check-once <工作流> <步骤ID> [任务描述]" };
  }
  const problems: string[] = [];
  const workflow = engine.loadWorkflow(workflowName, problems);
  if (!workflow) return { code: 1, text: `工作流 "${workflowName}" 无法加载：${problems[0] || "未找到"}` };
  const step = engine.getStep(workflow, stepId);
  if (!step) return { code: 1, text: `工作流 "${workflowName}" 中没有步骤 "${stepId}"` };
  if (isSubWorkflowStep(step)) return { code: 1, text: `步骤 "${stepId}" 是子工作流步骤，没有 check 阶段` };

  const task = taskParts.join(" ") || "check-once 冒烟测试";
  const instId = engine.generateInstanceId(workflowName);
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, task);
  engine.writeState({
    active: true, workflow_name: workflowName, current_step: stepId, current_phase: "check",
    fail_count: 0, user_task: task, paused: false,
  }, instId);

  try {
    const prompt = engine.buildCheckPrompt(instId, step, task);
    process.stderr.write(`[check-once] 实例 ${instId}，模型 ${workflow.adversarial_check?.model || "默认"}\n`);
    const result = await adversarialCheck(
      engine, instId, step, prompt, task, workflow.adversarial_check,
      (line) => process.stderr.write(`[bash] ${line}\n`)
    );
    const verdict = result.infra ? "INFRA（验证未能运行，不计失败次数）" : result.passed ? "PASS" : "FAIL";
    return { code: result.passed ? 0 : 1, text: `## 检查结论：${verdict}\n\n${result.reason}` };
  } finally {
    engine.destroyInstance(instId, "cancelled");
  }
}

export async function runHeadless(verb: string, args: string[], cwd: string): Promise<HeadlessResult> {
  const engine = createEngine(cwd, { abortActiveCheck });
  switch (verb) {
    case "status": return runStatus(engine, args[0]);
    case "list": return runList(engine);
    case "doctor": return runDoctor(engine);
    case "cancel": return await runCancel(engine, args[0]);
    case "continue": return await runContinue(engine, args[0]);
    case "_check-once": return await runCheckOnce(engine, args);
    default:
      return { code: 1, text: `未知命令：${verb}\n\n可用命令：status、list、doctor、cancel、continue。不带命令运行 \`ralphflow\` 进入交互界面。` };
  }
}
