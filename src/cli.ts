#!/usr/bin/env node
/**
 * ralph — entry point.
 *
 * No verb → interactive TUI (the normal way to use this).
 * A verb → headless one-shot for scripts/CI.
 */

import { runHeadless } from "./headless.js";

const HELP = `ralphflow — DO → CHECK 工作流引擎（每个步骤运行在全新、隔离的 AI 会话中）

用法：
  ralphflow                    通用聊天——可以直接让我跑工作流（"用 spec 工作流帮我实现一个登录接口"），
                                启动后会接管终端显示实时运行视图，Esc 可随时切回聊天
  ralphflow create [描述]      同一个聊天，预置一句设计新工作流的开场白
  ralphflow status [实例ID]    查看实例状态（不带 ID 时列出全部）
  ralphflow list               列出可用工作流与活跃实例
  ralphflow doctor             诊断所有工作流定义与 skill
  ralphflow continue [实例ID]  不进交互界面，恢复暂停/审查门/崩溃的实例，
                                跑到下一个停点（再次暂停或完成）再返回
  ralphflow cancel [实例ID]    取消实例并归档报告
  ralphflow --help             显示本帮助

工作流定义（YAML）解析顺序：项目 .ralph-flow/workflows/ → 全局 ~/.config/ralph-flow-pi/workflows/ → 内置。
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (argv.length === 0) {
    // The default entry: a general chat, same as `create`. Starting a
    // workflow (natural language or /ralphflow-start) takes over the
    // terminal with the dedicated run view for the duration of the run — see
    // tui/embed.ts. The standalone picker-first run view (tui/run-app.ts's
    // runApp) still exists but is no longer wired to any CLI verb.
    const { runChat } = await import("./tui/app.js");
    await runChat(process.cwd());
    return;
  }

  if (argv[0] === "create") {
    // Designing a NEW workflow is a genuine conversation, so it uses the chat
    // surface (the one place chat fits) rather than the run view.
    const { runCreateMode } = await import("./tui/app.js");
    await runCreateMode(process.cwd(), argv.slice(1).join(" "));
    return;
  }

  const { text, code } = await runHeadless(argv[0], argv.slice(1), process.cwd());
  (code === 0 ? process.stdout : process.stderr).write(text.endsWith("\n") ? text : text + "\n");
  process.exitCode = code;
}

main().catch((e: any) => {
  process.stderr.write(`ralph: ${e?.stack || e?.message || String(e)}\n`);
  process.exitCode = 1;
});
