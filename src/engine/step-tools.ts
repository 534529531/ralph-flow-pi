/**
 * Custom tools injected into every DO step session.
 *
 * `report_done` is the replacement for `<promise>done</promise>`. The plugin
 * versions asked the model to end its message with that tag and then regex'd it
 * back out — which needed rules for the last line, the last 100 characters, and
 * stripping code fences, and still misfired when a model explained the tag
 * instead of emitting it, or kept talking after it. A tool call is unambiguous:
 * it either happened or it didn't, and prose can never look like one.
 */

import { Type } from "typebox";
import type { Engine } from "./core.js";
import { defineTool, type ToolDefinition } from "../pi/adapter.js";

/**
 * The DO session's only way to end its step.
 *
 * Calling it writes the .done-reported marker; the runner's keep-alive loop
 * watches for that and moves on to CHECK. Nothing here judges the work — that is
 * the independent verifier's job, and keeping this tool dumb is what stops the
 * worker from grading its own homework.
 */
export function makeReportDoneTool(engine: Engine, instId: string): ToolDefinition {
  return defineTool({
    name: "report_done",
    label: "Report Done",
    description:
      "在本步骤的所有任务要求和输出要求都满足后调用，声明 DO 阶段完成。这是结束本步骤的唯一方式。" +
      "完成后会有一个独立的只读会话来验证你的工作，所以不要在工作未完成时调用。",
    parameters: Type.Object({
      summary: Type.Optional(Type.String({
        description: "一句话说明你做了什么（可选，仅用于日志与报告；验证者不会看到它，只会看你的实际产出）。",
      })),
    }),
    execute: async (_toolCallId, params) => {
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";
      // writeDoneReported no-ops on a destroyed instance, so a cancel racing this
      // call cannot resurrect the instance dir.
      engine.writeDoneReported(instId);
      engine.logEvent(instId, "info", "done_reported", { summary: summary.slice(0, 200) });
      return {
        content: [{ type: "text" as const, text: "已记录：DO 阶段完成。接下来由独立的只读会话验证本步骤，你无需再做其他事。" }],
        details: {},
      };
    },
  }) as unknown as ToolDefinition;
}
