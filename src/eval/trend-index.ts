#!/usr/bin/env node
// ============================================================================
// EVAL:TREND — Historical trend reporting over eval-history.jsonl
// ============================================================================
// Usage:
//   npm run eval:trend
//   npm run eval:trend -- --history results/eval-history.jsonl
//   npm run eval:trend -- --mode strict
//   npm run eval:trend -- --eval judge-evaluation
//
// Reads the JSONL history log produced by `npm run eval -- --history <path>`
// and prints per eval+model time series with regime-change markers wherever
// the judge model/version, judge prompt, or eval spec changed between runs.

import { fileURLToPath } from "node:url";
import { loadHistory, buildTrends } from "./history.js";
import { printTrends } from "./report.js";
import type { TrendMode } from "./history.js";

const DEFAULT_HISTORY_PATH = "results/eval-history.jsonl";

interface TrendArgs {
  historyPath: string;
  mode: TrendMode;
  evalFilter?: string;
}

export function parseTrendArgs(rawArgs: string[]): TrendArgs {
  let historyPath = DEFAULT_HISTORY_PATH;
  let mode: TrendMode = "all";
  let evalFilter: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run eval:trend -- [OPTIONS]",
          "",
          "Options:",
          `  --history <path>   JSONL history file to read (default: ${DEFAULT_HISTORY_PATH})`,
          "  --mode strict|all  strict: only runs comparable to the latest judge/prompt/eval config",
          "                     all (default): every run, with regime-change markers",
          "  --eval <name>      Filter to a single eval_name",
        ].join("\n"),
      );
      process.exit(0);
    } else if (arg === "--history" && rawArgs[i + 1]) {
      historyPath = rawArgs[++i]!;
    } else if (arg === "--mode" && rawArgs[i + 1]) {
      const value = rawArgs[++i]!;
      if (value !== "strict" && value !== "all") {
        throw new Error(
          `Invalid --mode "${value}": expected "strict" or "all"`,
        );
      }
      mode = value;
    } else if (arg === "--eval" && rawArgs[i + 1]) {
      evalFilter = rawArgs[++i];
    }
  }

  return { historyPath, mode, evalFilter };
}

export async function main(): Promise<void> {
  const args = parseTrendArgs(process.argv.slice(2));
  const entries = loadHistory(args.historyPath).filter(
    (e) => !args.evalFilter || e.evalName === args.evalFilter,
  );

  if (entries.length === 0) {
    console.log(
      `No history found at ${args.historyPath}. Run evals with "--history ${args.historyPath}" to start tracking trends.`,
    );
    return;
  }

  const groups = buildTrends(entries, args.mode);
  console.log(
    `\nTrend report (${args.mode === "strict" ? "strict-comparable" : "all runs"} mode) — ${groups.length} eval+model series\n`,
  );
  printTrends(groups);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(
      "eval:trend error:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
