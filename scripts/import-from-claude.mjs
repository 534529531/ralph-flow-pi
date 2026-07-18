#!/usr/bin/env node
/**
 * Import the domain skills and workflows from the Claude Code plugin.
 *
 * The three substitutions below are the WHOLE difference between the two
 * versions' text — everything else is byte-identical, which is what keeps the
 * three implementations honest (see SYNC.md). Re-running this after an upstream
 * change is the supported way to re-sync; do not hand-edit the imported files.
 *
 *   usage: node scripts/import-from-claude.mjs <path-to-claude-plugin>
 */

import fs from "fs";
import path from "path";

const SRC = process.argv[2] || "/home/yj/.claude/plugins/cache/ralph-flow-local/ralph-flow/1.0.0";
const DEST = path.join(import.meta.dirname, "..");

/** Skills that only wrap the user commands — ralph-flow-pi has its own. */
const SKIP_SKILLS = /^ralphflow-/;

/** Workflows already shipped (loop/spec came from the opencode version). */
const IMPORT_WORKFLOWS = ["c-to-rust.yaml", "everything2rust.yaml"];

/**
 * Bare model names cannot be resolved by pi-ai, which needs "provider/model".
 * The opencode plugin's doctor warned about exactly this; here we fix it at
 * import time so the shipped workflows are clean.
 */
const MODEL_MAP = {
  Opus: "anthropic/claude-opus-4-5",
  opus: "anthropic/claude-opus-4-5",
  Sonnet: "anthropic/claude-sonnet-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",
  Haiku: "anthropic/claude-haiku-4-5",
  haiku: "anthropic/claude-haiku-4-5",
};

function convert(text) {
  let out = text;

  // 1. Skill invocation. The Claude plugin names skills "ralph-flow:<name>";
  //    pi puts a catalog of available skills (with absolute paths) in the system
  //    prompt and the model loads one with the read tool, so the plugin prefix
  //    is meaningless here and the phrasing points at pi's mechanism instead.
  out = out.replace(/调用 ralph-flow:([a-z0-9-]+) skill/g, "使用 $1 skill（在可用 skill 列表中按 location 读取它）");
  out = out.replace(/ralph-flow:([a-z0-9-]+) skill/g, "$1 skill");

  // 2. Data dir: we are the host, so no plugin dir nesting.
  out = out.replace(/\.claude\/ralph-flow\//g, ".ralph-flow/");
  out = out.replace(/`\.claude\/`/g, "`.ralph-flow/`");

  // 3. Bare model names → canonical pi form.
  out = out.replace(/^(\s*model:\s*)([A-Za-z][A-Za-z0-9]*)\s*$/gm, (match, prefix, name) => {
    const mapped = MODEL_MAP[name];
    return mapped ? `${prefix}"${mapped}"` : match;
  });

  return out;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (/\.(md|yaml|yml|json|txt)$/.test(entry.name)) {
      fs.writeFileSync(to, convert(fs.readFileSync(from, "utf-8")));
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

let skillCount = 0;
const skillsSrc = path.join(SRC, "skills");
const skillsDest = path.join(DEST, "skills");
for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
  if (!entry.isDirectory() || SKIP_SKILLS.test(entry.name)) continue;
  copyDir(path.join(skillsSrc, entry.name), path.join(skillsDest, entry.name));
  skillCount++;
  console.log(`skill: ${entry.name}`);
}

let wfCount = 0;
for (const file of IMPORT_WORKFLOWS) {
  const from = path.join(SRC, "workflows", file);
  if (!fs.existsSync(from)) { console.warn(`missing workflow: ${file}`); continue; }
  fs.writeFileSync(path.join(DEST, "workflows", file), convert(fs.readFileSync(from, "utf-8")));
  wfCount++;
  console.log(`workflow: ${file}`);
}

console.log(`\nimported ${skillCount} skills, ${wfCount} workflows`);
console.log("now run: npm run build && node dist/cli.js doctor   (expect 0 errors, 0 warnings)");
