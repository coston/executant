// ============================================================================
// AGENT DISPATCH LAYER
// ============================================================================
// Routes prompt steps to the appropriate coding-agent CLI backend.
// Providers: "claude" (default) | "opencode"
//
// Resolution order for provider:
//   1. task.provider field
//   2. EXECUTANT_PROVIDER env var
//   3. "claude" (built-in default)
//
// Resolution order for model:
//   1. task.model field
//   2. EXECUTANT_MODEL env var
//   3. undefined (provider CLI picks its own default)

import type { ZodType } from "zod";
import type { AgentProvider, ClaudeTask, Event } from "../types.js";
import { runClaude, runClaudeStructured } from "./claude.js";
import { runOpenCode, runOpenCodeStructured } from "./opencode.js";

/**
 * Resolves which provider should execute a task.
 * Checks task.provider first, then EXECUTANT_PROVIDER env var, then defaults to "claude".
 * Throws if the resolved value is not a recognised AgentProvider.
 */
export function resolveAgentProvider(
  task: Pick<ClaudeTask, "provider">,
): AgentProvider {
  return assertProvider(
    task.provider ?? process.env["EXECUTANT_PROVIDER"] ?? "claude",
    "the EXECUTANT_PROVIDER env var or the step's provider: field",
  );
}

/**
 * Resolves which provider grades a step, from EXECUTANT_JUDGE_PROVIDER,
 * defaulting to "claude".
 *
 * Deliberately its own knob rather than following EXECUTANT_PROVIDER. Grading
 * is a judgement about work the step already finished, so it is reasonable to
 * want a capable model marking output that a smaller local one produced — and
 * equally reasonable to want the whole run on one CLI. Reading the step's
 * provider would silently take the first choice away; defaulting to "claude"
 * keeps the long-standing behaviour for anyone who sets nothing.
 */
export function resolveJudgeProvider(): AgentProvider {
  return assertProvider(
    process.env["EXECUTANT_JUDGE_PROVIDER"] ?? "claude",
    "the EXECUTANT_JUDGE_PROVIDER env var",
  );
}

function assertProvider(value: string, source: string): AgentProvider {
  if (value === "claude" || value === "opencode") return value;
  throw new Error(
    `Unsupported provider "${value}". Expected "claude" or "opencode". ` +
      `Check ${source}.`,
  );
}

/**
 * Resolves which model a task should run with.
 * Checks task.model first, then the EXECUTANT_MODEL env var.
 * Returns undefined when neither is set — the provider CLI uses its default.
 */
export function resolveAgentModel(
  task: Pick<ClaudeTask, "model">,
): string | undefined {
  return task.model ?? process.env["EXECUTANT_MODEL"];
}

/**
 * Runs a prompt step through the resolved provider, yielding typed Events.
 * For claude: delegates to runClaude.
 * For opencode: delegates to runOpenCode.
 */
export async function* runAgent(task: ClaudeTask): AsyncGenerator<Event> {
  switch (resolveAgentProvider(task)) {
    case "claude":
      yield* runClaude(task);
      return;
    case "opencode":
      yield* runOpenCode(task);
      return;
  }
}

/**
 * Runs a prompt step through the resolved provider and returns a schema-validated result.
 * For claude: uses --json-schema for structured output with Zod fallback.
 * For opencode: uses prompt-and-parse fallback (no native --json-schema support).
 *
 * A structured call returns a value rather than streaming, so its events have
 * nowhere to go by default and the cost of every one of them went unreported.
 * `onEvent` is the seam back out: callers that sit inside a generator can
 * forward what they care about — cost and token usage — into the run's stream.
 */
export async function runAgentStructured<T>(
  task: Omit<ClaudeTask, "jsonSchema">,
  schema: ZodType<T>,
  onEvent?: (event: Event) => void,
): Promise<T> {
  switch (resolveAgentProvider(task as ClaudeTask)) {
    case "claude":
      return runClaudeStructured(task, schema, onEvent);
    case "opencode":
      return runOpenCodeStructured(task, schema, onEvent);
  }
}
