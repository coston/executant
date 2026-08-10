// ============================================================================
// FAILURE RETROSPECTIVE
// ============================================================================
// When a step fails fatally the run stops, and the user is left with an error
// message and a scrollback of output. This module turns that into a post-mortem:
// what the root cause was, and whether the workflow file itself is at fault.
//
// The retrospective evaluates the workflow definition alongside the failure, so
// it can advise on things only visible at the file level — a var that resolved
// to nothing, a repeat count too low to converge, a fragile step that should
// carry self_healing. When those apply it also emits a `refineInstruction`,
// which the TUI offers to run through `executant refine` on the user's behalf.

import { z } from "zod";
import { dump as dumpYaml } from "js-yaml";
import { runAgentStructured } from "./tasks/agent.js";
import { fillTemplate, loadPrompt } from "./lib/utils.js";
import type { ClaudeTask, Retrospective, Task, Workflow } from "./types.js";

const RETROSPECTIVE_PROMPT = loadPrompt("step-retrospective");

/** Caps on prompt inputs — a verbose step must not blow up the analysis call. */
const MAX_OUTPUT_CHARS = 8_000;
const MAX_WORKFLOW_CHARS = 12_000;
const MAX_STEP_DETAIL_CHARS = 4_000;

/**
 * Hard ceiling on the analysis call. The run has already failed; a post-mortem
 * that cannot be produced quickly is not worth blocking the exit for.
 */
export const RETROSPECTIVE_TIMEOUT_SECONDS = 120;

const RetrospectiveSchema = z.object({
  summary: z.string(),
  rootCause: z.string(),
  evidence: z.array(z.string()).optional(),
  suggestions: z
    .array(
      z.object({
        step: z.string().optional(),
        issue: z.string(),
        change: z.string(),
        severity: z.enum(["high", "medium", "low"]).optional(),
      }),
    )
    .optional(),
  workflowFixable: z.boolean(),
  refineInstruction: z.string().optional(),
});

/** Fills in the fields the model is allowed to omit. */
export function normalizeRetrospective(
  stepName: string,
  result: z.infer<typeof RetrospectiveSchema>,
): Retrospective {
  const refineInstruction = result.refineInstruction?.trim() ?? "";
  return {
    step: stepName,
    summary: result.summary,
    rootCause: result.rootCause,
    evidence: result.evidence ?? [],
    suggestions: (result.suggestions ?? []).map((s) => ({
      ...s,
      severity: s.severity ?? "medium",
    })),
    // A fixable verdict with no instruction leaves the UI offering a button
    // that would do nothing — treat it as advice-only instead.
    workflowFixable: result.workflowFixable && refineInstruction.length > 0,
    refineInstruction,
  };
}

/** Retrospectives cost an API call per failure — opt out with EXECUTANT_RETROSPECTIVE=0. */
export function isRetrospectiveEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["EXECUTANT_RETROSPECTIVE"] !== "0";
}

/** Keeps the tail — the end of a failing command's output is where the cause is. */
function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…(truncated)…\n${text.slice(-max)}`;
}

function truncateHead(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)…`;
}

/**
 * Renders the workflow for the analysis prompt. The original YAML is preferred
 * because that is the file the user would edit and the one `refine` rewrites;
 * in-memory workflows fall back to an equivalent YAML dump of the parsed tasks.
 */
export function describeWorkflow(workflow: Workflow): string {
  const text =
    workflow.source ??
    dumpYaml({
      goal: workflow.goal,
      vars: workflow.vars,
      steps: workflow.tasks,
    });
  return truncateHead(text, MAX_WORKFLOW_CHARS);
}

/** Everything the runner knows about a failure, gathered as the step ran. */
export interface RetrospectiveInput {
  workflow: Workflow;
  /** The step that failed. For forEach steps this is the container. */
  task: Task;
  error: Error;
  /** Last lines of the failing step's combined stdout/stderr. */
  lastOutput?: string;
  /**
   * Judge verdicts and self-healing attempts observed during the step, oldest
   * first. For a step that died to judge exhaustion this carries the only
   * record of *why* each attempt was rejected — the error message does not.
   */
  qualityHistory?: string[];
  /** Where in a forEach/repeat the failure happened, when applicable. */
  position?: string;
}

export function buildRetrospectivePrompt(input: RetrospectiveInput): string {
  const { workflow, task, error, lastOutput, qualityHistory, position } = input;
  return fillTemplate(RETROSPECTIVE_PROMPT, {
    STEP_NAME: position ? `${task.name} — ${position}` : task.name,
    STEP_DETAIL: truncateHead(
      JSON.stringify(task, null, 2),
      MAX_STEP_DETAIL_CHARS,
    ),
    ERROR: error.message,
    OUTPUT: truncateTail(
      lastOutput ?? "(no output captured)",
      MAX_OUTPUT_CHARS,
    ),
    QUALITY_HISTORY: qualityHistory?.length
      ? qualityHistory.join("\n")
      : "(none — this step ran no judge or self-healing loop)",
    WORKFLOW: describeWorkflow(workflow),
  });
}

/**
 * Produces a post-mortem for a failed step. The analysis agent gets no tools —
 * it reasons only from the error, the captured output, and the workflow file,
 * so it can never mutate the project while the run is already failing.
 *
 * Returns null if the analysis itself fails: a broken retrospective must never
 * mask or replace the original step failure the user needs to see.
 *
 * The call is time-boxed. It sits between the step failing and the error being
 * rethrown, so an agent CLI that stalls (auth prompt, rate limit, dead network)
 * would otherwise hold the whole run open indefinitely on its way to reporting
 * a failure the user already knows about.
 */
export async function generateRetrospective(
  input: RetrospectiveInput,
): Promise<Retrospective | null> {
  const analysis: Omit<ClaudeTask, "jsonSchema"> = {
    type: "claude",
    name: `retrospective:${input.task.name}`,
    prompt: buildRetrospectivePrompt(input),
    allowedTools: [],
    permissionMode: "default",
    // No provider/model pinned: the analysis runs on whatever the user
    // configured via EXECUTANT_PROVIDER/EXECUTANT_MODEL, falling back to
    // Claude. Pinning would spawn a `claude` binary an OpenCode-only machine
    // does not have, and every failure would announce an analysis that never
    // arrives.
    timeoutSeconds: RETROSPECTIVE_TIMEOUT_SECONDS,
  };

  try {
    return normalizeRetrospective(
      input.task.name,
      await runAgentStructured(analysis, RetrospectiveSchema),
    );
  } catch {
    return null;
  }
}
