import type { EvalComparison, EvalRun, TestResult } from "./types.js";
import type { TrendGroup } from "./history.js";
import { modelLabel } from "./export.js";
import { theme } from "../ui/theme.js";
import { formatDuration } from "../lib/utils.js";

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];

// Terminal-only path — Ink is unavailable here, so convert theme hex values to ANSI directly
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
  const pct = total === 0 ? 0 : passCount / total;
  const bars = 10;
  const filled = Math.round(pct * bars);
  const bar = "█".repeat(filled) + "░".repeat(bars - filled);
  if (!USE_COLOR) return `${bar} ${passCount}/${total}`;
  const colorFn = pct === 1 ? pass : pct >= 0.5 ? warning : fail;
  return `${colorFn(bar)} ${passCount}/${total}`;
}

function printTestResult(result: TestResult): void {
  const icon = result.failCount === 0 ? pass("✓") : fail("✗");
  console.log(
    `  ${icon} ${accent(result.caseId)}  ${scoreBar(result.passCount, result.passCount + result.failCount)}`,
  );

  for (const c of result.criteria) {
    if (c.pass) {
      console.log(`      ${pass("·")} ${dim(c.criterion)}`);
    } else {
      console.log(`      ${fail("·")} ${c.criterion}`);
      console.log(`          ${dim(c.reason)}`);
    }
  }
}

export function printRun(run: EvalRun): void {
  const allPass = run.totalPass === run.totalCriteria;
  const icon = allPass ? pass("✓") : fail("✗");
  console.log(
    `\n${icon} ${accent(run.evalName)}  ${scoreBar(run.totalPass, run.totalCriteria)}\n`,
  );
  for (const result of run.results) {
    printTestResult(result);
    console.log();
  }
}

export function printRefinementHeader(iter: number, maxIter: number): void {
  console.log(
    `\n${accent(`[refine ${iter}/${maxIter}]`)} Running eval after refinement…`,
  );
}

export function printRefinementSuccess(iter: number): void {
  console.log(
    pass(`\n✓ All criteria pass after ${iter} refinement iteration(s).`),
  );
}

export function printRefinementExhausted(maxIter: number): void {
  console.log(
    fail(
      `\n✗ Max refinement iterations (${maxIter}) reached. Best version saved.`,
    ),
  );
}

export function printDiff(original: string, refined: string): void {
  if (original === refined) {
    console.log(dim("\n(No changes made to template.)"));
    return;
  }
  const origLines = original.split("\n").length;
  const newLines = refined.split("\n").length;
  const delta = newLines - origLines;
  const sign = delta >= 0 ? "+" : "";
  console.log(
    dim(
      `\nTemplate updated: ${origLines} → ${newLines} lines (${sign}${delta})`,
    ),
  );
}

/**
 * Prints a side-by-side comparison table for multi-model eval runs.
 *
 * Example output:
 *   judge-evaluation — 2 models compared
 *
 *                       claude/sonnet   opencode/llama-qwen7b/qwen2.5-coder-7b
 *     clear-pass            3/3  100%        3/3  100%
 *     clear-fail            2/3   67%        3/3  100%
 *     ──────────────────────────────────────────────────
 *     TOTAL                7/9   78%        9/9  100%
 */
export function printComparison(comparison: EvalComparison): void {
  const labels = comparison.models.map(modelLabel);
  const colWidth = Math.max(16, ...labels.map((l) => l.length + 4));

  const header = `${accent(comparison.evalName)} — ${comparison.models.length} models compared`;
  console.log(`\n${header}\n`);

  // Column header row
  const caseColWidth = Math.max(
    12,
    ...comparison.comparisonTable.map((r) => r.caseId.length),
    5, // "TOTAL"
  );
  const headerRow =
    " ".repeat(caseColWidth + 4) +
    labels.map((l) => l.padEnd(colWidth)).join("");
  console.log(dim(headerRow));

  // Per-case rows
  for (const row of comparison.comparisonTable) {
    const cells = labels.map((l) => {
      const s = row.scores[l];
      if (!s) return " ".repeat(colWidth);
      const pct = Math.round(s.pct * 100);
      const score = `${s.pass}/${s.total}  ${pct}%`;
      const colorFn = s.pct === 1 ? pass : s.pct >= 0.5 ? warning : fail;
      return colorFn(score).padEnd(colWidth + (USE_COLOR ? 20 : 0));
    });
    const casePad = row.caseId.padEnd(caseColWidth);
    console.log(`  ${accent(casePad)}  ${cells.join("")}`);
  }

  // Separator
  console.log(
    dim("  " + "─".repeat(caseColWidth + 2 + colWidth * labels.length)),
  );

  // Totals row
  const totalCells = labels.map((l) => {
    const run = comparison.runs.find((r) => modelLabel(r.model) === l);
    if (!run) return " ".repeat(colWidth);
    const pct = run.totalCriteria === 0 ? 0 : run.totalPass / run.totalCriteria;
    const pctInt = Math.round(pct * 100);
    const score = `${run.totalPass}/${run.totalCriteria}  ${pctInt}%`;
    const colorFn = pct === 1 ? pass : pct >= 0.5 ? warning : fail;
    return colorFn(score).padEnd(colWidth + (USE_COLOR ? 20 : 0));
  });
  console.log(`  ${"TOTAL".padEnd(caseColWidth)}  ${totalCells.join("")}\n`);
}

/**
 * Prints time-series trend lines for `npm run eval:trend` — one section per
 * eval+model group, oldest run first, with a marker row wherever the judge
 * model/version, judge prompt, or eval spec changed since the previous run
 * (so score jumps caused by a regime change read as a regime change, not a
 * mysterious improvement or regression).
 */
export function printTrends(groups: TrendGroup[]): void {
  for (const group of groups) {
    console.log(
      `\n${accent(group.evalName)} — ${dim(group.modelLabel)} (${group.points.length} run(s))\n`,
    );
    for (const point of group.points) {
      if (point.regimeChange) {
        console.log(
          warning(
            "  ─── regime change: judge/prompt/eval fingerprint differs from previous run ───",
          ),
        );
      }
      const pctInt = Math.round(point.pct * 100);
      const colorFn =
        point.pct === 1 ? pass : point.pct >= 0.5 ? warning : fail;
      const score = colorFn(
        `${point.passCount}/${point.totalCriteria}  ${pctInt}%`,
      );
      const cost =
        point.costUsd !== undefined ? `$${point.costUsd.toFixed(4)}` : "n/a";
      const sha = point.gitSha ? point.gitSha.slice(0, 7) : "unknown";
      console.log(
        `  ${dim(point.runAt)}  ${accent(sha)}  ${score}  ${dim(cost)}  ${dim(formatDuration(point.durationMs))}`,
      );
    }
  }
  console.log();
}
