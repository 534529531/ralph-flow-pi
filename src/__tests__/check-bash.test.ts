/**
 * Security acceptance gate for the verifier's shell sandbox.
 *
 * The check session judges the very workspace it can run commands in, so a hole
 * here means a verifier can "fix" the work it was supposed to fail. The
 * positive/negative cases mirror the two plugins' allow-lists; the injection
 * cases are what this implementation adds (both plugins glob-match the whole
 * command string and would let several of these through).
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { checkCommand, resolveAction, splitSegments, runApprovedCommand, validateExtraAllowedBash } from "../engine/check-bash.js";

const allowed = (cmd: string) => checkCommand(cmd).allowed;

describe("allow-list: read-only commands the checks actually run", () => {
  // At least one sample per family in RALPH_CHECK_BASH_PERMISSION.
  const ALLOWED = [
    "cat src/main.rs",
    "head -n 20 file.txt",
    "tail -f log.txt",
    "ls -la src/",
    "find . -name '*.rs'",
    "grep -rn TODO src/",
    "wc -l src/lib.rs",
    "file target/debug/app",
    "stat Cargo.toml",
    "awk '{print $1}' data.txt",
    "sed -n '1,10p' file.txt",
    "cut -d, -f1 data.csv",
    "sort data.txt",
    "uniq -c data.txt",
    "tr a-z A-Z",
    "cd src",
    "jq '.name' package.json",
    "bc -l",
    "echo hello",
    "printf '%s' x",
    "test -f Cargo.toml",
    "true",
    "diff a.txt b.txt",
    "cmp a.bin b.bin",
    "comm a.txt b.txt",
    "basename /a/b/c",
    "dirname /a/b/c",
    "realpath .",
    "readlink -f link",
    "pwd",
    "nm target/debug/app",
    "git status",
    "git status --short",
    "git diff",
    "git diff HEAD~1",
    "git log --oneline -5",
    "git show HEAD",
    "npm test",
    "npm run test -- --coverage",
    "pytest",
    "pytest tests/ -v",
    "go test ./...",
    "make test",
    "cargo build",
    "cargo build --release",
    "cargo test",
    "cargo test --lib",
    "cargo run --bin app",
    "cargo nextest run",
    "cargo clippy",
    "cargo clippy -- -D warnings",
    "cargo llvm-cov --summary-only",
    "cargo geiger --output-format Json",
    "cargo clean -p app",
    "cargo fmt --check",
    "cargo metadata --format-version 1",
    "cargo tree -d",
    "cargo audit --json",
    "cargo deny check",
  ];

  it.each(ALLOWED)("allows %s", (cmd) => {
    expect(allowed(cmd)).toBe(true);
  });
});

describe("deny-list: mutating commands must never run", () => {
  const DENIED = [
    "rm -rf src/",
    "rm file.txt",
    "mv a.txt b.txt",
    "cp a.txt b.txt",
    "touch newfile",
    "mkdir newdir",
    "chmod +x script.sh",
    "git commit -m 'fix'",
    "git push",
    "git checkout -- .",
    "git reset --hard",
    "git add .",
    "cargo fmt",              // plain fmt rewrites source; only --check is allowed
    "cargo fix --allow-dirty",
    "cargo add serde",
    "npm install",
    "npm run build",
    "pip install requests",
    "curl https://example.com",
    "wget https://example.com/x",
    "ssh host",
    "sudo rm -rf /",
    "dd if=/dev/zero of=file",
    "truncate -s0 important.txt", // must not be matched by the "tr *" pattern
    "python -c 'import os; os.remove(\"x\")'",
    "node -e 'require(\"fs\").unlinkSync(\"x\")'",
    "bash script.sh",
    "sh -c 'rm x'",
    "eval 'rm x'",
    "tee output.txt",
  ];

  it.each(DENIED)("denies %s", (cmd) => {
    expect(allowed(cmd)).toBe(false);
  });

  it("the trailing-space pattern form stops short names overmatching", () => {
    // "tr *" must not cover truncate/tree; "true" must not cover truncate.
    expect(resolveAction("truncate -s0 f")).toBe("deny");
    expect(resolveAction("tr a-z A-Z")).toBe("allow");
  });

  it("denies by default (the '*': 'deny' fallback)", () => {
    expect(resolveAction("some-unknown-binary --flag")).toBe("deny");
  });

  it("cargo fmt is allowed only with --check", () => {
    expect(allowed("cargo fmt --check")).toBe(true);
    expect(allowed("cargo fmt --check -- --edition 2021")).toBe(true);
    expect(allowed("cargo fmt")).toBe(false);
    expect(allowed("cargo fmt --all")).toBe(false);
  });
});

describe("injection: what a whole-string glob match would let through", () => {
  it("checks every segment of a compound command, not just the first", () => {
    // Both plugins would glob-match "cat *" against the ENTIRE string and allow it.
    expect(allowed("cat x && rm -rf y")).toBe(false);
    expect(allowed("cat x; rm -rf y")).toBe(false);
    expect(allowed("cat x || rm -rf y")).toBe(false);
    expect(allowed("cat x | rm -rf y")).toBe(false);
    expect(allowed("cat x & rm -rf y")).toBe(false);
    expect(allowed("cat x\nrm -rf y")).toBe(false);
  });

  it("allows compound commands when every segment is read-only", () => {
    expect(allowed("cat x | grep foo")).toBe(true);
    expect(allowed("cargo test && cargo clippy")).toBe(true);
    expect(allowed("grep -rn TODO src/ | wc -l")).toBe(true);
  });

  it("rejects command substitution in every form", () => {
    expect(allowed("cat $(rm -rf /)")).toBe(false);
    expect(allowed("echo `rm -rf /`")).toBe(false);
    expect(allowed("diff <(rm x) <(cat y)")).toBe(false);
    expect(allowed("cat x > >(rm y)")).toBe(false);
  });

  it("rejects write redirection but tolerates fd dup and read redirection", () => {
    expect(allowed("cat x > important.txt")).toBe(false);
    expect(allowed("cat x >> important.txt")).toBe(false);
    expect(allowed("echo pwned > /etc/passwd")).toBe(false);
    expect(allowed("cargo test 2>&1")).toBe(true);
    expect(allowed("cargo test > out.txt 2>&1")).toBe(false);
    expect(allowed("grep foo < input.txt")).toBe(true);
  });

  it("does not mistake a quoted angle bracket for a redirection", () => {
    expect(allowed("grep -n 'a > b' file.txt")).toBe(true);
    expect(allowed('grep -n "x >> y" file.txt')).toBe(true);
  });

  it("does not split on separators inside quotes", () => {
    expect(splitSegments("grep -n 'a && b' file")).toEqual(["grep -n 'a && b' file"]);
    expect(allowed("grep -n 'a; rm -rf /' file")).toBe(true); // a literal search string
  });

  it("denies sed -i even though bare sed is allow-listed", () => {
    expect(allowed("sed -n '1,5p' f")).toBe(true);
    expect(allowed("sed -i 's/a/b/' f")).toBe(false);
    expect(allowed("sed --in-place 's/a/b/' f")).toBe(false);
    expect(allowed("sed -i.bak 's/a/b/' f")).toBe(false);
  });

  it("denies awk/sed writes hidden inside their own script argument", () => {
    // findWriteRedirection strips quoted spans before scanning for a shell-
    // level `>` (on purpose — a literal `>` inside a grep pattern must not
    // read as a redirect). That means it cannot see a `>` that never reaches
    // the shell at all: awk and sed both interpret redirection/write syntax
    // INSIDE their own quoted script, so the whole script argument was
    // getting stripped to `''` and the write went undetected. Both of these
    // actually execute and write a file if allowed through.
    expect(allowed('awk \'BEGIN{print "pwned" > "pwned.txt"}\'')).toBe(false);
    expect(allowed('awk \'{print $1 >> "out.txt"}\' data.txt')).toBe(false);
    expect(allowed("sed 's/a/b/w pwned.txt' file.txt")).toBe(false);
    expect(allowed("sed -n '1,5w pwned.txt' file.txt")).toBe(false);
    expect(allowed("sed '5w pwned.txt' file.txt")).toBe(false);
    // Ordinary read-only uses (including ones that contain a bare "w") must
    // still work — this is a script-syntax check, not a ban on the letter w.
    expect(allowed("awk '{print $1}' data.txt")).toBe(true);
    expect(allowed("sed -n '1,10p' file.txt")).toBe(true);
    expect(allowed("sed 's/hello world/hi/' file")).toBe(true);
    expect(allowed("sed 's/a/below file.txt/' file")).toBe(true);
  });

  it("denies find -delete and find -exec", () => {
    expect(allowed("find . -name '*.rs'")).toBe(true);
    expect(allowed("find . -name '*.rs' -delete")).toBe(false);
    expect(allowed("find . -name '*' -exec rm {} ;")).toBe(false);
    expect(allowed("find . -ok rm {} ;")).toBe(false);
  });

  it("validates the payload of an allow-listed xargs", () => {
    expect(allowed("find . -name '*.rs' | xargs grep TODO")).toBe(true);
    expect(allowed("find . -name '*.rs' | xargs rm")).toBe(false);
    expect(allowed("xargs -0 rm -rf")).toBe(false);
  });

  it("reports which segment was rejected", () => {
    const decision = checkCommand("cat x && rm -rf y");
    expect(decision.allowed).toBe(false);
    expect(decision.offendingSegment).toBe("rm -rf y");
    expect(decision.reason).toContain("白名单");
  });

  it("rejects an empty command", () => {
    expect(allowed("")).toBe(false);
    expect(allowed("   ")).toBe(false);
  });
});

/**
 * A workflow's own `adversarial_check.extra_allowed_bash` (types.ts) — the
 * escape hatch for custom project CLIs/build tools the fixed built-in table
 * cannot know about. The bar for this suite: an extra pattern must open
 * exactly what it says and nothing more — every guard the built-in table is
 * subject to (injection, write redirection, mutating flags) must apply
 * identically, and a small set of base commands must be un-openable no
 * matter what a workflow YAML asks for.
 */
describe("extra_allowed_bash: workflow-authored whitelist additions", () => {
  it("opens exactly the opted-in custom command, and nothing without it", () => {
    expect(checkCommand("./scripts/check.sh --verify", ["./scripts/check.sh *"]).allowed).toBe(true);
    expect(checkCommand("./scripts/check.sh --verify").allowed).toBe(false);
    expect(checkCommand("just test", ["just test*"]).allowed).toBe(true);
    expect(checkCommand("just build", ["just test*"]).allowed).toBe(false);
  });

  it("still enforces write-redirection and injection guards on an extra-allowed command", () => {
    expect(checkCommand("./scripts/check.sh > out.txt", ["./scripts/check.sh *"]).allowed).toBe(false);
    expect(checkCommand("./scripts/check.sh && rm -rf /", ["./scripts/check.sh *"]).allowed).toBe(false);
    expect(checkCommand("./scripts/check.sh $(rm -rf /)", ["./scripts/check.sh *"]).allowed).toBe(false);
  });

  it("never grants a banned base command, even if a workflow explicitly asks", () => {
    const dangerous = ["rm *", "curl *", "sh -c *", "git *", "npm install *", "sudo *", "docker *"];
    const { allowed, rejected } = validateExtraAllowedBash(dangerous);
    expect(Object.keys(allowed)).toEqual([]);
    expect(rejected.length).toBe(dangerous.length);
    // The runtime path independently re-derives this — it must not be
    // possible to reach `rm` by constructing checkCommand's extra table.
    expect(checkCommand("rm -rf /tmp/x", ["rm *"]).allowed).toBe(false);
  });

  it("rejects a pattern that starts with a wildcard instead of a literal command", () => {
    const { allowed, rejected } = validateExtraAllowedBash(["*", "* anything"]);
    expect(Object.keys(allowed)).toEqual([]);
    expect(rejected.length).toBe(2);
    // Confirms the base table's "*": "deny" fallback survives this attempt —
    // an accepted bare "*" would have allowed literally everything.
    expect(checkCommand("rm -rf /", ["*"]).allowed).toBe(false);
  });

  it("accepts a legitimate custom CLI pattern and reports nothing rejected", () => {
    const { allowed, rejected } = validateExtraAllowedBash(["./my-cli verify *", "bazel test *"]);
    expect(Object.keys(allowed).sort()).toEqual(["./my-cli verify *", "bazel test *"]);
    expect(rejected).toEqual([]);
  });

  it("ignores blank/whitespace-only entries without throwing", () => {
    const { allowed, rejected } = validateExtraAllowedBash(["", "   ", "./ok *"]);
    expect(Object.keys(allowed)).toEqual(["./ok *"]);
    expect(rejected).toEqual([]);
  });

  it("an unset or empty extra_allowed_bash behaves exactly like before this feature existed", () => {
    expect(checkCommand("cat README.md").allowed).toBe(true);
    expect(checkCommand("cat README.md", []).allowed).toBe(true);
    expect(checkCommand("cat README.md", undefined).allowed).toBe(true);
  });
});

describe("runApprovedCommand", () => {
  it("captures output and exit code", async () => {
    const result = await runApprovedCommand("echo hello", process.cwd());
    expect(result.output).toContain("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures a non-zero exit code and stderr", async () => {
    const result = await runApprovedCommand("ls /definitely-does-not-exist-xyz", process.cwd());
    expect(result.exitCode).not.toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("truncates runaway output", async () => {
    const result = await runApprovedCommand("head -c 200000 /dev/zero | tr '\\0' 'a'", process.cwd());
    expect(result.output).toContain("已截断");
    expect(result.output.length).toBeLessThan(40_000);
  });

  it("runs in the given cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-bash-cwd-"));
    fs.writeFileSync(path.join(dir, "marker.txt"), "x");
    const result = await runApprovedCommand("ls", dir);
    expect(result.output).toContain("marker.txt");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
