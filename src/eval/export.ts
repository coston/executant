// ============================================================================
// EVAL EXPORT
// ============================================================================
// Serializes EvalComparison results to JSON and CSV for benchmark analysis.
//
// CSV columns (one row per criterion judgment):
//   eval_name, template_path, case_id, criterion, model_label, provider, model,
//   pass, reason, duration_ms, cost_usd, run_at, repo, git_sha, judge_provider,
//   judge_model, judge_version, judge_prompt_hash, eval_hash, comparison_fingerprint
//
// Provenance and cost columns repeat the same value across every row of a run
// (like duration_ms already does) — the denormalized shape is optimized for
// pivot tables, not storage efficiency.

import type { EvalComparison, ModelTarget, RunProvenance } from "./types.js";

export function modelLabel(m: ModelTarget): string {
  return m.label ?? `${m.provider}/${m.model}`;
}

/** Serializes a comparison to pretty-printed JSON. */
export function toJson(comparison: EvalComparison): string {
  return JSON.stringify(comparison, null, 2);
}

const PROVENANCE_COLUMNS = [
  "run_at",
  "repo",
  "git_sha",
  "judge_provider",
  "judge_model",
  "judge_version",
  "judge_prompt_hash",
  "eval_hash",
  "comparison_fingerprint",
] as const;

function provenanceCells(p: RunProvenance): string[] {
  return [
    csvCell(p.runAt),
    csvCell(p.repo ?? ""),
    csvCell(p.gitSha ?? ""),
    csvCell(p.judgeProvider),
    csvCell(p.judgeModel),
    csvCell(p.judgeVersion ?? ""),
    csvCell(p.judgePromptHash),
    csvCell(p.evalHash),
    csvCell(p.comparisonFingerprint),
  ];
}

/** Serializes a comparison to CSV — one row per criterion judgment per model. */
export function toCsv(comparison: EvalComparison): string {
  const header = [
    "eval_name",
    "template_path",
    "case_id",
    "criterion",
    "model_label",
    "provider",
    "model",
    "pass",
    "reason",
    "duration_ms",
    "cost_usd",
    ...PROVENANCE_COLUMNS,
  ].join(",");

  const rows: string[] = [header];

  for (const run of comparison.runs) {
    const label = modelLabel(run.model);
    for (const result of run.results) {
      for (const c of result.criteria) {
        rows.push(
          [
            csvCell(comparison.evalName),
            csvCell(comparison.templatePath),
            csvCell(result.caseId),
            csvCell(c.criterion),
            csvCell(label),
            csvCell(run.model.provider),
            csvCell(run.model.model),
            c.pass ? "true" : "false",
            csvCell(c.reason),
            String(result.durationMs),
            result.costUsd !== undefined ? String(result.costUsd) : "",
            ...provenanceCells(comparison.provenance),
          ].join(","),
        );
      }
    }
  }

  return rows.join("\n") + "\n";
}

/** Wraps a cell value in double quotes, escaping any internal double quotes. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
