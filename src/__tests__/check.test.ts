/**
 * CHECK session behavior, driven by a scripted session instead of a real model.
 *
 * The contract under test is the one both plugin versions established:
 * `{ passed, infra?, reason }`, where `infra: true` means "the check could not
 * run" and must NOT burn the step's failure count. Getting that classification
 * wrong is expensive in opposite directions — a work failure misread as infra
 * loops forever, an infra failure misread as work burns the retry budget on a
 * problem the model cannot fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Engine } from "../engine/core.js";
import { adversarialCheck } from "../engine/check.js";
import type { NormalStepDef } from "../engine/types.js";
import type { SessionHandle, ToolDefinition } from "../pi/adapter.js";

let tmpDir: string;
let engine: Engine;
let INST: string;

const STEP: NormalStepDef = {
  id: "impl", desc: "implement", do: "write code", check: "does it build?",
  input: "spec.md", output: "code", on_pass: "done", on_fail: "impl", max_fail_count: 3,
};

/** Find a custom tool the check session was created with. */
function toolNamed(tools: ToolDefinition[] | undefined, name: string): any {
  return (tools ?? []).find((t) => t.name === name);
}

/**
 * A scripted stand-in for a verifier session. `script` runs when the check
 * prompt arrives and may call the injected tools; `followUpScript` runs if the
 * engine nudges for a missing verdict.
 */
function fakeSessionFactory(opts: {
  script?: (tools: ToolDefinition[]) => Promise<void> | void;
  followUpScript?: (tools: ToolDefinition[]) => Promise<void> | void;
  promptHangs?: boolean;
  createThrows?: string;
  onCreate?: (options: any) => void;
}) {
  const calls = { prompts: [] as string[], followUps: [] as string[], aborted: false, disposed: false };
  const factory = async (options: any): Promise<SessionHandle> => {
    opts.onCreate?.(options);
    if (opts.createThrows) throw new Error(opts.createThrows);
    const tools: ToolDefinition[] = options.customTools ?? [];
    return {
      jsonlPath: "/tmp/fake-check.jsonl",
      async prompt(text: string) {
        calls.prompts.push(text);
        if (opts.promptHangs) await new Promise(() => {}); // never settles
        await opts.script?.(tools);
      },
      async followUp(text: string) {
        calls.followUps.push(text);
        await opts.followUpScript?.(tools);
      },
      async steer() {},
      subscribe() { return () => {}; },
      async abort() { calls.aborted = true; },
      dispose() { calls.disposed = true; },
    };
  };
  return { factory, calls };
}

/** Invoke a defineTool-produced tool the way the agent runtime would. */
async function callTool(tool: any, params: unknown): Promise<any> {
  return tool.execute("call-1", params, undefined, undefined, {} as any);
}

function startInstance(): string {
  const instId = engine.generateInstanceId("test-wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  engine.writeState({
    active: true, workflow_name: "test-wf", current_step: "impl", current_phase: "check",
    fail_count: 0, user_task: "task", paused: false,
  }, instId);
  INST = instId;
  return instId;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-check-test-"));
  engine = createEngine(tmpDir, {}) as Engine;
  startInstance();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("verdict tool", () => {
  it("passes through pass=true and the reason", async () => {
    const { factory } = fakeSessionFactory({
      script: async (tools) => { await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "构建通过，测试 12/12 绿" }); },
    });
    const result = await adversarialCheck(engine, INST, STEP, "check prompt", "task", undefined, undefined, { createSession: factory });
    expect(result.passed).toBe(true);
    expect(result.infra).toBeUndefined();
    expect(result.reason).toBe("构建通过，测试 12/12 绿");
  });

  it("passes through pass=false as a WORK failure, not infra", async () => {
    const { factory } = fakeSessionFactory({
      script: async (tools) => { await callTool(toolNamed(tools, "verdict"), { pass: false, reason: "3 个测试失败" }); },
    });
    const result = await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(result.passed).toBe(false);
    expect(result.infra).toBeUndefined(); // must burn a fail count
    expect(result.reason).toBe("3 个测试失败");
  });

  it("truncates a runaway reason", async () => {
    const { factory } = fakeSessionFactory({
      script: async (tools) => { await callTool(toolNamed(tools, "verdict"), { pass: false, reason: "x".repeat(6000) }); },
    });
    const result = await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(result.reason.length).toBeLessThanOrEqual(5003);
    expect(result.reason.endsWith("...")).toBe(true);
  });

  it("substitutes a default reason when the verifier gives none", async () => {
    const { factory } = fakeSessionFactory({
      script: async (tools) => { await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "" }); },
    });
    const result = await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(result.passed).toBe(true);
    expect(result.reason).toBe("检查通过。");
  });
});

describe("missing verdict", () => {
  it("nudges once, and accepts a verdict submitted on the nudge", async () => {
    const { factory, calls } = fakeSessionFactory({
      script: () => {}, // says nothing
      followUpScript: async (tools) => { await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "补交结论" }); },
    });
    const result = await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(calls.followUps.length).toBe(1);
    expect(calls.followUps[0]).toContain("verdict");
    expect(result.passed).toBe(true);
    expect(result.reason).toBe("补交结论");
  });

  it("classifies a still-missing verdict as infra, never as a work failure", async () => {
    const { factory, calls } = fakeSessionFactory({ script: () => {}, followUpScript: () => {} });
    const result = await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(calls.followUps.length).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.infra).toBe(true); // must NOT burn a fail count
    expect(result.reason).toContain("没有提交结论");
  });
});

describe("infra failures", () => {
  it("session creation failure is infra", async () => {
    const { factory } = fakeSessionFactory({ createThrows: "no API key configured" });
    const result = await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(result.infra).toBe(true);
    expect(result.reason).toContain("验证会话创建失败");
    expect(result.reason).toContain("no API key configured");
  });

  it("timeout aborts the session and reports infra with guidance", async () => {
    vi.useFakeTimers();
    try {
      const { factory, calls } = fakeSessionFactory({ promptHangs: true });
      const promise = adversarialCheck(engine, INST, STEP, "p", "task", { timeout_ms: 1000 }, undefined, { createSession: factory });
      await vi.advanceTimersByTimeAsync(1500);
      const result = await promise;
      expect(result.infra).toBe(true);
      expect(result.reason).toContain("检查阶段超时");
      expect(calls.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cancelled instance short-circuits before any session is created", async () => {
    let created = false;
    const { factory } = fakeSessionFactory({ onCreate: () => { created = true; } });
    engine.destroyInstance(INST, "cancelled");
    const result = await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(created).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("已被取消");
  });

  it("missing extra_dirs is infra, so continue can re-verify for free", async () => {
    engine.writeExtraDirs(INST, [path.join(tmpDir, "gone")]);
    const { factory } = fakeSessionFactory({});
    const result = await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(result.infra).toBe(true);
    expect(result.reason).toContain("extra_dirs");
  });
});

describe("session wiring", () => {
  it("gives the verifier only check_bash and verdict as custom tools", async () => {
    let seen: any;
    const { factory } = fakeSessionFactory({
      onCreate: (options) => { seen = options; },
      script: async (tools) => { await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "ok" }); },
    });
    await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect((seen.customTools as ToolDefinition[]).map((t) => t.name).sort()).toEqual(["check_bash", "verdict"]);
    // createCheckSession itself pins the read-only built-ins; the caller must not
    // be able to widen them from here.
    expect(seen.tools).toBeUndefined();
  });

  it("uses the workflow's system_prompt override when given", async () => {
    let seen: any;
    const { factory } = fakeSessionFactory({
      onCreate: (o) => { seen = o; },
      script: async (tools) => { await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "ok" }); },
    });
    await adversarialCheck(engine, INST, STEP, "p", "task", { system_prompt: "你是挑剔的审查员" }, undefined, { createSession: factory });
    expect(seen.systemPrompt).toBe("你是挑剔的审查员");
  });

  it("records and clears the adversarial session marker", async () => {
    const { factory } = fakeSessionFactory({
      script: async (tools) => {
        // Mid-check the marker must be set so a cross-process cancel can find it.
        expect(engine.readAdversarialSession(INST)).toBe("/tmp/fake-check.jsonl");
        await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "ok" });
      },
    });
    await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(engine.readAdversarialSession(INST)).toBeNull();
  });

  it("disposes the session on every path", async () => {
    const { factory, calls } = fakeSessionFactory({ script: () => {}, followUpScript: () => {} });
    await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(calls.disposed).toBe(true);
  });
});

describe("check_bash tool inside the check session", () => {
  it("executes an allow-listed command", async () => {
    let output = "";
    const { factory } = fakeSessionFactory({
      script: async (tools) => {
        const result = await callTool(toolNamed(tools, "check_bash"), { command: "echo verified" });
        output = result.content[0].text;
        await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "ok" });
      },
    });
    await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(output).toContain("verified");
  });

  it("refuses a mutating command and tells the verifier why", async () => {
    let result: any;
    const { factory } = fakeSessionFactory({
      script: async (tools) => {
        result = await callTool(toolNamed(tools, "check_bash"), { command: "rm -rf src" });
        await callTool(toolNamed(tools, "verdict"), { pass: false, reason: "ok" });
      },
    });
    await adversarialCheck(engine, INST, STEP, "p", "task", undefined, undefined, { createSession: factory });
    expect(result.details.denied).toBe(true);
    expect(result.content[0].text).toContain("被拒绝");
    expect(result.content[0].text).toContain("只读验证者");
  });

  it("reports bash activity to the caller for rendering", async () => {
    const events: string[] = [];
    const { factory } = fakeSessionFactory({
      script: async (tools) => {
        await callTool(toolNamed(tools, "check_bash"), { command: "echo x" });
        await callTool(toolNamed(tools, "check_bash"), { command: "rm x" });
        await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "ok" });
      },
    });
    await adversarialCheck(engine, INST, STEP, "p", "task", undefined, (line) => events.push(line), { createSession: factory });
    expect(events).toEqual(["run: echo x", "denied: rm x"]);
  });

  it("threads adversarial_check.extra_allowed_bash into check_bash — a custom CLI opted in by the workflow becomes runnable", async () => {
    let output = "";
    const { factory } = fakeSessionFactory({
      script: async (tools) => {
        const result = await callTool(toolNamed(tools, "check_bash"), { command: "./scripts/check.sh --verify" });
        output = result.content[0].text;
        await callTool(toolNamed(tools, "verdict"), { pass: true, reason: "ok" });
      },
    });
    await adversarialCheck(
      engine, INST, STEP, "p", "task",
      { extra_allowed_bash: ["./scripts/check.sh *"] },
      undefined, { createSession: factory },
    );
    // The fixture project has no such script — the assertion that matters is
    // that the whitelist let it THROUGH to actually spawn (a real ENOENT/
    // shell error), not the built-in "命令不在只读白名单内" refusal.
    expect(output).not.toContain("不在只读白名单内");
  });

  it("does not let extra_allowed_bash reopen a permanently banned command", async () => {
    let result: any;
    const { factory } = fakeSessionFactory({
      script: async (tools) => {
        result = await callTool(toolNamed(tools, "check_bash"), { command: "rm -rf src" });
        await callTool(toolNamed(tools, "verdict"), { pass: false, reason: "ok" });
      },
    });
    await adversarialCheck(
      engine, INST, STEP, "p", "task",
      { extra_allowed_bash: ["rm *"] },
      undefined, { createSession: factory },
    );
    expect(result.details.denied).toBe(true);
  });
});
