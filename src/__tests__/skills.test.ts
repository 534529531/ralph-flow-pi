/**
 * Skill discovery and tier shadowing.
 *
 * The parsing itself is pi's (loadSkillsFromDir); what's ours is the three-tier
 * resolution, which has to match the workflow loader's rules exactly — a user
 * who learns "project shadows global shadows built-in" for workflows must not
 * discover that skills work differently.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { formatSkillReport, getBuiltinSkillsDir, loadSkillIndex } from "../engine/skills.js";

let tmpDir: string;
let projectRalphDir: string;
let globalHome: string;

function writeSkill(dir: string, name: string, description: string, body = "do the thing"): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-skills-test-"));
  projectRalphDir = path.join(tmpDir, ".ralph-flow");
  globalHome = path.join(tmpDir, "global-config");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("built-in skills", () => {
  it("ships the twelve domain skills", () => {
    const index = loadSkillIndex(projectRalphDir, null);
    const names = index.skills.map((s) => s.name);
    for (const n of [
      "c-to-rust-plan", "c-to-rust-test-gen", "c-to-rust-implement", "c-to-rust-audit", "c-to-rust-validate",
      "everything2rust-survey", "everything2rust-design", "everything2rust-spec",
      "everything2rust-test-gen", "everything2rust-implement", "everything2rust-audit", "everything2rust-validate",
    ]) {
      expect(names).toContain(n);
    }
    expect(index.skills.every((s) => s.source === "builtin")).toBe(true);
  });

  it("does not ship the command-wrapper skills (this package has its own commands)", () => {
    const names = loadSkillIndex(projectRalphDir, null).skills.map((s) => s.name);
    expect(names.some((n) => n.startsWith("ralphflow-"))).toBe(false);
  });

  it("exposes absolute SKILL.md paths — the model reads them by location", () => {
    const index = loadSkillIndex(projectRalphDir, null);
    for (const p of index.paths) {
      expect(path.isAbsolute(p)).toBe(true);
      expect(fs.existsSync(p)).toBe(true);
      expect(p.endsWith("SKILL.md")).toBe(true);
    }
  });

  it("every built-in skill has a description (it is all the model sees before loading)", () => {
    for (const skill of loadSkillIndex(projectRalphDir, null).skills) {
      expect(skill.description.length).toBeGreaterThan(0);
    }
  });

  it("references/ dirs travel with their skill", () => {
    // c-to-rust-implement ships reference material; the catalog only names
    // SKILL.md, so the extra files must sit next to it for the relative-path
    // resolution pi's prompt describes.
    const implement = loadSkillIndex(projectRalphDir, null).skills.find((s) => s.name === "c-to-rust-implement")!;
    const refs = path.join(path.dirname(implement.filePath), "references");
    if (fs.existsSync(refs)) {
      expect(fs.readdirSync(refs).length).toBeGreaterThan(0);
    }
  });
});

describe("tier resolution", () => {
  it("project shadows global shadows built-in", () => {
    const globalSkills = path.join(globalHome, "skills");
    const projectSkills = path.join(projectRalphDir, "skills");

    // Global overrides a built-in.
    writeSkill(globalSkills, "c-to-rust-plan", "global version");
    let index = loadSkillIndex(projectRalphDir, globalHome);
    let plan = index.skills.find((s) => s.name === "c-to-rust-plan")!;
    expect(plan.source).toBe("global");
    expect(plan.description).toBe("global version");
    expect(plan.shadowed.map((s) => s.source)).toEqual(["builtin"]);

    // Project overrides both.
    writeSkill(projectSkills, "c-to-rust-plan", "project version");
    index = loadSkillIndex(projectRalphDir, globalHome);
    plan = index.skills.find((s) => s.name === "c-to-rust-plan")!;
    expect(plan.source).toBe("project");
    expect(plan.description).toBe("project version");
    expect(plan.shadowed.map((s) => s.source)).toEqual(["global", "builtin"]);
  });

  it("only the winning path is offered to the session", () => {
    const projectSkills = path.join(projectRalphDir, "skills");
    const winner = writeSkill(projectSkills, "c-to-rust-plan", "project version");
    const index = loadSkillIndex(projectRalphDir, null);
    expect(index.paths).toContain(winner);
    // The shadowed built-in must NOT also be handed over, or the model would see
    // the same skill twice with different content.
    expect(index.paths.filter((p) => p.includes("c-to-rust-plan")).length).toBe(1);
  });

  it("a custom skill coexists with the built-ins", () => {
    writeSkill(path.join(projectRalphDir, "skills"), "my-skill", "my own thing");
    const names = loadSkillIndex(projectRalphDir, null).skills.map((s) => s.name);
    expect(names).toContain("my-skill");
    expect(names).toContain("c-to-rust-plan");
  });

  it("missing tiers are simply absent, not an error", () => {
    const index = loadSkillIndex(path.join(tmpDir, "nope", ".ralph-flow"), path.join(tmpDir, "also-nope"));
    expect(index.diagnostics).toEqual([]);
    expect(index.skills.length).toBeGreaterThan(0); // built-ins still there
  });
});

describe("robustness", () => {
  it("a malformed SKILL.md does not sink the whole index", () => {
    const projectSkills = path.join(projectRalphDir, "skills");
    fs.mkdirSync(path.join(projectSkills, "broken"), { recursive: true });
    fs.writeFileSync(path.join(projectSkills, "broken", "SKILL.md"), "no frontmatter here");
    writeSkill(projectSkills, "fine", "a good skill");

    const index = loadSkillIndex(projectRalphDir, null);
    expect(index.skills.some((s) => s.name === "fine")).toBe(true);
    expect(index.skills.some((s) => s.name === "c-to-rust-plan")).toBe(true); // built-ins unaffected
  });
});

describe("formatSkillReport", () => {
  it("lists skills with their tier and what they shadow", () => {
    writeSkill(path.join(projectRalphDir, "skills"), "c-to-rust-plan", "project version");
    const report = formatSkillReport(loadSkillIndex(projectRalphDir, null));
    expect(report).toContain("c-to-rust-plan");
    expect(report).toContain("项目自定义");
    expect(report).toContain("遮蔽了同名内置");
  });

  it("says so when there are none", () => {
    // Point every tier somewhere empty, including the built-in dir.
    const report = formatSkillReport({ skills: [], paths: [], diagnostics: [] });
    expect(report).toContain("没有找到任何 skill");
  });
});

describe("built-in skills dir", () => {
  it("resolves to a real directory inside the package", () => {
    expect(fs.existsSync(getBuiltinSkillsDir())).toBe(true);
  });
});
