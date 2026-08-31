#!/usr/bin/env node
// ============================================================================
// EVAL — Internal dev tool for testing and refining executant prompt templates
// ============================================================================
// Usage:
//   npm run eval -- evals/plan-decompose.eval.yaml
//   npm run eval -- --refine evals/plan-decompose.eval.yaml
//   npm run eval -- --refine --max-iter 3 evals/plan-decompose.eval.yaml
//   npm run eval -- --cases simple-feature,1-3 evals/plan-decompose.eval.yaml
//   npm run eval -- --models claude/sonnet,opencode/llama-qwen7b/qwen2.5-coder-7b evals/*.eval.yaml
//   npm run eval -- --models claude/sonnet,opencode/llama-qwen7b/qwen2.5-coder-7b \
//                   --output-json results/comparison.json \
//                   --output-csv results/comparison.csv \
//                   evals/plan-decompose.eval.yaml evals/judge-evaluation.eval.yaml

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalFile } from "./load.js";
import { runPrompt } from "./runner.js";
import { judgeAllCriteria } from "./judge.js";
import { refinePrompt, saveRefinedTemplate } from "./refine.js";
import {
  printRun,
  printComparison,
  printRefinementHeader,
  printRefinementSuccess,
  printRefinementExhausted,
  printDiff,
} from "./report.js";
import { toJson, toCsv, modelLabel } from "./export.js";
import { DEFAULT_MODEL } from "../lib/utils.js";
import { buildProvenance } from "./provenance.js";
import { appendHistory } from "./history.js";
import type {
  EvalArgs,
  EvalRun,
  EvalComparison,
  EvalTestCase,
  FailureContext,
  ModelTarget,
  ModelEvalRun,
  RunProvenance,
  TestResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// CSV resume helpers
// ---------------------------------------------------------------------------

/** Parses one CSV line produced by toCsv(), handling quoted fields and "" escapes. */
function parseCSVLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let cell = "";
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else cell += line[i++];
      }
      cells.push(cell);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) {
        cells.push(line.slice(i));
        break;
      }
      cells.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return cells;
}

/**
 * Reads an existing output CSV and returns cached results keyed by
 * modelLabel → caseId → TestResult. Used to skip already-complete cases.
 */
export function loadExistingResults(
  csvPath: string,
): Map<string, Map<string, TestResult>> {
  const byModel = new Map<string, Map<string, TestResult>>();
  if (!existsSync(csvPath)) return byModel;

  const lines = readFileSync(csvPath, "utf8").trim().split("\n");
  if (lines.length < 2) return byModel;

  const header = parseCSVLine(lines[0]);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCSVLine(line);
    const label = cells[col["model_label"]] ?? "";
    const caseId = cells[col["case_id"]] ?? "";
    const criterion = cells[col["criterion"]] ?? "";
    const pass = cells[col["pass"]] === "true";
    const reason = cells[col["reason"]] ?? "";
    const durationMs = parseInt(cells[col["duration_ms"]] ?? "0", 10);
    const costCell = cells[col["cost_usd"]];
    const costUsd =
      costCell !== undefined && costCell !== "" ? Number(costCell) : undefined;

    if (!byModel.has(label)) byModel.set(label, new Map());
    const byCase = byModel.get(label)!;

    if (!byCase.has(caseId)) {
      byCase.set(caseId, {
        caseId,
        output: "",
        criteria: [],
        passCount: 0,
        failCount: 0,
        durationMs,
        costUsd,
      });
    }
    const result = byCase.get(caseId)!;
    result.criteria.push({ criterion, pass, reason });
    if (pass) result.passCount++;
    else result.failCount++;
  }

  return byModel;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses a "provider/model" string into a ModelTarget.
 * The first "/" segment is the provider; everything after is the model name
 * (model names like "llama-qwen7b/qwen2.5-coder-7b" can contain slashes).
 */
export function parseModelTarget(s: string): ModelTarget {
  const idx = s.indexOf("/");
  if (idx === -1) {
    throw new Error(
      `Invalid model target "${s}": expected "provider/model" (e.g. "claude/sonnet" or "opencode/llama-qwen7b/qwen2.5-coder-7b")`,
    );
  }
  const provider = s.slice(0, idx);
  const model = s.slice(idx + 1);
  if (provider !== "claude" && provider !== "opencode") {
    throw new Error(
      `Invalid provider "${provider}" in model target "${s}": expected "claude" or "opencode"`,
    );
  }
  return { provider: provider as "claude" | "opencode", model };
}

/**
 * Filters test cases by a comma-separated spec of case IDs and/or index ranges.
 * - "simple-feature,complex-case" → those two IDs
 * - "1-3" → cases at 1-based indices 1 through 3
 * - "1-3,named-case" → mixed
 * Warns when a named ID matches nothing.
 */
export function applyCaseFilter(
  testCases: EvalTestCase[],
  filter: string,
): EvalTestCase[] {
  const parts = filter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = new Set<string>();

  for (const part of parts) {
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = Math.max(1, parseInt(rangeMatch[1]!, 10));
      const end = Math.min(testCases.length, parseInt(rangeMatch[2]!, 10));
      for (let i = start - 1; i < end; i++) ids.add(testCases[i]!.id);
    } else {
      ids.add(part);
    }
  }

  // Warn on IDs that don't match any case
  for (const id of ids) {
    if (!testCases.some((tc) => tc.id === id)) {
      process.stderr.write(
        `[eval] warning: --cases filter "${id}" matched no test case\n`,
      );
    }
  }

  return testCases.filter((tc) => ids.has(tc.id));
}

export function parseArgs(rawArgs: string[]): EvalArgs {
  let refine = false;
  let maxIter = 5;
  const evalFiles: string[] = [];
  const models: ModelTarget[] = [];
  let outputJson: string | undefined;
  let outputCsv: string | undefined;
  let caseFilter: string | undefined;
  let historyPath: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "#") break; // # acts as an inline comment delimiter
    if (arg === "--refine") {
      refine = true;
    } else if (arg === "--max-iter" && rawArgs[i + 1]) {
      maxIter = parseInt(rawArgs[++i]!, 10);
    } else if (arg === "--models" && rawArgs[i + 1]) {
      const specs = rawArgs[++i]!.split(",");
      for (const spec of specs) models.push(parseModelTarget(spec.trim()));
    } else if (arg === "--output-json" && rawArgs[i + 1]) {
      outputJson = rawArgs[++i];
    } else if (arg === "--output-csv" && rawArgs[i + 1]) {
      outputCsv = rawArgs[++i];
    } else if (arg === "--cases" && rawArgs[i + 1]) {
      caseFilter = rawArgs[++i];
    } else if (arg === "--history" && rawArgs[i + 1]) {
      historyPath = rawArgs[++i];
    } else if (!arg.startsWith("-")) {
      evalFiles.push(arg);
    }
  }

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(
      [
        "Usage: npm run eval -- [OPTIONS] <eval-file.yaml> [more-files...]",
        "",
        "Options:",
        "  --refine              Iteratively improve the prompt template",
        "  --max-iter N          Max refinement iterations (default: 5)",
        "  --models M1,M2,...    Compare multiple models, e.g. claude/sonnet,opencode/kimi",
        "  --cases <filter>      Run a subset of cases: IDs or index ranges, e.g. simple,1-3",
        "  --output-json <path>  Write comparison JSON to file",
        "  --output-csv <path>   Write comparison CSV to file (supports resume)",
        "  --history <path>      Append a JSONL history record for trend tracking (see `npm run eval:trend`)",
      ].join("\n"),
    );
    process.exit(0);
  }

  if (evalFiles.length === 0) {
    throw new Error(
      "Usage: npm run eval -- [--refine] [--max-iter N] [--cases <filter>] <eval-file.yaml> [more-files...]",
    );
  }

  return {
    evalFiles,
    caseFilter,
    refine,
    maxIter,
    models,
    outputJson,
    outputCsv,
    historyPath,
  };
}

// ---------------------------------------------------------------------------
// Single-model eval run
// ---------------------------------------------------------------------------

async function runEval(
  evalFile: ReturnType<typeof loadEvalFile>,
  templatePath?: string,
  model?: ModelTarget,
  cached?: Map<string, TestResult>,
  caseFilter?: string,
): Promise<EvalRun> {
  const path = templatePath ?? evalFile.prompt;
  const cases = caseFilter
    ? applyCaseFilter(evalFile.testCases, caseFilter)
    : evalFile.testCases;
  const results: TestResult[] = [];
  let cachedCount = 0;

  for (const tc of cases) {
    const hit = cached?.get(tc.id);
    if (hit) {
      process.stdout.write(`  skipping ${tc.id} (cached)\n`);
      results.push(hit);
      cachedCount++;
      continue;
    }
    process.stdout.write(`  running ${tc.id}…`);
    const start = performance.now();
    let output: string;
    let costUsd: number | undefined;
    try {
      ({ output, costUsd } = await runPrompt(path, tc.vars, model));
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const msg = `run error: ${err instanceof Error ? err.message : String(err)}`;
      process.stdout.write(`eval error: ${msg}\n`);
      const criteria = tc.criteria.map((c) => ({
        criterion: c,
        pass: false,
        reason: msg,
      }));
      results.push({
        caseId: tc.id,
        output: "",
        criteria,
        passCount: 0,
        failCount: criteria.length,
        durationMs,
      });
      continue;
    }
    const durationMs = Math.round(performance.now() - start);
    const criteria = await judgeAllCriteria(output, tc.criteria);
    const passCount = criteria.filter((c) => c.pass).length;
    const failCount = criteria.length - passCount;
    results.push({
      caseId: tc.id,
      output,
      criteria,
      passCount,
      failCount,
      durationMs,
      costUsd,
    });
    process.stdout.write(` ${passCount}/${criteria.length}\n`);
  }

  const totalPass = results.reduce((s, r) => s + r.passCount, 0);
  const totalCriteria = results.reduce((s, r) => s + r.criteria.length, 0);
  const costs = results
    .map((r) => r.costUsd)
    .filter((c): c is number => typeof c === "number");
  const totalCostUsd =
    costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : undefined;

  return {
    evalName: evalFile.name,
    templatePath: path,
    results,
    totalPass,
    totalCriteria,
    totalCostUsd,
    cachedCount,
  };
}

/**
 * Appends to the history log only when every result in the comparison was
 * freshly executed. A resumed run reuses scores produced under the previous
 * run's provenance (different time, commit, possibly a different judge), so
 * appending them under today's provenance would fabricate a trend point.
 */
export function recordHistory(
  comparison: EvalComparison,
  historyPath: string,
): void {
  const cachedTotal = comparison.runs.reduce(
    (sum, run) => sum + (run.cachedCount ?? 0),
    0,
  );
  if (cachedTotal > 0) {
    console.log(
      `  Skipping history append: ${cachedTotal} case result(s) were reused from the output CSV, so this run's provenance does not describe them. Delete the CSV to re-run and record.`,
    );
    return;
  }
  appendHistory(comparison, historyPath);
}

export function collectFailures(
  run: EvalRun,
  evalFile: ReturnType<typeof loadEvalFile>,
): FailureContext[] {
  return run.results
    .filter((r) => r.failCount > 0)
    .map((r) => {
      const tc = evalFile.testCases.find((t) => t.id === r.caseId)!;
      return {
        caseId: r.caseId,
        vars: tc.vars,
        output: r.output,
        failedCriteria: r.criteria.filter((c) => !c.pass),
      };
    });
}

// ---------------------------------------------------------------------------
// Multi-model comparison
// ---------------------------------------------------------------------------

function buildComparisonTable(
  runs: ModelEvalRun[],
): EvalComparison["comparisonTable"] {
  // Use the union of all case IDs so a partial run from one model doesn't drop rows.
  const seen = new Set<string>();
  const caseIds: string[] = [];
  for (const run of runs) {
    for (const r of run.results) {
      if (!seen.has(r.caseId)) {
        seen.add(r.caseId);
        caseIds.push(r.caseId);
      }
    }
  }
  return caseIds.map((caseId) => {
    const scores: EvalComparison["comparisonTable"][number]["scores"] = {};
    for (const run of runs) {
      const label = modelLabel(run.model);
      const result = run.results.find((r) => r.caseId === caseId);
      const p = result?.passCount ?? 0;
      const total = p + (result?.failCount ?? 0);
      scores[label] = { pass: p, total, pct: total === 0 ? 0 : p / total };
    }
    return { caseId, scores };
  });
}

async function runMultiModelEval(
  evalFile: ReturnType<typeof loadEvalFile>,
  models: ModelTarget[],
  provenance: RunProvenance,
  existingCsv?: string,
  caseFilter?: string,
): Promise<EvalComparison> {
  const existing = existingCsv ? loadExistingResults(existingCsv) : new Map();
  const runs: ModelEvalRun[] = [];
  for (const model of models) {
    const label = modelLabel(model);
    console.log(`\n[${label}]`);
    const run = await runEval(
      evalFile,
      undefined,
      model,
      existing.get(label),
      caseFilter,
    );
    runs.push({ ...run, model });
    printRun(run);
  }

  return {
    evalName: evalFile.name,
    templatePath: evalFile.prompt,
    models,
    runs,
    comparisonTable: buildComparisonTable(runs),
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Output file writing
// ---------------------------------------------------------------------------

function writeOutputFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  console.log(`  Wrote ${filePath}`);
}

// ---------------------------------------------------------------------------
// Output path helper for multi-file runs
// ---------------------------------------------------------------------------

/**
 * Derives a per-eval output path when multiple eval files share a base path.
 * e.g. "results/out.csv" + "plan-decompose" → "results/out-plan-decompose.csv"
 */
function deriveOutputPath(base: string, evalName: string): string {
  const extMatch = /(\.[^./]+)$/.exec(base);
  if (extMatch) {
    return base.slice(0, -extMatch[1].length) + `-${evalName}` + extMatch[1];
  }
  return `${base}-${evalName}`;
}

// ---------------------------------------------------------------------------
// Run a single eval file (shared logic for single and multi-file modes)
// ---------------------------------------------------------------------------

async function runEvalFile(
  evalFilePath: string,
  args: EvalArgs,
  multiFile: boolean,
): Promise<void> {
  const evalFile = loadEvalFile(evalFilePath);
  const caseCount = args.caseFilter
    ? applyCaseFilter(evalFile.testCases, args.caseFilter).length
    : evalFile.testCases.length;

  const caseNote = args.caseFilter
    ? ` (${caseCount} of ${evalFile.testCases.length} after --cases filter)`
    : ` (${evalFile.testCases.length} test case(s))`;
  console.log(`\nEval: ${evalFile.name}${caseNote}`);

  // Derive output paths: when running multiple files, auto-suffix each path.
  const outputCsv =
    multiFile && args.outputCsv
      ? deriveOutputPath(args.outputCsv, evalFile.name)
      : args.outputCsv;
  const outputJson =
    multiFile && args.outputJson
      ? deriveOutputPath(args.outputJson, evalFile.name)
      : args.outputJson;

  const provenance = buildProvenance(evalFile);

  // Multi-model comparison mode
  if (args.models.length > 1) {
    if (args.refine) {
      console.warn(
        "Warning: --refine is ignored when comparing multiple models. Run with a single model to refine.",
      );
    }
    const comparison = await runMultiModelEval(
      evalFile,
      args.models,
      provenance,
      outputCsv,
      args.caseFilter,
    );
    printComparison(comparison);

    if (outputJson) writeOutputFile(outputJson, toJson(comparison));
    if (outputCsv) writeOutputFile(outputCsv, toCsv(comparison));
    if (args.historyPath) recordHistory(comparison, args.historyPath);
    return;
  }

  // Single-model mode — load cached results for resume support. When no
  // --models was given, resolve the same default runPrompt will actually use
  // (EXECUTANT_MODEL, then sonnet) and pass it explicitly, so the recorded
  // model label always names the model that ran — previously
  // `EXECUTANT_MODEL=haiku` runs were filed under "claude/sonnet".
  const model = args.models[0] ?? {
    provider: "claude" as const,
    model: process.env["EXECUTANT_MODEL"] ?? DEFAULT_MODEL,
  };
  const existing = outputCsv ? loadExistingResults(outputCsv) : new Map();
  let run = await runEval(
    evalFile,
    undefined,
    model,
    existing.get(modelLabel(model)),
    args.caseFilter,
  );
  printRun(run);

  // Write output files (wraps single-model run in a minimal comparison)
  if (outputJson || outputCsv || args.historyPath) {
    const comparison: EvalComparison = {
      evalName: evalFile.name,
      templatePath: evalFile.prompt,
      models: [model],
      runs: [{ ...run, model }],
      comparisonTable: buildComparisonTable([{ ...run, model }]),
      provenance,
    };
    if (outputJson) writeOutputFile(outputJson, toJson(comparison));
    if (outputCsv) writeOutputFile(outputCsv, toCsv(comparison));
    if (args.historyPath) recordHistory(comparison, args.historyPath);
  }

  if (!args.refine || run.totalPass === run.totalCriteria) return;

  // Refinement loop (only available in single-model mode)
  const originalTemplate = readFileSync(evalFile.prompt, "utf8");
  let bestRun = run;
  let bestTemplate = originalTemplate;

  for (let iter = 1; iter <= args.maxIter; iter++) {
    const failures = collectFailures(run, evalFile);

    console.log(`\nRefining template (${failures.length} failing case(s))…`);
    const improved = await refinePrompt(evalFile.prompt, failures);
    saveRefinedTemplate(evalFile.prompt, improved);

    printRefinementHeader(iter, args.maxIter);
    run = await runEval(evalFile, undefined, model, undefined, args.caseFilter);
    printRun(run);

    if (run.totalPass > bestRun.totalPass) {
      bestRun = run;
      bestTemplate = readFileSync(evalFile.prompt, "utf8");
    }

    if (run.totalPass === run.totalCriteria) {
      printRefinementSuccess(iter);
      break;
    }

    if (iter === args.maxIter) {
      printRefinementExhausted(args.maxIter);
      if (bestRun !== run) {
        console.log("Restoring best-performing version…");
        writeFileSync(evalFile.prompt, bestTemplate, "utf8");
      }
    }
  }

  const finalTemplate = readFileSync(evalFile.prompt, "utf8");
  printDiff(originalTemplate, finalTemplate);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const multiFile = args.evalFiles.length > 1;

  for (const evalFilePath of args.evalFiles) {
    await runEvalFile(evalFilePath, args, multiFile);
  }
}

// Only run when invoked directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(
      "eval error:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
