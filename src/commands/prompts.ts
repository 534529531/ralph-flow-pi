/**
 * The eight slash-command prompt templates.
 *
 * Command names and most prose are a verbatim port of the plugin versions, so
 * the docs and the user's habits carry over. One section had to go, and it is
 * worth being explicit about which:
 *
 * The plugins' /ralphflow-start template spent half its length teaching the
 * model how to BE the working session — "execute the DO prompt you receive",
 * "output <promise>done</promise> on the last line", "acknowledge phase
 * transitions". None of that is true here. The main chat session is a control
 * surface; DO runs in its own session with its own context and its own
 * report_done tool. Leaving those instructions in would invite the chat model to
 * start doing the work itself, in the one context window we are trying to keep
 * clean.
 *
 * What replaced it is short: start the workflow, watch it, help when it stops.
 */

export interface CommandTemplate {
  description: string;
  /** $ARGUMENTS is replaced with whatever followed the slash command. */
  render(args: string): string;
}

function template(description: string, body: string): CommandTemplate {
  return {
    description,
    render: (args: string) => body.replace(/\$ARGUMENTS/g, args?.trim() ? args.trim() : "（未提供）"),
  };
}

export const COMMAND_PROMPTS: Record<string, CommandTemplate> = {
  "ralphflow-start": template(
    "Start a ralph-flow workflow",
    `Start a Ralph Flow workflow execution.

User input: $ARGUMENTS

User needs to specify both the workflow name and task description. If information is incomplete, ask the user:

- Only task, no workflow → ask which workflow to use
- Only workflow, no task → ask what to do
- Neither → ask for both

Do NOT guess which workflow to use - let the user choose.

Available workflows: use \`ralphflow_list\` tool to see.

Once information is complete, call the \`ralphflow_start\` tool to start the workflow.

**extra_dirs**: If the task's source material lives OUTSIDE the current project directory (e.g. migrating \`~/some-c-lib\` into this project), pass those directories in the optional \`extra_dirs\` parameter — the independent CHECK verifier works from the project directory and must be able to read the source material it verifies against. Each directory is validated at start; a nonexistent path refuses the start immediately. Do not guess: only pass paths the user actually mentioned.

Each start creates a new **workflow instance** (the response carries its instance id). A session can run several instances at once, and multiple sessions in the same project can each run their own too — starting a new one does NOT require finishing or cancelling an earlier one first. If you (or the user) lose track of what's running, \`ralphflow_status\`/\`ralphflow_list\` shows everything.

## How execution works

**You do not execute the steps.** After \`ralphflow_start\` returns, the engine runs the workflow on its own:

- Each **DO** step runs in a **separate, fresh AI session** — its own context window, its own tools. It ends by calling \`report_done\`.
- Each **CHECK** runs in another independent, read-only session that verifies the work against the step's check criteria and submits a \`verdict\`.
- Passing advances to the next step; failing retries it with the reason; too many failures pauses the workflow.

## After you call ralphflow_start, STOP. Your turn is over.

The engine drives everything on its own, and its progress renders into this conversation **automatically** — you do not display it and do not need to fetch it.

**Do NOT poll.** After starting a workflow, do NOT call \`ralphflow_status\` in a loop, do NOT read/tail/cat anything under \`.ralph-flow/\` (instances, sessions, logs) to track progress, and do NOT \`sleep\` and re-check. All of that is wasted work — the engine is autonomous and the user can already see what is happening. Even one \`ralphflow_status\` call here is unnecessary; a loop of them is a bug in your behavior, not progress.

**Only speak up again when there is something for a human to decide:**

- **Manual review** (📋): the workflow paused for the USER to review. Wait for them. Their \`/ralphflow-continue\` is the approval. If they want changes, relay them — do not approve on their behalf.
- **Paused** (max failures / config error / verification failure): explain why and what to do next.
- **Stopped driving**: a DO step went several turns without finishing. Help the user work out what it is stuck on.
- The **user asks** you something.

Until one of those happens, reply with one short sentence that the workflow has started, then wait silently. Do NOT call \`ralphflow_continue\` for normal steps — verification is automatic. It is only for: approving a manual review, resuming a paused workflow, or attaching to an interrupted instance.`),

  "ralphflow-continue": template(
    "Approve a manual review / resume or attach to a ralph-flow workflow",
    `Call the \`ralphflow_continue\` tool. It covers four situations:

User input: $ARGUMENTS

**Normal steps are automatic**: the engine runs DO and the independent verification on its own, and advances without help — you do NOT call this tool for them. \`ralphflow_continue\` is only for the cases below.

**Manual review approval**: When the user runs this command after a 📋 manual-step review, calling \`ralphflow_continue\` is their approval — it starts the independent verification. (Never call it on your own initiative during a manual review.)

**Paused workflow**: If the workflow was paused due to max failures:
1. Review the failure reason shown in \`/ralphflow-status\`
2. Fix the issues that caused the failure
3. Call \`ralphflow_continue\` — it resets the fail counter and retries the step

**Verification infrastructure failure** (⚠️ 验证未能运行): the verifier itself failed (quota/API/timeout), not the work. Nothing needs redoing and no failure was counted — once the underlying problem is fixed, \`ralphflow_continue\` re-runs the verification directly.

**Attach to an interrupted instance (new session), or pick among several this session owns**: If the user provided an instance id with this command, pass it as the \`instance\` argument (unique prefix allowed). Without an id:
- this session owns exactly one instance, or there's a single instance in the project → auto-attached
- this session owns more than one, or several unowned ones exist → the tool returns an instance list instead of guessing; show it to the user and ask which one, then call again with \`instance\`
- attaching to an instance interrupted mid-DO restarts that step; if it was interrupted after the step reported done, verification starts directly

After the tool returns, the engine resumes driving on its own. Briefly tell the user what happened, then STOP. Do NOT poll ralphflow_status or read anything under .ralph-flow/ to watch progress — it renders automatically. Speak up again only for a manual review, a pause, or a user question.`),

  "ralphflow-watch": template(
    "Re-attach the live run view to a workflow that's already running in the background",
    `Call the \`ralphflow_watch\` tool to re-attach to a workflow instance that is running in the background — one the user detached from earlier (Esc on the run view), or one adopted when this session started.

User input: $ARGUMENTS

- Without arguments it attaches to this session's instance if it owns exactly one (or the single active instance in the project). If this session owns several, or several unowned ones exist, the tool returns a list instead of guessing — show it to the user and ask which one, then call again with \`instance\`.
- If the user named an instance, pass it as the \`instance\` argument (unique prefix allowed).
- This does NOT approve, resume, or cancel anything by itself — it only opens the view onto whatever is already happening. If what's actually needed is approving a review or resuming a pause, use \`/ralphflow-continue\` instead.

After the tool returns, briefly tell the user what happened (attached and detached again / workflow completed / cancelled), then STOP. Do NOT call this again on your own initiative just because a workflow is still running in the background — the user asked to look this one time; you'll be told automatically (in this same conversation) when it actually needs a human.`),

  "ralphflow-status": template(
    "Show ralph-flow workflow status (this session's instance or all instances)",
    `Show Ralph Flow workflow status.

User input: $ARGUMENTS

Call the \`ralphflow_status\` tool:
- Without arguments it shows this session's instance if it owns exactly one, or an overview of ALL active instances in the project when this session owns none or several (id, workflow, step, state, owner session, last activity).
- If the user names an instance, pass it as the \`instance\` argument (unique prefix allowed) to inspect that instance.

Displayed per instance:
- Workflow name, current step and phase (do/check)
- State: running / verifying / waiting for manual review / paused (with reason)
- Failure count and last failure reason (if any)
- Owner session — an instance owned by another (or a since-closed) session can be taken over via \`ralphflow_continue\`
- Driving process — when another \`ralph\` process is running the instance, operate it there`),

  "ralphflow-list": template(
    "List available ralph-flow workflows and active instances",
    `List all available Ralph Flow workflows and active workflow instances.

Call the \`ralphflow_list\` tool to show:
- All workflow names with a brief description of each
- All active workflow instances in this project (id, workflow, step, state, owner session)

Workflows are resolved in order (a same-named workflow at an earlier tier shadows the later ones):
1. Project custom (.ralph-flow/workflows/) — this project only
2. Global custom (~/.config/ralph-flow-pi/workflows/) — all projects, survives updates
3. Built-in (bundled with ralph-flow-pi)`),

  "ralphflow-cancel": template(
    "Cancel a ralph-flow workflow instance",
    `Cancel a Ralph Flow workflow instance.

User input: $ARGUMENTS

Call the \`ralphflow_cancel\` tool to properly cancel the workflow: it aborts the running step and verification sessions, archives the final report to \`.ralph-flow/reports/\`, and removes the instance directory (including the sub-workflow state stack).

- Without arguments it cancels this session's instance, but ONLY when it owns exactly one (or there's a single instance in the project) — cancelling is destructive, so the tool deliberately refuses to guess among several and returns a list instead.
- To cancel a specific instance (e.g. one this session owns among several, or one owned by another/closed session), pass the \`instance\` argument (unique prefix allowed). If the tool returns an instance list instead, show it to the user and confirm which one to cancel — never guess on the user's behalf here.

Do NOT manually delete files — use the tool to ensure proper cleanup. Artifacts produced by the workflow are kept.`),

  "ralphflow-doctor": template(
    "Diagnose ralph-flow workflow definitions and instance state, explain problems, and offer fixes",
    `Diagnose the health of all Ralph Flow workflow definitions (project + global + built-in), skills, and instance state.

## Procedure

1. Call the \`ralphflow_doctor\` tool. It is read-only and returns a full diagnosis report:
   - Per-workflow verdict (launchable / broken) with the **complete** list of validation problems, not just the first one
   - Warnings on launchable workflows: silently skipped steps, unreachable steps, unresolvable \`{{...}}\` tokens, broken sub-workflow references, sub-workflow cycles, clamped/ignored \`adversarial_check\` fields
   - Shadowing: which file actually runs when several tiers define the same name, and when an invalid project file silently falls back to a built-in
   - YAML files ignored because they aren't workflow-shaped
   - Instance directories with missing/corrupt state.json
   - Available skills and which ones shadow which

2. Present the report to the user. For each problem, explain the root cause in plain language and what its consequence is (e.g. "this step was silently dropped — the workflow runs, but without it").

3. **Offer to fix.** If the user agrees (or asked for fixes up front), edit the offending YAML files directly, then call \`ralphflow_doctor\` again to confirm the report is clean. Repeat until no problems remain. Never edit built-in workflow files — if a built-in needs different behavior, copy it into \`.ralph-flow/workflows/\` and edit the copy (it shadows the built-in by name).

## Common problems → fixes

| Symptom in report | Fix |
|---|---|
| missing/invalid \`input\` / \`output\` / \`do\` / \`check\` / \`desc\` / \`on_pass\` / \`on_fail\` / \`max_fail_count\` | Add the missing field to that step. Every non-sub-workflow step needs all of: \`id\`, \`desc\`, \`do\`, \`check\`, \`input\`, \`output\`, \`on_pass\`, \`on_fail\`, \`max_fail_count\` (number ≥ 1) |
| step skipped silently | Same as above — the step is missing a required field; the rest of the workflow still validated, so it runs WITHOUT this step |
| \`on_pass\`/\`on_fail\` references unknown step | Fix the typo, or use \`done\` (valid for \`on_pass\` only, marks workflow completion) |
| \`manual_step\` references unknown step | Fix the step id in the top-level \`manual_step\` list (hard error by design: a typo'd review gate must never run gateless) |
| unreachable step | Wire it into the graph via some step's \`on_pass\`/\`on_fail\`, or delete it. Execution starts at the FIRST element of \`steps\` |
| no reachable step has \`on_pass: done\` | Point the final step's \`on_pass\` at \`done\` |
| unresolvable template token | Remove it. The engine resolves exactly one token, \`{{artifacts_dir}}\` (no spaces inside braces), and normally you don't need even that — every DO/CHECK prompt automatically carries a 产出目录 section |
| \`adversarial_check.model\` is a bare name | Use \`"provider/model"\` (e.g. \`"anthropic/claude-sonnet-4-5"\`, optionally \`:high\` for a thinking level). A bare name cannot be resolved and falls back to the default model |
| \`adversarial_check.agent\` is ignored | Delete it. ralph-flow-pi has no agent concept — the verifier's read-only sandbox is built in (read-only tools + a bash whitelist) |
| sub-workflow won't load | Fix the \`workflow:\` name or create the referenced workflow file |
| sub-workflow cycle | Break the cycle; nesting is capped at depth 5 and errors at runtime |
| invalid project file falling back to a built-in | Fix the project file — right now starting that name runs the BUILT-IN, not the user's version |
| corrupt instance state.json | The instance is unrecoverable; after the user confirms it's not needed, delete \`.ralph-flow/instances/<id>/\` |

To create a brand-new workflow instead of fixing one, suggest \`/ralphflow-create\`.`),

  "ralphflow-create": template(
    "Interactively design and create a custom ralph-flow workflow, validated and ready to run",
    `Interactively design a custom Ralph Flow workflow with the user, write it to \`.ralph-flow/workflows/<name>.yaml\`, and validate it with the \`ralphflow_doctor\` tool until it is clean and launchable.

User input: $ARGUMENTS

## Procedure

1. **Understand the process to automate.** Ask the user (in one round, don't interrogate):
   - What repeating process should the workflow run? What are its phases?
   - Where do they want a human review gate (workflow stops for their approval before verification)?
   - Should any phase reuse an existing workflow as a sub-workflow? (\`ralphflow_list\` shows what exists.)
   If the user already described all this, skip the questions and design directly.

2. **Design the step graph and present it** as a compact overview (step id → what it does → on_pass/on_fail targets) before writing the file. Adjust per feedback.

3. **Write the YAML** (kebab-case name). Ask the user for the scope, or default to project:
   - project-only → \`.ralph-flow/workflows/<name>.yaml\`
   - available in all projects → \`~/.config/ralph-flow-pi/workflows/<name>.yaml\` (global; survives updates)

   Create the directory if needed. If the name matches a built-in (\`loop\`, \`spec\`, \`c-to-rust\`, \`everything2rust\`), tell the user it will shadow the built-in and confirm that's intended.

4. **Validate**: call the \`ralphflow_doctor\` tool and check the new workflow's section. Fix every problem AND warning it reports for this workflow, re-run doctor, repeat until its verdict is "可启动" with no warnings.

5. **Hand off**: show the user the final step overview and tell them how to run it: \`/ralphflow-start\` with workflow \`<name>\` and their task description.

## YAML schema (exact — the engine validates all of this)

\`\`\`yaml
description: One-line description shown in ralphflow_list   # optional but recommended

manual_step:            # optional: step ids that pause for HUMAN review after DO, before verification
  - design

adversarial_check:      # optional: config for the independent CHECK session
  model: "anthropic/claude-sonnet-4-5"   # optional: verifier model, "provider/model"[:thinking].
                                         # Any provider works — verifying with a DIFFERENT model
                                         # than the one doing the work is the point of the design.
  timeout_ms: 3600000   # capped at 3600000 (1 hour)
  # system_prompt: ...  # optional extra system prompt for the checker
\`\`\`

\`\`\`yaml
steps:                  # required, non-empty; execution starts at the FIRST element
  - id: step-id         # required, unique string
    desc: 一句话说明     # required
    do: |               # required (unless this is a sub-workflow step)
      DO-phase instructions, executed by a fresh session with its own context.
    check: |            # required (unless sub-workflow step)
      CHECK-phase instructions, executed by an INDEPENDENT read-only verifier session.
    input: 上一步的产物或用户输入   # required: what this step consumes
    output: "result.md"            # required: what this step must produce
    on_pass: next-step-id          # required: step id, or "done" to finish the workflow
    on_fail: step-id               # required: step id to retry/fall back to ("done" NOT allowed)
    max_fail_count: 3              # required, number ≥ 1: pauses for the user after this many CHECK failures

  - id: delegate        # sub-workflow step: replaces do/check with:
    workflow: loop      # name of another workflow (nesting capped at depth 5, no cycles)
    desc: ...
    input: ...
    output: ...
    on_pass: done
    on_fail: delegate
    max_fail_count: 3
\`\`\`

Hard rules the engine enforces (violations make the file unlaunchable or silently drop steps):

- Every field above marked required is required **per step** — a step missing one is **silently skipped** while the rest of the workflow still runs. Never omit \`input\`/\`output\`.
- \`on_pass\`/\`on_fail\` must reference an existing step id (\`done\` valid only for \`on_pass\`).
- \`manual_step\` entries must match existing step ids — a typo is a hard error by design.
- **No template variables.** The engine resolves nothing except the internal \`{{artifacts_dir}}\` escape hatch, and you don't need it: every DO/CHECK prompt automatically carries a 产出目录 (artifacts directory) section. Write bare filenames in \`output\` (e.g. \`"plan.md"\`); the session knows to put them in the artifacts dir.

## Design best practices (apply these unless the user objects)

- **Every step gets a fresh context window.** Steps do NOT share conversation history — the ONLY things carried between them are the files in the artifacts dir and what \`input\`/\`output\` name. Write each step so it stands alone: if a step needs an earlier decision, say which file holds it.
- **\`do\` must demand real work**, not analysis: create files, run commands, produce the named output. The session ends DO by calling the \`report_done\` tool.
- **\`check\` is executed by an independent session that saw none of the DO conversation.** Write it as a self-contained verification recipe: which files to open, which commands to run, and concrete pass/fail criteria. Vague criteria ("代码质量好") make CHECK useless.
- **Checkpoint-list pattern** for open-ended tasks: first step decomposes the request into a \`checkpoints.md\` of objectively verifiable items each annotated with its verification method; later steps execute and tick them; their \`check\` re-verifies each item independently instead of trusting the ticks.
- **Light persona nudge in \`check\`** sharpens verification, e.g. opening with 「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」 Keep it one line — no heavyweight role setups.
- **Retry loops**: \`on_fail\` usually points at the step itself; point it at an earlier step only when a failure genuinely invalidates earlier output. \`max_fail_count\` 3–5 for bounded steps, large (e.g. 100) for grind-until-green loops.
- **Manual gates** where a wrong direction is expensive (plans, designs, destructive actions) — list those step ids in \`manual_step\`.
- **Language**: write \`do\`/\`check\` prose in the user's language.`),
};
