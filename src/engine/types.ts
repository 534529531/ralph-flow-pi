/**
 * Shared types for the ralph-flow-pi engine.
 *
 * The WORKFLOW SCHEMA (StepDef/WorkflowDef/AdversarialCheckConfig) is a verbatim
 * mirror of the opencode plugin's engine.ts so existing user YAML runs unchanged;
 * see SYNC.md. RalphFlowState is likewise mirrored — instance state files stay
 * semantically identical.
 */

export interface NormalStepDef {
  id: string;
  desc: string;
  do: string;
  input: string;
  output: string;
  check: string;
  on_pass: string;
  on_fail: string;
  max_fail_count: number;
}

export interface SubWorkflowStepDef {
  id: string;
  desc: string;
  workflow: string;
  inputs?: Record<string, string>;
  input: string;
  output: string;
  on_pass: string;
  on_fail: string;
  max_fail_count: number;
}

export type StepDef = NormalStepDef | SubWorkflowStepDef;

export interface AdversarialCheckConfig {
  /**
   * Accepted in both historical shapes. The string form ("provider/model" or
   * "provider/model:thinking") is what pi-ai resolves natively; the object form
   * is the opencode SDK's shape and is normalized to the string form at parse
   * time so downstream code only ever sees a string.
   */
  model?: string;
  /**
   * Accepted for YAML compatibility. pi has no agent concept — the verifier's
   * read-only sandbox is a tool-set preset instead, so this field only produces
   * a doctor warning.
   */
  agent?: string;
  system_prompt?: string;
  timeout_ms?: number;
  /**
   * Extra glob patterns merged into the CHECK bash whitelist for THIS
   * workflow only (same `*`-glob syntax as the built-in table in core.ts,
   * e.g. "./scripts/check.sh *", "just test*", "my-cli verify *"). Exists
   * because the built-in table is a fixed, hardcoded list that cannot know
   * about a project's own build tooling — a custom CLI, `just`, `bazel`,
   * `poetry run pytest`, etc. would otherwise have no way to run during
   * CHECK at all. Patterns still pass through every shell-escape guard in
   * check-bash.ts unchanged (command substitution, write redirection,
   * script-embedded writes) — this only adds entries to the "is this command
   * NAME allowed" table, nothing here weakens those checks. What it does NOT
   * do: sandbox what the allowed command does once it runs — same trust
   * boundary as the built-in `cargo test`/`npm test` entries (see
   * check-bash.ts's file header). The workflow author is trusting their own
   * project's script, same as running it locally.
   */
  extra_allowed_bash?: string[];
}

export interface WorkflowDef {
  name: string;
  description: string;
  manual_step: string[];
  steps: StepDef[];
  adversarial_check?: AdversarialCheckConfig;
}

export interface RalphFlowState {
  active: boolean;
  workflow_name: string;
  current_step: string;
  current_phase: string;
  fail_count: number;
  user_task: string;
  paused: boolean;
  pause_reason?: string;
  last_failure_reason?: string;
  instance_id?: string;
  /** The session that owns/drives this instance. Set by the tool that touches it. */
  session_id?: string;
}

export interface StepExecutionRecord {
  stepId: string;
  phase: string;
  status: "passed" | "failed";
  failCount: number;
  startTime: string;
  endTime?: string;
  reason?: string;
}

export interface CheckResult {
  passed: boolean;
  /** True when the check could not run at all (crash/timeout/no verdict) — not a work failure. */
  infra?: boolean;
  reason: string;
}

export interface InstanceInfo {
  id: string;
  state: RalphFlowState;
  owner: string | null; // state.session_id, or null if unclaimed
  manualGate: boolean;
  doneReported: boolean;
  lastActivity: Date | null;
}

export interface TransitionResult {
  text: string;
  paused?: boolean;
  completed?: boolean;
}

/**
 * Platform seam — the little the engine needs from the host.
 *
 * The opencode version only needed abortActiveCheck (the DO phase ran in the
 * host's own session, which the plugin could not abort). Here the engine owns
 * every session, so destroyInstance must be able to abort the step session too.
 */
export interface Platform {
  /** Abort a still-running adversarial check (in-process handle). */
  abortActiveCheck?(instId: string): void;
  /** Abort a still-running DO step session (in-process handle). */
  abortActiveStep?(instId: string): void;
}

export type PermissionAction = "allow" | "deny" | "ask";

export function isSubWorkflowStep(step: StepDef): step is SubWorkflowStepDef {
  return "workflow" in step && typeof (step as SubWorkflowStepDef).workflow === "string";
}

/**
 * Strip UTF-8 BOM (Byte Order Mark) from file content.
 * Windows Notepad and some editors add BOM to UTF-8 files.
 * js-yaml and JSON.parse don't handle BOM, causing parse failures.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
