/**
 * Skill discovery, in the same three tiers as workflows: project → global → built-in.
 *
 * The engine deliberately knows almost nothing about skills. A workflow step's
 * `do:` text just says "use the c-to-rust-plan skill"; the model reads that,
 * finds the skill in its system prompt catalog, and loads it. That decoupling is
 * inherited from both plugin versions and is why the 12 domain skills could move
 * here as plain text.
 *
 * What changed from the plan: pi already ships this. `loadSkillsFromDir` parses
 * SKILL.md frontmatter, and the default system prompt appends a catalog (name,
 * description, ABSOLUTE location) plus the instruction to resolve a skill's
 * relative references against its own directory — as long as the session has the
 * `read` tool. So there is no `use_skill` tool here: writing one would have
 * duplicated pi's mechanism and fought its prompt.
 *
 * All this file adds is the tier resolution pi doesn't do: same-named skills
 * shadow, nearest tier wins, and only the winners are handed to the session.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadSkillsFromDir, type Skill } from "../pi/adapter.js";

export type SkillSource = "project" | "global" | "builtin";

export interface ResolvedSkill {
  name: string;
  description: string;
  /** Absolute path to SKILL.md — what goes in the model's catalog. */
  filePath: string;
  source: SkillSource;
  /** Same-named skills this one shadows, nearest-tier-first. */
  shadowed: Array<{ source: SkillSource; filePath: string }>;
}

export interface SkillIndex {
  skills: ResolvedSkill[];
  /** Absolute SKILL.md paths for the winners — pass to a session's skillPaths. */
  paths: string[];
  /** Human-readable problems (unparseable SKILL.md, etc). */
  diagnostics: string[];
}

/** Skills shipped inside the package. */
export function getBuiltinSkillsDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  // dist/engine/skills.js → package root → skills/
  return path.join(path.dirname(__filename), "..", "..", "skills");
}

export function getProjectSkillsDir(ralphFlowDir: string): string {
  return path.join(ralphFlowDir, "skills");
}

export function getGlobalSkillsDir(globalConfigHome: string | null): string | null {
  return globalConfigHome ? path.join(globalConfigHome, "skills") : null;
}

/**
 * Resolve the skills available to a DO session.
 *
 * @param ralphFlowDir     the project's .ralph-flow dir
 * @param globalConfigHome ~/.config/ralph-flow-pi, or null when there's no home
 */
export function loadSkillIndex(ralphFlowDir: string, globalConfigHome: string | null): SkillIndex {
  const globalDir = getGlobalSkillsDir(globalConfigHome);
  const tiers: Array<{ source: SkillSource; dir: string }> = [
    { source: "project", dir: getProjectSkillsDir(ralphFlowDir) },
    ...(globalDir ? [{ source: "global" as const, dir: globalDir }] : []),
    { source: "builtin", dir: getBuiltinSkillsDir() },
  ];

  const byName = new Map<string, ResolvedSkill>();
  const diagnostics: string[] = [];

  for (const { source, dir } of tiers) {
    if (!fs.existsSync(dir)) continue;
    let result: { skills: Skill[]; diagnostics: Array<{ message?: string }> };
    try {
      result = loadSkillsFromDir({ dir, source }) as any;
    } catch (e: any) {
      diagnostics.push(`扫描 skill 目录 ${dir} 失败：${e.message}`);
      continue;
    }
    for (const d of result.diagnostics ?? []) {
      if (d?.message) diagnostics.push(`${d.message}（${source}）`);
    }
    for (const skill of result.skills ?? []) {
      const existing = byName.get(skill.name);
      if (existing) {
        // An earlier tier already won; record that this one is shadowed so
        // doctor can explain why an edit to it had no effect.
        existing.shadowed.push({ source, filePath: skill.filePath });
        continue;
      }
      byName.set(skill.name, {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        source,
        shadowed: [],
      });
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, paths: skills.map((s) => s.filePath), diagnostics };
}

/** Doctor section: which skills are available, and what shadows what. */
export function formatSkillReport(index: SkillIndex): string {
  const lines: string[] = [];
  const label: Record<SkillSource, string> = { project: "项目自定义", global: "全局用户", builtin: "内置" };

  if (index.skills.length === 0) {
    lines.push("没有找到任何 skill。");
  } else {
    lines.push(`可用 skill：**${index.skills.length}** 个`, "");
    for (const s of index.skills) {
      lines.push(`- **${s.name}**（${label[s.source]}）：${s.description || "（无描述）"}`);
      for (const sh of s.shadowed) {
        lines.push(`  - ℹ️ 遮蔽了同名${label[sh.source]} skill：${sh.filePath}`);
      }
    }
  }
  if (index.diagnostics.length > 0) {
    lines.push("", "问题：");
    for (const d of index.diagnostics) lines.push(`- ⚠️ ${d}`);
  }
  return lines.join("\n");
}
