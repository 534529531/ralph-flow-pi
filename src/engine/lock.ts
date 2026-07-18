/**
 * Cross-process advisory lock for one instance.
 *
 * Ported verbatim from the Claude plugin's mcp-server/server.mjs (withInstanceLock).
 * The opencode plugin needed no such lock — one plugin process per project served
 * every session, so opencode's per-session turn model serialized instance
 * operations for free. ralph-flow-pi is a normal CLI: a second `ralph` TUI or a
 * `ralph cancel` in another terminal is a separate process, so the Claude
 * version's file lock is the right prior art again.
 *
 * The lock file holds the owner's pid; a dead pid makes it stale.
 */

import fs from "fs";
import path from "path";
import { isPidAlive } from "./core.js";
import { stripBom } from "./types.js";

export const LOCK_FILENAME = ".lock";
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 100;

export class InstanceGoneError extends Error {
  readonly code = "INSTANCE_GONE";
  constructor(instId: string) {
    super(`instance-gone: ${instId}`);
    this.name = "InstanceGoneError";
  }
}

export function isInstanceGone(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as any).code === "INSTANCE_GONE";
}

/**
 * Run `fn` holding the instance's cross-process lock.
 *
 * @throws InstanceGoneError when the instance dir vanished (cancelled/completed
 *         by another process) — callers treat this as "nothing to do".
 * @throws Error("Instance lock timeout") after 30s of contention.
 */
export async function withInstanceLock<T>(instanceDir: string, instId: string, fn: () => T | Promise<T>): Promise<T> {
  const lockPath = path.join(instanceDir, LOCK_FILENAME);
  const tmpPath = path.join(instanceDir, `${LOCK_FILENAME}.${process.pid}`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  // Write the pid to a temp file first, then atomically link it into place —
  // the lock file is never observable in a half-written (empty) state, so a
  // concurrent reader can't misclassify an in-flight acquisition as stale.
  const tryAcquire = (): boolean => {
    fs.writeFileSync(tmpPath, String(process.pid));
    try {
      try {
        fs.linkSync(tmpPath, lockPath);
        return true;
      } catch (e: any) {
        if (e.code === "EEXIST") return false;
        if (e.code === "EPERM" || e.code === "EACCES" || e.code === "ENOSYS" || e.code === "EXDEV") {
          // Filesystem without hard-link support — fall back to exclusive create
          const fd = fs.openSync(lockPath, "wx");
          fs.writeSync(fd, String(process.pid));
          fs.closeSync(fd);
          return true;
        }
        throw e;
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  };

  for (;;) {
    try {
      if (tryAcquire()) break;
    } catch (e: any) {
      if (e.code === "ENOENT") {
        // Instance directory disappeared (cancelled/completed by another process)
        throw new InstanceGoneError(instId);
      }
      if (e.code !== "EEXIST") throw e; // EEXIST from the wx fallback: lock held
    }
    // Lock held by someone — stale only if its recorded pid is dead
    let staleContent: string | null = null;
    try {
      const content = stripBom(fs.readFileSync(lockPath, "utf-8")).trim();
      const pid = parseInt(content, 10);
      if (pid && !isPidAlive(pid)) staleContent = content;
    } catch (e: any) {
      if (e && e.code === "ENOENT") continue; // released between attempts — retry
    }
    if (staleContent !== null) {
      // Re-read right before unlinking so we never delete a lock that was
      // released and re-acquired by a live process in the meantime.
      try {
        const again = stripBom(fs.readFileSync(lockPath, "utf-8")).trim();
        if (again === staleContent) fs.unlinkSync(lockPath);
      } catch {}
      continue;
    }
    if (Date.now() > deadline) throw new Error("Instance lock timeout");
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
