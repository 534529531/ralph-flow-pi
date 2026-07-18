/**
 * The TUI extension's registration surface.
 *
 * This exists because the bug it guards against is silent. Pi's InlineExtension
 * is `{ name, factory }`; an extension exported as `{ name, activate }` loads
 * without error, prints no warning, and simply never runs — the TUI comes up
 * looking perfect with zero ralphflow tools and zero slash commands. Nothing
 * else in the suite would notice.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Engine } from "../engine/core.js";
import { createRalphExtension, labelInstanceMessage } from "../tui/extension.js";
import { COMMAND_PROMPTS } from "../commands/prompts.js";
import type { InstanceInfo, RalphFlowState } from "../engine/types.js";

let tmpDir: string;
let engine: Engine;

/**
 * A stand-in for pi's ExtensionAPI that records what got registered.
 *
 * `on` records handlers by event name rather than invoking them — matches
 * the real ExtensionAPI, where `factory(api)` only *registers* "session_start"
 * and pi fires it later, separately, once an ExtensionContext (with `.ui`)
 * actually exists. See extension.ts's interface comment for why `ui` is on
 * that later context and NOT on `api` itself — conflating the two is exactly
 * the bug this split guards against.
 */
function fakeApi() {
  const tools: any[] = [];
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const messages: Array<{ content: string; triggerTurn?: boolean }> = [];
  const userMessages: string[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  return {
    tools, commands, messages, userMessages, handlers,
    api: {
      registerTool: (t: any) => tools.push(t),
      registerCommand: (name: string, opts: any) => commands.set(name, opts),
      sendMessage: (m: any, o?: any) => messages.push({ content: m.content, triggerTurn: o?.triggerTurn }),
      sendUserMessage: (c: string) => userMessages.push(c),
      on: (event: string, handler: (event: any, ctx: any) => void) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
    },
  };
}

/** Fires the recorded "session_start" handlers with a fake ExtensionContext. */
interface FakeSessionStartCtx {
  mode: string;
  ui: {
    setEditorComponent(factory: unknown): void;
    setHeader?(factory: unknown): void;
  };
}
function fireSessionStart(f: ReturnType<typeof fakeApi>, ctx: FakeSessionStartCtx): void {
  const ui = { setHeader: () => {}, ...ctx.ui };
  for (const h of f.handlers.get("session_start") ?? []) h({ type: "session_start", reason: "startup" }, { ...ctx, ui });
}

function activate(ext: ReturnType<typeof createRalphExtension>, api: any) {
  // Exercise the real shape pi calls: extension.factory(api).
  (ext.extension as any).factory(api);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-ext-test-"));
  engine = createEngine(tmpDir, {}) as Engine;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("inline extension shape", () => {
  it("is { name, factory } — the shape pi actually loads", () => {
    const ext = createRalphExtension(engine, () => "sess-1").extension as any;
    expect(ext.name).toBe("ralph-flow");
    expect(typeof ext.factory).toBe("function");
  });
});

describe("registration", () => {
  it("registers all seven ralphflow tools", () => {
    const f = fakeApi();
    activate(createRalphExtension(engine, () => "sess-1"), f.api);
    expect(f.tools.map((t) => t.name).sort()).toEqual([
      "ralphflow_cancel", "ralphflow_continue", "ralphflow_doctor",
      "ralphflow_list", "ralphflow_start", "ralphflow_status", "ralphflow_watch",
    ]);
  });

  it("registers all eight slash commands under their original names", () => {
    const f = fakeApi();
    activate(createRalphExtension(engine, () => "sess-1"), f.api);
    expect([...f.commands.keys()].sort()).toEqual([
      "ralphflow-cancel", "ralphflow-continue", "ralphflow-create",
      "ralphflow-doctor", "ralphflow-list", "ralphflow-start", "ralphflow-status", "ralphflow-watch",
    ]);
    for (const [, cmd] of f.commands) expect(cmd.description).toBeTruthy();
  });

  it("wires the runner and the engine's abort seam", () => {
    const f = fakeApi();
    const ext = createRalphExtension(engine, () => "sess-1");
    activate(ext, f.api);
    expect(ext.runner).toBeTruthy();
    // destroyInstance must be able to abort a DO session in this process.
    expect(typeof ext.runner.abortActiveStep).toBe("function");
  });

  it("registers a real 'session_start' listener — a renamed/misspelled event string would silently leave Up-arrow recall broken", () => {
    const f = fakeApi();
    activate(createRalphExtension(engine, () => "sess-1"), f.api);
    expect(f.handlers.has("session_start")).toBe(true);
    expect(f.handlers.get("session_start")!.length).toBeGreaterThan(0);
  });

  it("installs the history-completing editor in tui mode", () => {
    const f = fakeApi();
    activate(createRalphExtension(engine, () => "sess-1"), f.api);
    let editorComponent: unknown;
    fireSessionStart(f, { mode: "tui", ui: { setEditorComponent: (factory) => { editorComponent = factory; } } });
    expect(typeof editorComponent).toBe("function");
  });

  it("does not touch the editor outside tui mode (rpc/print have no terminal UI to replace)", () => {
    const f = fakeApi();
    activate(createRalphExtension(engine, () => "sess-1"), f.api);
    let called = false;
    fireSessionStart(f, { mode: "rpc", ui: { setEditorComponent: () => { called = true; } } });
    expect(called).toBe(false);
  });

  it("installs the branded welcome header in tui mode, wired to this engine's own listWorkflows", () => {
    const f = fakeApi();
    activate(createRalphExtension(engine, () => "sess-1"), f.api);
    let headerFactory: unknown;
    fireSessionStart(f, {
      mode: "tui",
      ui: { setEditorComponent: () => {}, setHeader: (factory) => { headerFactory = factory; } },
    });
    expect(typeof headerFactory).toBe("function");
  });

});

describe("slash commands", () => {
  it("hand their template to the model rather than calling tools directly", async () => {
    const f = fakeApi();
    activate(createRalphExtension(engine, () => "sess-1"), f.api);
    await f.commands.get("ralphflow-start")!.handler("spec 做个登录", {});
    expect(f.userMessages.length).toBe(1);
    expect(f.userMessages[0]).toContain("spec 做个登录");
    expect(f.userMessages[0]).toContain("ralphflow_start");
  });

  it("substitute a placeholder when invoked bare, so the model asks", async () => {
    const f = fakeApi();
    activate(createRalphExtension(engine, () => "sess-1"), f.api);
    await f.commands.get("ralphflow-start")!.handler("", {});
    expect(f.userMessages[0]).toContain("（未提供）");
    expect(f.userMessages[0]).toContain("ask the user");
  });
});

describe("command prompts", () => {
  it("never tell the chat model to execute steps or emit a done tag", () => {
    // The main session is a control surface. If these instructions survived the
    // port, the chat model would start doing the work in the one context window
    // this whole design exists to keep clean.
    for (const [name, tmpl] of Object.entries(COMMAND_PROMPTS)) {
      const text = tmpl.render("x");
      expect(text, `${name} must not mention the promise tag`).not.toContain("<promise>");
      expect(text, `${name} must not mention the check tag`).not.toContain("<promise-check>");
    }
  });

  it("start explains that steps run in separate fresh sessions", () => {
    const text = COMMAND_PROMPTS["ralphflow-start"].render("x");
    expect(text).toContain("You do not execute the steps");
    expect(text).toContain("fresh AI session");
    expect(text).toContain("report_done");
  });

  it("start forbids the main agent from polling status or reading internals", () => {
    // Regression guard: an earlier version said "keep the user informed", and the
    // model read that as license to call ralphflow_status 100+ times and tail the
    // engine's own log files in a loop. The engine is autonomous; the chat model
    // must fire-and-forget.
    const text = COMMAND_PROMPTS["ralphflow-start"].render("x");
    expect(text).toContain("Do NOT poll");
    expect(text).toContain("ralphflow_status");
    expect(text).toContain(".ralph-flow/");
    expect(text).toContain("wait silently");
    // The phrasing that caused the bug must be gone.
    expect(text).not.toContain("keep the user informed");
  });

  it("continue also tells the agent to stop, not poll, after resuming", () => {
    const text = COMMAND_PROMPTS["ralphflow-continue"].render("x");
    expect(text).toContain("Do NOT poll");
  });

  it("create teaches the real schema, including fresh-context handoff", () => {
    const text = COMMAND_PROMPTS["ralphflow-create"].render("x");
    expect(text).toContain("max_fail_count");
    expect(text).toContain("manual_step");
    expect(text).toContain("{{artifacts_dir}}");
    expect(text).toContain(".ralph-flow/workflows/");
    expect(text).toContain("Every step gets a fresh context window");
    expect(text).not.toContain(".opencode/");
  });

  it("doctor's fix table covers the fields this engine reinterprets", () => {
    const text = COMMAND_PROMPTS["ralphflow-doctor"].render("x");
    expect(text).toContain("adversarial_check.agent");
    expect(text).toContain("bare name");
  });
});

describe("labelInstanceMessage", () => {
  function info(id: string, workflow: string): InstanceInfo {
    const state: RalphFlowState = {
      active: true, workflow_name: workflow, current_step: "one", current_phase: "do",
      fail_count: 0, user_task: "t", paused: false,
    };
    return { id, state, owner: "sess-1", manualGate: false, doneReported: false, lastActivity: null };
  }

  it("passes the text through unchanged when only one instance is active — the common case", () => {
    const instances = [info("a1", "spec")];
    expect(labelInstanceMessage(instances, "a1", "📋 步骤完成，等待审查。")).toBe("📋 步骤完成，等待审查。");
  });

  it("passes the text through unchanged with no active instances at all", () => {
    expect(labelInstanceMessage([], "a1", "hello")).toBe("hello");
  });

  it("prefixes with the workflow name and instance id once several instances are active — so concurrent gate/pause messages are attributable", () => {
    const instances = [info("a1", "spec"), info("b2", "loop")];
    const out = labelInstanceMessage(instances, "b2", "📋 步骤完成，等待审查。");
    expect(out).toContain("loop");
    expect(out).toContain("b2");
    expect(out).toContain("📋 步骤完成，等待审查。");
  });

  it("falls back to the bare instance id if it's not in the list (e.g. destroyed between the event and the lookup)", () => {
    const instances = [info("a1", "spec"), info("b2", "loop")];
    const out = labelInstanceMessage(instances, "gone-3", "text");
    expect(out).toContain("gone-3");
  });
});
