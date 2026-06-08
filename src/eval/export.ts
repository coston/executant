// ============================================================================
// EVAL EXPORT
// ============================================================================
// Serializes EvalComparison results to JSON and CSV for white-paper analysis.
//
// CSV columns (one row per criterion judgment):
//   eval_name, template_path, case_id, criterion, model_label, provider, model, pass, reason

import type { EvalComparison, ModelTarget } from "./types.js";

export function modelLabel(m: ModelTarget): string {
  return m.label ?? `${m.provider}/${m.model}`;
}

/** Serializes a comparison to pretty-printed JSON. */
export function toJson(comparison: EvalComparison): string {
  return JSON.stringify(comparison, null, 2);
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
