/**
 * The launch flow: pick a workflow, describe the task — a form, not a chat.
 *
 * A deterministic pipeline is launched, not conversed with, so the entry point
 * is a picker + a text field, not an LLM turn. (Designing a NEW workflow IS a
 * conversation — that lives in the separate `ralphflow create` mode.)
 *
 * These helpers drive the shared TUI: they swap in a picker / input as the root,
 * resolve a promise on selection, and leave the TUI clean for the run view.
 */

import type { Engine } from "../engine/core.js";
import { Component, Container, Input, SelectList, Text, TUI, matchesKey, Key, getSelectListTheme } from "../pi/tui.js";
import { bold, dim } from "./render.js";

export interface LaunchChoice {
  kind: "start" | "resume" | "quit";
  workflow?: string;
  task?: string;
  instanceId?: string;
}

/** Swap the TUI root to a single component (clearing prior children). */
function setRoot(tui: TUI, ...components: Component[]): void {
  tui.clear();
  for (const c of components) tui.addChild(c);
  tui.requestRender();
}

function heading(text: string): Component {
  return new Text(text, 1, 1);
}

/**
 * Full launch flow. Resolves with the user's choice. Resume takes priority: if
 * live instances exist, offer to attach before starting something new.
 */
export async function runLauncher(tui: TUI, engine: Engine): Promise<LaunchChoice> {
  const instances = engine.listInstances();
  if (instances.length > 0) {
    const resumeChoice = await pickResumeOrNew(tui, engine, instances);
    if (resumeChoice.kind !== "start") return resumeChoice; // resume or quit
    // fall through to the new-workflow flow
  }

  const workflow = await pickWorkflow(tui, engine);
  if (!workflow) return { kind: "quit" };

  const task = await enterTask(tui, workflow);
  if (task === null) return { kind: "quit" };

  return { kind: "start", workflow, task };
}

/** When instances already exist: resume one, start new, or quit. */
function pickResumeOrNew(tui: TUI, engine: Engine, instances: ReturnType<Engine["listInstances"]>): Promise<LaunchChoice> {
  return new Promise((resolve) => {
    const items = [
      ...instances.map((i) => ({
        value: `resume:${i.id}`,
        label: `恢复 ${i.state.workflow_name} · ${i.state.current_step}`,
        description: (i.state.user_task || "").replace(/\s+/g, " ").slice(0, 60),
      })),
      { value: "new", label: "开始一个新工作流", description: "选择工作流并输入任务" },
    ];
    const list = new SelectList(items, 10, getSelectListTheme());
    list.onSelect = (item) => {
      if (item.value === "new") resolve({ kind: "start" });
      else resolve({ kind: "resume", instanceId: item.value.slice("resume:".length) });
    };
    list.onCancel = () => resolve({ kind: "quit" });
    setRoot(tui, heading(bold("有未完成的工作流") + dim("  ↑↓ 选择 · 回车确认 · Esc 退出")), list);
    tui.setFocus(list);
  });
}

/** Pick a workflow from the resolved list (project → global → built-in). */
function pickWorkflow(tui: TUI, engine: Engine): Promise<string | null> {
  return new Promise((resolve) => {
    const workflows = engine.listWorkflows().filter((w) => !w.invalid);
    if (workflows.length === 0) { resolve(null); return; }
    const items = workflows.map((w) => ({ value: w.name, label: w.name, description: w.desc }));
    const list = new SelectList(items, 12, getSelectListTheme());
    list.onSelect = (item) => resolve(item.value);
    list.onCancel = () => resolve(null);
    setRoot(tui, heading(bold("选择工作流") + dim("  ↑↓ 选择 · 回车确认 · Esc 退出")), list);
    tui.setFocus(list);
  });
}

/** Capture the task description. Resolves null on Esc. */
function enterTask(tui: TUI, workflow: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = new Input();
    (input as any).placeholder = "描述这次要完成的任务，回车开始…";
    input.onSubmit = (value: string) => {
      const task = value.trim();
      if (task) resolve(task); // empty → keep waiting
    };
    input.onEscape = () => resolve(null);
    setRoot(tui,
      heading(bold(`工作流：${workflow}`) + dim("  回车开始 · Esc 退出")),
      new Text(dim("引擎会逐步执行，每步一个全新会话，独立验证。你可以随时看到进度。"), 1, 0),
      input);
    tui.setFocus(input);
  });
}
