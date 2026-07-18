/**
 * M3 acceptance: the real built-in spec.yaml, all seven steps, start to finish,
 * driven by scripted sessions.
 *
 * The unit tests each pin one rule; this one asks the question a user asks —
 * "does `/ralphflow-start spec` actually run to 工作流完成?" — against the
 * shipped workflow rather than a fixture. It also covers the crash path, which
 * only means anything end-to-end: kill the process mid-step, start a new engine
 * over the same directory, and continue.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Engine } from "../engine/core.js";
import { createRunner } from "../engine/runner.js";
import { createTools } from "../commands/tools.js";
import type { ToolDefinition } from "../pi/adapter.js";
import { createFakeAdapter, createFakeCheckAdapter } from "./fake-adapter.js";

let tmpDir: string;
const SESSION = "sess-main";

const SPEC_STEPS = ["propose", "specs", "design", "tasks", "implement", "verify", "archive"];

function newEngine(): Engine {
  return createEngine(tmpDir, {}) as Engine;
}

/**
 * ralphflow_start/continue now attach the run view (ctx.ui.custom) once the
 * instance is running. This suite is about the state machine driving the
 * real spec.yaml to completion, not the run view itself, so the fake
 * bypasses the factory and resolves as if the user immediately detached —
 * ralphflow_start/continue return right away, exactly like before this
 * feature existed, and the assertions below drive/observe progress the same
 * way they always did (`runner.idle()`).
 */
function fakeCtx(): any {
  return { ui: { custom: async (_factory: unknown) => ({ outcome: "detached" }) } };
}

async function callTool(tools: ToolDefinition[], name: string, params: unknown = {}): Promise<string> {
  const tool = tools.find((t) => t.name === name)!;
  const result: any = await (tool as any).execute("c1", params, undefined, undefined, fakeCtx());
  return result.content[0].text;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-spec-e2e-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("spec.yaml end to end", () => {
  it("runs all seven steps and completes", async () => {
    const engine = newEngine();
    const messages: string[] = [];
    const doAdapter = createFakeAdapter({ turns: [{ toolCalls: [{ name: "some_work" }] }, { done: true }] });
    const checkAdapter = createFakeCheckAdapter([{ pass: true, reason: "verified" }]);
    const runner = createRunner(engine, { onMessage: (_i, t) => messages.push(t) }, {
      createSession: doAdapter.createSession,
      checkDeps: { createSession: checkAdapter.createSession },
    });
    const tools = createTools({ engine, runner, getSessionId: () => SESSION });

    const started = await callTool(tools, "ralphflow_start", { workflow: "spec", task: "加一个登录接口" });
    expect(started).toContain("已启动");
    const instId = engine.listInstances()[0].id;

    await runner.idle();

    // Every step ran, in order, each in its own session.
    const stepDirs = doAdapter.sessions.map((s) => path.basename(s.sessionDir!));
    expect(stepDirs).toEqual(SPEC_STEPS.map((s) => `${s}-do-1`));
    expect(checkAdapter.count).toBe(7);

    // Finished: instance gone, report archived, artifacts kept.
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
    expect(messages.join("\n")).toContain("工作流完成");
    const report = fs.readdirSync(engine.getReportsDir()).find((f) => f.startsWith(instId))!;
    const reportText = fs.readFileSync(path.join(engine.getReportsDir(), report), "utf-8");
    expect(reportText).toContain("已完成");
    for (const step of SPEC_STEPS) expect(reportText).toContain(step);
  });

  it("each step's DO prompt carries that step's task and nothing from the last step", async () => {
    // The whole reason this project exists: step N must not inherit step N-1's
    // context. The only channel between steps is the artifacts dir + the
    // input/output fields, both of which live in the prompt.
    const engine = newEngine();
    const doAdapter = createFakeAdapter({ turns: [{ done: true }] });
    const runner = createRunner(engine, {}, {
      createSession: doAdapter.createSession,
      checkDeps: { createSession: createFakeCheckAdapter([{ pass: true }]).createSession },
    });
    const tools = createTools({ engine, runner, getSessionId: () => SESSION });
    await callTool(tools, "ralphflow_start", { workflow: "spec", task: "加一个登录接口" });
    await runner.idle();

    const proposePrompt = doAdapter.sessions[0].prompts[0];
    const specsPrompt = doAdapter.sessions[1].prompts[0];

    expect(proposePrompt).toContain("proposal.md");
    expect(specsPrompt).toContain("specs.md");
    // The specs session is a clean context: it was told to read proposal.md,
    // it was not handed the propose session's conversation.
    expect(specsPrompt).toContain("delta-spec");
    expect(specsPrompt).not.toContain("变更概述（为什么做、做什么）"); // propose's own instructions
    // Both still carry the user's original task and the shared artifacts dir.
    expect(proposePrompt).toContain("加一个登录接口");
    expect(specsPrompt).toContain("加一个登录接口");
    expect(specsPrompt).toContain(".ralph-flow/artifacts/");
  });

  it("survives a crash mid-step: a new process resumes the same instance", async () => {
    // Process 1: start, then die during the first step (hung model).
    const engine1 = newEngine();
    const runner1 = createRunner(engine1, {}, {
      createSession: createFakeAdapter({ turns: [{ hangs: true }] }).createSession,
      checkDeps: { createSession: createFakeCheckAdapter(["silent"]).createSession },
    });
    const tools1 = createTools({ engine: engine1, runner: runner1, getSessionId: () => SESSION });
    await callTool(tools1, "ralphflow_start", { workflow: "spec", task: "加一个登录接口" });
    const instId = engine1.listInstances()[0].id;
    await new Promise((r) => setTimeout(r, 20));
    runner1.pauseAllForShutdown(); // the SIGINT path

    expect(engine1.readState(instId)!.pause_reason).toBe("session_aborted");
    expect(engine1.readRunnerPid(instId)).toBeNull(); // the dead process released it

    // Process 2: a fresh engine over the same directory continues.
    const engine2 = newEngine();
    const doAdapter2 = createFakeAdapter({ turns: [{ done: true }] });
    const runner2 = createRunner(engine2, {}, {
      createSession: doAdapter2.createSession,
      checkDeps: { createSession: createFakeCheckAdapter([{ pass: true }]).createSession },
    });
    const tools2 = createTools({ engine: engine2, runner: runner2, getSessionId: () => SESSION });

    const resumed = await callTool(tools2, "ralphflow_continue");
    expect(resumed).toContain("工作流已恢复");
    await runner2.idle();

    // It picked up at propose and ran the rest of the workflow to the end.
    expect(doAdapter2.sessions[0].sessionDir).toContain("propose-do-");
    expect(fs.existsSync(engine2.getInstanceDir(instId))).toBe(false);
  });

  it("a failing step retries, then the workflow finishes when it passes", async () => {
    const engine = newEngine();
    const messages: string[] = [];
    // propose fails its check once (max_fail_count 3), then everything passes.
    const checkAdapter = createFakeCheckAdapter([
      { pass: false, reason: "验收标准缺失" },
      { pass: true, reason: "ok" },
    ]);
    const runner = createRunner(engine, { onMessage: (_i, t) => messages.push(t) }, {
      createSession: createFakeAdapter({ turns: [{ done: true }] }).createSession,
      checkDeps: { createSession: checkAdapter.createSession },
    });
    const tools = createTools({ engine, runner, getSessionId: () => SESSION });
    await callTool(tools, "ralphflow_start", { workflow: "spec", task: "t" });
    await runner.idle();

    const all = messages.join("\n");
    // The in-budget retry is an ordinary silent transition, not a "needs you"
    // moment — only the eventual terminal outcome reaches chat.
    expect(all).not.toContain("失败 ✗ (1/3)");
    expect(all).not.toContain("验收标准缺失");
    expect(all).toContain("工作流完成");
    // propose ran twice (retry), so 8 DO sessions for 7 steps.
    expect(checkAdapter.count).toBe(8);
  });
});
