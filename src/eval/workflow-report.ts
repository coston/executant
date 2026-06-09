// ============================================================================
// WORKFLOW EVAL REPORT
// ============================================================================
// Prints a side-by-side comparison table for workflow eval results.

import type { WorkflowComparison, WorkflowEvalResult } from "./types.js";
import { modelLabel } from "./export.js";
import { theme } from "../ui/theme.js";

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];

function hexToAnsi(hex: string): (s: string) => string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (s: string) =>
    USE_COLOR ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s;
}

const color =
  (code: string) =>
  (s: string): string =>
    USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;

const pass = hexToAnsi(theme.success);
const fail = hexToAnsi(theme.error);
const warning = hexToAnsi(theme.warning);
const accent = hexToAnsi(theme.primary);
const dim = color("2");

function scoreBar(passCount: number, total: number): string {
  if (total === 0) return dim("n/a");
  const pct = passCount / total;
  const bars = 8;
  const filled = Math.round(pct * bars);
  const bar = "█".repeat(filled) + "░".repeat(bars - filled);
  const colorFn = pct === 1 ? pass : pct >= 0.5 ? warning : fail;
  if (!USE_COLOR) return `${bar} ${passCount}/${total}`;
  return `${colorFn(bar)} ${passCount}/${total}`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r > 0 ? `${r}s` : ""}`;
}

function printResultDetail(result: WorkflowEvalResult): void {
  const label = modelLabel(result.model);
  const testIcon = result.testsPassed ? pass("✓") : fail("✗");
  const judgePass = result.judgeResults.filter((r) => r.pass).length;
  const judgeTotal = result.judgeResults.length;
  const stats = result.diffStats;

  console.log(
    `\n${testIcon} ${accent(label)}  tests:${result.testsPassed ? pass("pass") : fail("fail")}  ` +
      `judge:${scoreBar(judgePass, judgeTotal)}  ` +
      `diff:${stats.filesChanged}f +${stats.insertions}/-${stats.deletions}  ` +
      `time:${dim(fmtDuration(result.durationMs))}`,
  );

  for (const c of result.judgeResults) {
    if (c.pass) {
      console.log(`    ${pass("·")} ${dim(c.criterion)}`);
    } else {
      console.log(`    ${fail("·")} ${c.criterion}`);
      console.log(`        ${dim(c.reason)}`);
    }
  }
}

/**
 * Prints a full workflow eval comparison: per-model details + summary table.
 */
export function printWorkflowComparison(comparison: WorkflowComparison): void {
  console.log(
    `\n${accent(comparison.taskName)} — ${comparison.results.length} model(s)\n` +
      `${dim(comparison.taskGoal)}\n`,
  );

  for (const result of comparison.results) {
    printResultDetail(result);
    console.log();
  }

  if (comparison.results.length < 2) return;

  // Summary comparison table
  const labels = comparison.results.map((r) => modelLabel(r.model));
  const colWidth = Math.max(16, ...labels.map((l) => l.length + 4));
  const caseColWidth = 14;

  console.log(
    dim("  " + "─".repeat(caseColWidth + 2 + colWidth * labels.length)),
  );

  const headerRow =
    " ".repeat(caseColWidth + 4) +
    labels.map((l) => l.padEnd(colWidth)).join("");
  console.log(dim(headerRow));

  // Tests row
  const testCells = comparison.results.map((r) => {
    const v = r.testsPassed ? pass("✓ pass") : fail("✗ fail");
    return v.padEnd(colWidth + (USE_COLOR ? 20 : 0));
  });
  console.log(`  ${"tests".padEnd(caseColWidth)}  ${testCells.join("")}`);

  // Judge row
  const judgeCells = comparison.results.map((r) => {
    const p = r.judgeResults.filter((j) => j.pass).length;
    const total = r.judgeResults.length;
    const pct = total === 0 ? 0 : p / total;
    const pctStr = `${p}/${total} ${Math.round(pct * 100)}%`;
    const colorFn = pct === 1 ? pass : pct >= 0.5 ? warning : fail;
    return colorFn(pctStr).padEnd(colWidth + (USE_COLOR ? 20 : 0));
  });
  console.log(`  ${"judge".padEnd(caseColWidth)}  ${judgeCells.join("")}`);

  // Duration row
  const timeCells = comparison.results.map((r) =>
    dim(fmtDuration(r.durationMs)).padEnd(colWidth + (USE_COLOR ? 20 : 0)),
  );
  console.log(`  ${"duration".padEnd(caseColWidth)}  ${timeCells.join("")}\n`);
}

/** Serialises workflow comparison to CSV — one row per criterion per model. */
export function toWorkflowCsv(comparison: WorkflowComparison): string {
  const header = [
    "task_name",
    "task_goal",
    "model_label",
    "provider",
    "model",
    "tests_passed",
    "workflow_exit_code",
    "files_changed",
    "insertions",
    "deletions",
    "duration_ms",
    "criterion",
    "criterion_pass",
    "criterion_reason",
  ].join(",");

  const rows: string[] = [header];
  for (const result of comparison.results) {
    const label = modelLabel(result.model);
    const base = [
      csvCell(comparison.taskName),
      csvCell(comparison.taskGoal),
      csvCell(label),
      csvCell(result.model.provider),
      csvCell(result.model.model),
      result.testsPassed ? "true" : "false",
      String(result.workflowExitCode),
      String(result.diffStats.filesChanged),
      String(result.diffStats.insertions),
      String(result.diffStats.deletions),
      String(result.durationMs),
    ].join(",");
    for (const c of result.judgeResults) {
      rows.push(
        `${base},${csvCell(c.criterion)},${c.pass ? "true" : "false"},${csvCell(c.reason)}`,
      );
    }
  }
  return rows.join("\n") + "\n";
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
