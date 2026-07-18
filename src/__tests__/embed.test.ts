/**
 * runInstanceInTui / attachRunView — the chat-embedded takeover mechanism.
 *
 * Exercised against a REAL pi-tui TUI (with an in-memory fake Terminal), not
 * a hand-rolled stub of it, so the actual Container/Input/focus wiring in
 * run-view.ts is what's under test. The three outcomes
 * (completed/cancelled/detached) are exactly what a chat tool call
 * (ralphflow_start/continue/watch) needs to decide what to tell the model.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Engine } from "../engine/core.js";
import { createRunner } from "../engine/runner.js";
import { createFakeAdapter, createFakeCheckAdapter } from "./fake-adapter.js";
import { createFakeTerminal, typeInto } from "./fake-terminal.js";
import { runInstanceInTui } from "../tui/run-app.js";
import { attachRunView, type UiCustomHost } from "../tui/embed.js";
import { TUI, type Component } from "../pi/tui.js";

let tmpDir: string;
let engine: Engine;

const ONE_STEP_WF = `
description: test workflow
steps:
  - id: one
    desc: only step
    do: do one
    check: check one
    input: user input
    output: "out1.md"
    on_pass: done
    on_fail: one
    max_fail_count: 3
`;

function writeWorkflow(): void {
  const dir = path.join(tmpDir, ".ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test-wf.yaml"), ONE_STEP_WF);
}

function startInstance(): string {
  const wf = engine.loadWorkflow("test-wf")!;
  const instId = engine.generateInstanceId("test-wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "test task");
  engine.writeState({
    active: true, workflow_name: "test-wf", current_step: wf.steps[0].id, current_phase: "do",
    fail_count: 0, user_task: "test task", paused: false, session_id: "sess-1",
  }, instId);
  return instId;
}

function makeTui(): TUI {
  const tui = new TUI(createFakeTerminal());
  tui.start();
  return tui;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-embed-test-"));
  engine = createEngine(tmpDir, {}) as Engine;
  writeWorkflow();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runInstanceInTui outcomes", () => {
  it("resolves 'completed' once the user acknowledges the finished screen", async () => {
    // Reaching a terminal state does not resolve the promise by itself — the
    // run view stays on the "✓ 完成" screen (with the report path) until the
    // user leaves it, same as the standalone run-app.ts always worked. Esc
    // on that screen is what actually finishes.
    const instId = startInstance();
    const doAdapter = createFakeAdapter({ turns: [{ done: true }] });
    const checkAdapter = createFakeCheckAdapter([{ pass: true, reason: "ok" }]);
    const runner = createRunner(engine, {}, {
      createSession: doAdapter.createSession,
      checkDeps: { createSession: checkAdapter.createSession },
    });
    const tui = makeTui();

    const pending = runInstanceInTui({ engine, tui, sessionId: "sess-1", instId, runner });
    await new Promise((r) => setTimeout(r, 20)); // let the workflow finish and the model reach "completed"

    tui.handleInput("\x1b");

    const result = await pending;
    expect(result.outcome).toBe("completed");
    expect(result.reportPath).toBeTruthy();
  });

  it("resolves 'cancelled' when /ralphflow-cancel is typed into the persistent input", async () => {
    const instId = startInstance();
    const runner = createRunner(engine, {}, {
      createSession: createFakeAdapter({ turns: [{ hangs: true }] }).createSession,
      checkDeps: { createSession: createFakeCheckAdapter(["silent"]).createSession },
    });
    const tui = makeTui();

    const pending = runInstanceInTui({ engine, tui, sessionId: "sess-1", instId, runner });
    await new Promise((r) => setTimeout(r, 20)); // let the view mount and the DO turn start hanging

    typeInto(tui, "/ralphflow-cancel");
    tui.handleInput("\r");

    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    expect(engine.instanceExists(instId)).toBe(false);
  });

  it("resolves 'detached' on Esc with an empty input, leaving the instance untouched", async () => {
    const instId = startInstance();
    const runner = createRunner(engine, {}, {
      createSession: createFakeAdapter({ turns: [{ hangs: true }] }).createSession,
      checkDeps: { createSession: createFakeCheckAdapter(["silent"]).createSession },
    });
    const tui = makeTui();

    const pending = runInstanceInTui({ engine, tui, sessionId: "sess-1", instId, runner });
    await new Promise((r) => setTimeout(r, 20));

    tui.handleInput("\x1b"); // bare Esc, empty draft

    const result = await pending;
    expect(result.outcome).toBe("detached");
    // Detaching must not pause/cancel/abort anything — the instance is
    // exactly as active as it was before the takeover.
    expect(engine.instanceExists(instId)).toBe(true);
    expect(engine.readState(instId)!.active).toBe(true);
    expect(engine.readState(instId)!.paused).toBe(false);

    runner.pauseAllForShutdown(); // test cleanup, not part of the assertion
  });
});

describe("reattaching to a live instance", () => {
  it("shows the current step/phase immediately on mount, not a blank pane (the primeForAttach fix)", async () => {
    // Regression coverage for: detach mid-DO, then reattach (ralphflow_watch /
    // the main agent landing back in the view) — buildInitialModel used to
    // leave activeStepId null until the next runner event happened to fire,
    // which for a genuine reattach may be a long silent stretch away. The
    // screen is grabbed BEFORE any new event has a chance to fire, to prove
    // the content comes from buildInitialModel itself, not a lucky race.
    const instId = startInstance();
    const runner = createRunner(engine, {}, {
      createSession: createFakeAdapter({ turns: [{ hangs: true }] }).createSession,
      checkDeps: { createSession: createFakeCheckAdapter(["silent"]).createSession },
    });
    const tui = makeTui();

    const first = runInstanceInTui({ engine, tui, sessionId: "sess-1", instId, runner });
    await new Promise((r) => setTimeout(r, 20)); // let the DO step actually start
    tui.handleInput("\x1b"); // detach, empty input
    expect((await first).outcome).toBe("detached");

    // Reattach: a fresh runInstanceInTui call against the SAME still-running
    // instance — exactly what ralphflow_watch does.
    const second = runInstanceInTui({ engine, tui, sessionId: "sess-1", instId, runner });
    const screen = tui.children.find((c): c is Component & { scrollBack: number } => "scrollBack" in (c as object));
    expect(screen).toBeDefined();
    const lines = screen!.render(100).join("\n");
    expect(lines).toContain("only step"); // the active step's desc
    expect(lines).toMatch(/DO/); // active phase tag — proves activePhase isn't null

    runner.pauseAllForShutdown();
    tui.handleInput("\x1b");
    await second;
  });
});

describe("attachRunView", () => {
  it("saves the chat's root components, takes over, and restores them after close()", async () => {
    const instId = startInstance();
    const runner = createRunner(engine, {}, {
      createSession: createFakeAdapter({ turns: [{ done: true }] }).createSession,
      checkDeps: { createSession: createFakeCheckAdapter([{ pass: true }]).createSession },
    });
    const tui = makeTui();

    // Stand-ins for InteractiveMode's header/chat/editor/footer containers.
    const chatChrome: Component[] = [
      { render: () => ["header"], invalidate() {} },
      { render: () => ["chat transcript"], invalidate() {} },
      { render: () => ["editor"], invalidate() {} },
    ];
    for (const c of chatChrome) tui.addChild(c);

    // A minimal stand-in for Pi's real showExtensionCustom: invoke the
    // factory with our real tui, and resolve when it calls `done()` — same
    // contract embed.ts relies on (factory must not settle before done()).
    const ctx: UiCustomHost = {
      ui: {
        custom: (factory) => new Promise((resolve) => {
          void Promise.resolve(factory(tui, undefined, undefined, (result) => resolve(result)));
        }),
      },
    };

    const pending = attachRunView(ctx, engine, runner, "sess-1", instId);
    await new Promise((r) => setTimeout(r, 20));
    tui.handleInput("\x1b"); // acknowledge the "✓ 完成" screen — see the outcomes test above

    const result = await pending;
    expect(result.outcome).toBe("completed");
    // The chat's own chrome is back, same objects, same order — not just
    // "some children exist".
    expect(tui.children).toEqual(chatChrome);
  });
});
