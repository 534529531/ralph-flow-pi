/**
 * Adapter contract tests — the upgrade gate for the pinned Pi version.
 *
 * Pi is on 0.x and ships often. These lock down the facts this package's
 * correctness (and its read-only guarantee) depends on, so a version bump that
 * changes them fails here instead of in production. Nothing here needs API
 * credentials: sessions are created but never prompted.
 *
 * Two of these encode bugs that already bit during M2:
 *  - DefaultResourceLoader requires agentDir (an `as any` cast hid it, and every
 *    check crashed with a "cannot read 'startsWith' of undefined").
 *  - `tools` is an allowlist over custom tools too, so a custom tool that isn't
 *    named there is silently inactive — a check session with no verdict tool
 *    looks exactly like a permanent infra failure.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Type } from "typebox";
import {
  CODING_TOOL_NAMES,
  CURRENT_SESSION_VERSION,
  READ_ONLY_TOOL_NAMES,
  createCheckSession,
  createStepSession,
  defineTool,
  findSessionFile,
  piVersion,
  resolveModel,
} from "../pi/adapter.js";

let tmpDir: string;

const probeTool = defineTool({
  name: "probe_tool",
  label: "Probe",
  description: "test probe",
  parameters: Type.Object({ x: Type.String() }),
  execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
});

/**
 * A minimal but real Pi transcript, so resume can be tested without a model
 * call. If a Pi upgrade changes the session header shape, SessionManager.open
 * will reject this and the resume test fails — which is the point.
 */
function writeSyntheticTranscript(dir: string, cwd: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "2026-01-01T00-00-00-000Z_synthetic-session-id.jsonl");
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "synthetic-session-id",
    timestamp: new Date().toISOString(),
    cwd,
  };
  fs.writeFileSync(file, JSON.stringify(header) + "\n");
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-adapter-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("read-only guarantee", () => {
  it("the check tool set excludes every mutating built-in", () => {
    // If a Pi upgrade renames these, the verifier could silently gain write
    // access to the workspace it is judging.
    for (const forbidden of ["bash", "edit", "write"]) {
      expect(READ_ONLY_TOOL_NAMES as readonly string[]).not.toContain(forbidden);
    }
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(["find", "grep", "ls", "read"]);
  });

  it("the DO tool set does include the mutating built-ins", () => {
    for (const needed of ["read", "bash", "edit", "write"]) {
      expect(CODING_TOOL_NAMES as readonly string[]).toContain(needed);
    }
  });
});

describe("session creation", () => {
  it("creates a check session without credentials", async () => {
    const session = await createCheckSession({ cwd: tmpDir, systemPrompt: "test", customTools: [probeTool] });
    expect(session).toBeTruthy();
    session.dispose();
  });

  it("creates a step session without credentials", async () => {
    const session = await createStepSession({ cwd: tmpDir, customTools: [probeTool] });
    expect(session).toBeTruthy();
    session.dispose();
  });

  it("dispose is idempotent", async () => {
    const session = await createCheckSession({ cwd: tmpDir, systemPrompt: "t" });
    session.dispose();
    expect(() => session.dispose()).not.toThrow();
  });
});

describe("steering", () => {
  // The run view steers live human messages into a step's session via this —
  // src/tui/run-view.ts / engine/runner.ts sendUserMessage — but nothing in
  // this package called SessionHandle.steer before that feature, so it had
  // zero coverage of its own. Pin the contract the same way prompt/followUp
  // are pinned above: it must exist, and it must not require a running turn
  // or credentials to be queued.
  it("steer resolves without needing a running turn or credentials", async () => {
    const session = await createStepSession({ cwd: tmpDir, customTools: [probeTool] });
    await expect(session.steer("hello")).resolves.toBeUndefined();
    session.dispose();
  });
});

describe("session persistence", () => {
  it("an unpersisted session reports no jsonl path", async () => {
    const session = await createCheckSession({ cwd: tmpDir, systemPrompt: "t" });
    expect(session.jsonlPath).toBeNull();
    session.dispose();
  });

  it("a sessionDir yields a jsonl inside that dir", async () => {
    const dir = path.join(tmpDir, "sessions", "impl-do-1");
    const session = await createStepSession({ cwd: tmpDir, sessionDir: dir });
    expect(session.jsonlPath).toBeTruthy();
    expect(session.jsonlPath!.startsWith(dir)).toBe(true);
    expect(session.jsonlPath!.endsWith(".jsonl")).toBe(true);
    session.dispose();
  });

  it("reserves the jsonl path but only writes it once there are entries", async () => {
    // Pi creates the file lazily. Consequence we rely on: a step session that
    // crashed before saying anything leaves no transcript, so the retry starts
    // clean rather than resuming an empty shell.
    const dir = path.join(tmpDir, "sessions", "impl-do-1");
    const session = await createStepSession({ cwd: tmpDir, sessionDir: dir });
    expect(session.jsonlPath).toBeTruthy();
    expect(fs.existsSync(session.jsonlPath!)).toBe(false);
    expect(findSessionFile(dir)).toBeNull();
    session.dispose();
  });

  it("reopens an existing transcript instead of starting a new one", async () => {
    // This is what lets a check-failed retry continue the same step session and
    // a crashed run pick its step session back up.
    const dir = path.join(tmpDir, "sessions", "impl-do-1");
    const existing = writeSyntheticTranscript(dir, tmpDir);

    const session = await createStepSession({ cwd: tmpDir, sessionDir: dir });
    expect(session.jsonlPath).toBe(existing);
    session.dispose();

    // Crucially: no second transcript was created alongside it.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("different step dirs get independent transcripts (fresh context per step)", async () => {
    const a = await createStepSession({ cwd: tmpDir, sessionDir: path.join(tmpDir, "s", "one-do-1") });
    const b = await createStepSession({ cwd: tmpDir, sessionDir: path.join(tmpDir, "s", "two-do-1") });
    expect(a.jsonlPath).not.toBe(b.jsonlPath);
    a.dispose();
    b.dispose();
  });

  it("findSessionFile returns null for a missing or empty dir", () => {
    expect(findSessionFile(path.join(tmpDir, "nope"))).toBeNull();
    const empty = path.join(tmpDir, "empty");
    fs.mkdirSync(empty, { recursive: true });
    expect(findSessionFile(empty)).toBeNull();
  });
});

describe("model resolution", () => {
  it("rejects an empty spec without throwing", async () => {
    const result = await resolveModel("");
    expect(result.error).toBeTruthy();
    expect(result.model).toBeUndefined();
  });

  it("reports an unresolvable model as an error rather than throwing", async () => {
    // Callers fall back to the default model on error — the plugin versions'
    // "unresolvable model falls back" behavior.
    const result = await resolveModel("no-such-provider/no-such-model");
    expect(result.model).toBeUndefined();
    expect(result.error ?? result.warning).toBeTruthy();
    // This must be pi-ai's real "no such model" verdict, not resolveModel's
    // catch-all swallowing an SDK-shape break (e.g. a renamed/removed export
    // in the model-runtime plumbing) into a generic error string. A 0.80.7 →
    // 0.80.10 upgrade did exactly that once (AuthStorage/ModelRegistry.create
    // were removed) and this assertion was too loose to catch it — the
    // import failure was caught here and reported as "AuthStorage is not a
    // function", which still made `result.error` truthy.
    expect(result.error).toMatch(/not found/i);
    expect(result.error).not.toMatch(/is not a function|cannot read propert|undefined is not/i);
  });
});

describe("version pin", () => {
  it("reports the pinned Pi version", () => {
    expect(piVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
