#!/usr/bin/env node
// ============================================================================
// EVAL REPORT GENERATOR
// ============================================================================
// Merges per-eval CSVs from results/ and asks Claude to write a markdown
// benchmark report. Runs automatically at the end of `npm run eval:compare`.
//
// Usage:
//   npm run eval:compare:report
//
// Outputs:
//   results/comparison.csv       — merged data from all results/*.csv files
//   results/comparison-report.md — Claude-written benchmark analysis

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../tasks/agent.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dir, "../../results");
const MERGED_CSV = join(RESULTS_DIR, "comparison.csv");
const REPORT_PATH = join(RESULTS_DIR, "comparison-report.md");

/**
 * Merges all CSV files in results/ that share the same header schema.
 * Files with a different header (e.g. workflow eval CSVs mixed in) are
 * skipped with a warning rather than producing a corrupt merged file.
 */
function mergeCsvFiles(): string {
  const files = readdirSync(RESULTS_DIR)
    .filter(
      (f) =>
        f.endsWith(".csv") &&
        f !== basename(MERGED_CSV) &&
        f !== basename(REPORT_PATH),
    )
    .map((f) => join(RESULTS_DIR, f));

  if (files.length === 0) {
    throw new Error(`No CSV files found in ${RESULTS_DIR}`);
  }

  let header = "";
  const rows: string[] = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const fileHeader = lines[0] ?? "";
    if (!header) {
      header = fileHeader;
    } else if (fileHeader !== header) {
      console.warn(
        `  Skipping ${basename(file)}: column schema doesn't match (expected ${header.split(",").length} columns, got ${fileHeader.split(",").length})`,
      );
      continue;
    }
    rows.push(...lines.slice(1));
  }

  if (!header) throw new Error("No valid CSV files with a header row found");
  return [header, ...rows].join("\n") + "\n";
}

async function generateReport(mergedCsv: string): Promise<string> {
  const prompt = `You are analyzing multi-model eval results from the Executant benchmark suite.

Below is a CSV of pass/fail judgments across models and eval dimensions.

\`\`\`csv
${mergedCsv.slice(0, 12000)}${mergedCsv.length > 12000 ? "\n... (truncated)" : ""}
\`\`\`

Write a concise markdown benchmark report with these sections:

## Overview
Total models compared, total criteria judged, evals covered.

## Pass Rate by Model
Markdown table: | Model | Pass | Total | % |

## Per-Eval Breakdown
For each eval_name: which model scored highest and by how much.

## Notable Findings
3–5 bullet points on differences between models or interesting patterns.

## Recommendations
Which model to use for which use case based on the data.

Be specific and data-driven. Use actual numbers. Keep it under 500 words.
Do not include a title — the caller adds one.`;

  const lines: string[] = [];
  for await (const event of runAgent({
    type: "claude",
    name: "eval:report-gen",
    prompt,
    allowedTools: [],
    permissionMode: "default",
  })) {
    if (event.type === "output:text") lines.push(event.text);
  }
  return lines.join("");
}

async function main(): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });

  console.log("Merging eval CSVs…");
  const merged = mergeCsvFiles();
  writeFileSync(MERGED_CSV, merged, "utf8");
  const rowCount = merged.split("\n").filter(Boolean).length - 1;
  console.log(`  ${rowCount} rows → ${MERGED_CSV}`);

  console.log("Generating benchmark report…");
  const body = await generateReport(merged);
  const report = `# Executant Benchmark Report\n\n${body}`;
  writeFileSync(REPORT_PATH, report, "utf8");
  console.log(`  → ${REPORT_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(
      "report-gen error:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
