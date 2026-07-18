/**
 * Tests for the cross-process instance lock (ported from the Claude plugin's
 * withInstanceLock). The opencode version had no lock to port tests from, so
 * these are new — and they matter more here than in either plugin: ralph-flow-pi
 * is a plain CLI, so a second `ralph` TUI or a `ralph cancel` in another
 * terminal really is a separate process racing the same instance dir.
 *
 * The stale-pid cases use a real spawned process rather than a fabricated pid,
 * so the liveness probe is exercised against an actually-live and then
 * actually-dead process.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { withInstanceLock, isInstanceGone, LOCK_FILENAME } from "../engine/lock.js";
import { isPidAlive } from "../engine/core.js";

let tmpDir: string;
let instDir: string;
const children: ChildProcess[] = [];

function lockPath(): string {
  return path.join(instDir, LOCK_FILENAME);
}

/** A real, live child process whose pid we can plant in the lock file. */
function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

async function waitForDeath(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} never died`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-lock-test-"));
  instDir = path.join(tmpDir, "instances", "wf-1");
  fs.mkdirSync(instDir, { recursive: true });
});

afterEach(() => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  children.length = 0;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("withInstanceLock", () => {
  it("runs the body, returns its value, and always releases", async () => {
    const result = await withInstanceLock(instDir, "wf-1", () => "value");
    expect(result).toBe("value");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("releases the lock even when the body throws", async () => {
    await expect(withInstanceLock(instDir, "wf-1", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("serializes concurrent holders instead of interleaving them", async () => {
    const events: string[] = [];
    const body = (tag: string) => async () => {
      events.push(`${tag}:enter`);
      await new Promise((r) => setTimeout(r, 50));
      events.push(`${tag}:exit`);
    };
    await Promise.all([
      withInstanceLock(instDir, "wf-1", body("a")),
      withInstanceLock(instDir, "wf-1", body("b")),
    ]);
    // Whoever won, the two critical sections must not overlap.
    expect(events.length).toBe(4);
    expect(events[1]).toBe(events[0].replace(":enter", ":exit"));
    expect(events[3]).toBe(events[2].replace(":enter", ":exit"));
  });

  it("reclaims a lock whose owner pid is dead", async () => {
    const child = spawnSleeper();
    const pid = child.pid!;
    fs.writeFileSync(lockPath(), String(pid));

    child.kill("SIGKILL");
    await waitForDeath(pid);

    // The recorded pid is now dead → the lock is stale and must be reclaimed.
    const result = await withInstanceLock(instDir, "wf-1", () => "reclaimed");
    expect(result).toBe("reclaimed");
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("does not steal a lock held by a live foreign process", async () => {
    const child = spawnSleeper();
    fs.writeFileSync(lockPath(), String(child.pid));

    // A live owner means we must wait, not barge in. The full wait is 30s, so
    // assert on the timeout race rather than sitting through it.
    const attempt = withInstanceLock(instDir, "wf-1", () => "stolen");
    const outcome = await Promise.race([
      attempt.then(() => "acquired"),
      new Promise((r) => setTimeout(() => r("still-waiting"), 400)),
    ]);
    expect(outcome).toBe("still-waiting");

    // Releasing it lets the waiter through, which also drains the pending promise.
    fs.unlinkSync(lockPath());
    await expect(attempt).resolves.toBe("stolen");
  });

  it("throws INSTANCE_GONE when the instance dir has vanished", async () => {
    fs.rmSync(instDir, { recursive: true, force: true });
    try {
      await withInstanceLock(instDir, "wf-1", () => "unreachable");
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(isInstanceGone(e)).toBe(true);
      expect(e.code).toBe("INSTANCE_GONE");
    }
  });

  it("locks of different instances do not block each other", async () => {
    const other = path.join(tmpDir, "instances", "wf-2");
    fs.mkdirSync(other, { recursive: true });
    let bRan = false;
    await withInstanceLock(instDir, "wf-1", async () => {
      await withInstanceLock(other, "wf-2", () => { bRan = true; });
    });
    expect(bRan).toBe(true);
  });
});

describe("isPidAlive", () => {
  it("is true for this process and false after a child dies", async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    const child = spawnSleeper();
    const pid = child.pid!;
    expect(isPidAlive(pid)).toBe(true);
    child.kill("SIGKILL");
    await waitForDeath(pid);
    expect(isPidAlive(pid)).toBe(false);
  });
});
