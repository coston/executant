// ============================================================================
// RUN REPORT
// ============================================================================
// Aggregates duration/cost/token totals across a completed run, records what
// actually happened step by step (judge/healing history — the direct
// evidence of where prompting fell short), and — only when asked — generates
// a one-sentence efficiency suggestion grounded in that history rather than
// just a structural reading of the task file. Pure aggregation helpers
// (emptyUsage/addUsage/computeOverflow/buildRunReport/formatNarrative) have
// no side effects; generateEfficiencySuggestion is the only part that makes
// an API call, and it never throws — a broken or slow suggestion must never
// affect the run it's reporting on.

import { z } from "zod";
import { runAgentStructured } from "./tasks/agent.js";
import { fillTemplate, formatDuration, loadPrompt } from "./lib/utils.js";
import { describeWorkflow } from "./retrospective.js";
import type { RunReport, StepSummary, TokenUsage, Workflow } from "./types.js";

const EFFICIENCY_PROMPT = loadPrompt("efficiency-suggestion");

/**
 * Anthropic bills a request's input tokens above this many at a higher rate.
 * Applied per call, not as a running session total — see computeOverflow.
 */
export const CONTEXT_OVERFLOW_THRESHOLD = 200_000;

/**
 * Hard ceiling on the suggestion call. Unlike v1, this is no longer inline
 * in the run's own critical path by default — it's either an explicit opt-in
 * (EXECUTANT_REPORT_SUGGESTION=1, for automation that wants it every time) or
 * a user-triggered TUI action after the run has already finished and exited
 * its own timing pressure. Ten minutes gives Haiku real room to read the run
 * narrative carefully without needing a bigger, slower model.
 */
const SUGGESTION_TIMEOUT_SECONDS = 600;

/** Longest a single step's formatted narrative block may be, defensively. */
const MAX_STEP_NARRATIVE_CHARS = 2_000;

/**
 * Off by default — an automatic API call on every single run would disturb
 * CI/automated usage that never asked for it. Opt in with
 * EXECUTANT_REPORT_SUGGESTION=1 for a run that should always get one, or
 * trigger it on demand instead (the TUI offers a keypress once the free part
 * of the report is on screen — see src/ui/ReportPrompt.tsx).
 */
export function isEfficiencySuggestionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["EXECUTANT_REPORT_SUGGESTION"] === "1";
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** A call's total context size: everything that counts toward the pricing tier. */
function callContextSize(u: TokenUsage): number {
  return u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

/**
 * Sums the excess over CONTEXT_OVERFLOW_THRESHOLD across calls that
 * individually crossed it. Many small calls that add up to a lot of tokens
 * across a run never trigger this — only a single call whose own context was
 * that large, matching how the extended-context rate is actually billed.
 */
export function computeOverflow(usageEvents: readonly TokenUsage[]): {
  overflowTokens: number;
  overflowCalls: number;
} {
  return usageEvents.reduce(
    (acc, u) => {
      const size = callContextSize(u);
      if (size <= CONTEXT_OVERFLOW_THRESHOLD) return acc;
      return {
        overflowTokens:
          acc.overflowTokens + (size - CONTEXT_OVERFLOW_THRESHOLD),
        overflowCalls: acc.overflowCalls + 1,
      };
    },
    { overflowTokens: 0, overflowCalls: 0 },
  );
}

/** Assembles the final RunReport from the totals runWorkflow accumulated. */
export function buildRunReport(params: {
  durationMs: number;
  totalCostUsd: number;
  usageEvents: readonly TokenUsage[];
  stepNarrative: readonly StepSummary[];
  suggestion?: string;
}): RunReport {
  const totalTokens = params.usageEvents.reduce(addUsage, emptyUsage());
  const { overflowTokens, overflowCalls } = computeOverflow(params.usageEvents);
  return {
    durationMs: params.durationMs,
    totalCostUsd: params.totalCostUsd,
    totalTokens,
    overflowTokens,
    overflowCalls,
    stepNarrative: [...params.stepNarrative],
    ...(params.suggestion ? { suggestion: params.suggestion } : {}),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Renders the run narrative as plain text for the suggestion prompt: one
 * block per step, its timing/cost, and — the part that actually matters here
 * — every judge/healing event it went through, in order. A step with no
 * entries passed clean on the first attempt; that absence is itself
 * information (nothing to flag), so it's stated explicitly rather than left
 * to be inferred from an empty list.
 */
export function formatNarrative(stepNarrative: readonly StepSummary[]): string {
  if (stepNarrative.length === 0) return "(no steps ran)";
  return stepNarrative
    .map((s, i) => {
      const header = `Step ${i + 1}: "${s.name}" (${formatDuration(s.durationMs)}, $${s.costUsd.toFixed(4)})${s.failed ? " — FAILED (continue_on_error)" : ""}`;
      const body =
        s.qualityEvents.length > 0
          ? s.qualityEvents.map((e) => `  ${e}`).join("\n")
          : "  no quality-control events — passed clean on the first attempt";
      return truncate(`${header}\n${body}`, MAX_STEP_NARRATIVE_CHARS);
    })
    .join("\n\n");
}

const SuggestionSchema = z.object({ suggestion: z.string() });

/**
 * Runs one Haiku call, no tools, asking for a single efficiency idea grounded
 * in what actually happened during the run — not just a structural reading
 * of the task file. Best-effort: any failure (timeout, rate limit, malformed
 * response) yields undefined so the rest of the report ships without it —
 * this is strictly additive, never a dependency of the report.
 */
export async function generateEfficiencySuggestion(
  workflow: Workflow,
  stepNarrative: readonly StepSummary[],
): Promise<string | undefined> {
  try {
    const result = await runAgentStructured(
      {
        type: "claude",
        name: "report:efficiency-suggestion",
        prompt: fillTemplate(EFFICIENCY_PROMPT, {
          WORKFLOW: describeWorkflow(workflow),
          NARRATIVE: formatNarrative(stepNarrative),
        }),
        allowedTools: [],
        permissionMode: "default",
        model: "haiku",
        provider: "claude",
        timeoutSeconds: SUGGESTION_TIMEOUT_SECONDS,
      },
      SuggestionSchema,
    );
    const suggestion = result.suggestion.trim();
    return suggestion.length > 0 ? suggestion : undefined;
  } catch {
    return undefined;
  }
}
