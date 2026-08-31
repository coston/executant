// ============================================================================
// EVAL HISTORY
// ============================================================================
// Persists one JSONL record per model/eval per comparison run (score, cost,
// duration, provenance) so trends can be tracked over time, and groups those
// records into per eval+model trend lines for `npm run eval:trend`.
//
// Two trend modes:
//   "strict" — only runs whose comparisonFingerprint matches the most recent
//              run in the group (judge/prompt/eval unchanged)
//   "all"    — every historical run, with regime-change points flagged so
//              judge/prompt/eval drift is explicit rather than hidden

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { modelLabel } from "./export.js";
import type { EvalComparison } from "./types.js";

interface HistoryEntry {
  runAt: string;
  repo?: string;
  gitSha?: string;
  evalName: string;
  modelLabel: string;
  provider: string;
  model: string;
  passCount: number;
  totalCriteria: number;
  pct: number;
  costUsd?: number;
  durationMs: number;
  judgeProvider: string;
  judgeModel: string;
  judgeVersion?: string;
  judgePromptHash: string;
  evalHash: string;
  comparisonFingerprint: string;
}

/** One row per model run in the comparison, carrying the run's shared provenance. */
export function toHistoryEntries(comparison: EvalComparison): HistoryEntry[] {
  const { provenance } = comparison;
  return comparison.runs.map((run) => ({
    runAt: provenance.runAt,
    repo: provenance.repo,
    gitSha: provenance.gitSha,
    evalName: comparison.evalName,
    modelLabel: modelLabel(run.model),
    provider: run.model.provider,
    model: run.model.model,
    passCount: run.totalPass,
    totalCriteria: run.totalCriteria,
    pct: run.totalCriteria === 0 ? 0 : run.totalPass / run.totalCriteria,
    costUsd: run.totalCostUsd,
    durationMs: run.results.reduce((s, r) => s + r.durationMs, 0),
    judgeProvider: provenance.judgeProvider,
    judgeModel: provenance.judgeModel,
    judgeVersion: provenance.judgeVersion,
    judgePromptHash: provenance.judgePromptHash,
    evalHash: provenance.evalHash,
    comparisonFingerprint: provenance.comparisonFingerprint,
  }));
}

/** Appends one JSONL line per model run in the comparison to `historyPath`. */
export function appendHistory(
  comparison: EvalComparison,
  historyPath: string,
): void {
  const entries = toHistoryEntries(comparison);
  if (entries.length === 0) return;
  mkdirSync(dirname(historyPath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  appendFileSync(historyPath, lines, "utf8");
}

/** Reads all history records from a JSONL file. Returns [] if the file doesn't exist. */
export function loadHistory(historyPath: string): HistoryEntry[] {
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as HistoryEntry);
}

export type TrendMode = "strict" | "all";

export interface TrendPoint extends HistoryEntry {
  /** True when this point's comparisonFingerprint differs from the previous point in its group. */
  regimeChange: boolean;
}

export interface TrendGroup {
  evalName: string;
  modelLabel: string;
  points: TrendPoint[];
}

/**
 * Groups history entries by eval+model into time-ordered trend lines.
 * "strict" keeps only runs matching the group's most recent comparisonFingerprint
 * (guaranteed judge/prompt/eval comparability); "all" keeps every run and marks
 * the points where the fingerprint changed.
 */
export function buildTrends(
  entries: HistoryEntry[],
  mode: TrendMode,
): TrendGroup[] {
  const byGroup = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const key = `${entry.evalName}::${entry.modelLabel}`;
    const group = byGroup.get(key);
    if (group) group.push(entry);
    else byGroup.set(key, [entry]);
  }

  const groups: TrendGroup[] = [];
  for (const [key, groupEntries] of byGroup) {
    const [evalName, label] = key.split("::") as [string, string];
    const sorted = [...groupEntries].sort((a, b) =>
      a.runAt.localeCompare(b.runAt),
    );
    const latestFingerprint = sorted.at(-1)?.comparisonFingerprint;
    const selected =
      mode === "strict"
        ? sorted.filter((e) => e.comparisonFingerprint === latestFingerprint)
        : sorted;

    const points: TrendPoint[] = selected.map((entry, i) => ({
      ...entry,
      regimeChange:
        i > 0 &&
        selected[i - 1]!.comparisonFingerprint !== entry.comparisonFingerprint,
    }));
    groups.push({ evalName, modelLabel: label, points });
  }

  return groups.sort(
    (a, b) =>
      a.evalName.localeCompare(b.evalName) ||
      a.modelLabel.localeCompare(b.modelLabel),
  );
}
