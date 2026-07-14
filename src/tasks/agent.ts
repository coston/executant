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
  const p = task.provider ?? process.env["EXECUTANT_PROVIDER"] ?? "claude";
  if (p === "claude" || p === "opencode") return p;
  throw new Error(
    `Unsupported provider "${p}". Expected "claude" or "opencode". ` +
      `Check the EXECUTANT_PROVIDER env var or the step's provider: field.`,
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
 */
export async function runAgentStructured<T>(
  task: Omit<ClaudeTask, "jsonSchema">,
  schema: ZodType<T>,
): Promise<T> {
  switch (resolveAgentProvider(task as ClaudeTask)) {
    case "claude":
      return runClaudeStructured(task, schema);
    case "opencode":
      return runOpenCodeStructured(task, schema);
  }
}
