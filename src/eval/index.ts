#!/usr/bin/env node
// ============================================================================
// EVAL — Internal dev tool for testing and refining executant prompt templates
// ============================================================================
// Usage:
//   npm run eval -- evals/plan-decompose.eval.yaml
//   npm run eval -- --refine evals/plan-decompose.eval.yaml
//   npm run eval -- --refine --max-iter 3 evals/plan-decompose.eval.yaml
//   npm run eval -- --models claude/sonnet,opencode/opencode-go/kimi-k2.6 evals/*.eval.yaml
//   npm run eval -- --models claude/sonnet,opencode/opencode-go/kimi-k2.6 \
//                   --output-json results/comparison.json \
//                   --output-csv results/comparison.csv \
//                   evals/plan-decompose.eval.yaml

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
import type {
  EvalArgs,
  EvalRun,
  EvalComparison,
  FailureContext,
  ModelTarget,
  ModelEvalRun,
  TestResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses a "provider/model" string into a ModelTarget.
 * The first "/" segment is the provider; everything after is the model name
 * (model names like "opencode-go/kimi-k2.6" can contain slashes).
 */
export function parseModelTarget(s: string): ModelTarget {
  const idx = s.indexOf("/");
  if (idx === -1) {
    throw new Error(
      `Invalid model target "${s}": expected "provider/model" (e.g. "claude/sonnet" or "opencode/opencode-go/kimi-k2.6")`,
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

export function parseArgs(rawArgs: string[]): EvalArgs {
  let refine = false;
  let maxIter = 5;
  let evalFile = "";
  const models: ModelTarget[] = [];
  let outputJson: string | undefined;
  let outputCsv: string | undefined;

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
    } else if (!arg.startsWith("-") && !evalFile) {
      evalFile = arg;
    } // first positional wins
  }

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(
      [
        "Usage: npm run eval -- [OPTIONS] <eval-file.yaml>",
        "",
        "Options:",
        "  --refine              Iteratively improve the prompt template",
        "  --max-iter N          Max refinement iterations (default: 5)",
        "  --models M1,M2,...    Compare multiple models, e.g. claude/sonnet,opencode/kimi",
        "  --output-json <path>  Write comparison JSON to file",
        "  --output-csv <path>   Write comparison CSV to file",
      ].join("\n"),
    );
    process.exit(0);
  }

  if (!evalFile) {
    throw new Error(
      "Usage: npm run eval -- [--refine] [--max-iter N] <eval-file.yaml>",
    );
  }

  return { evalFile, refine, maxIter, models, outputJson, outputCsv };
}

// ---------------------------------------------------------------------------
// Single-model eval run
// ---------------------------------------------------------------------------

async function runEval(
  evalFile: ReturnType<typeof loadEvalFile>,
  templatePath?: string,
  model?: ModelTarget,
): Promise<EvalRun> {
  const path = templatePath ?? evalFile.prompt;
  const results: TestResult[] = [];

  for (const tc of evalFile.testCases) {
    process.stdout.write(`  running ${tc.id}…`);
    const output = await runPrompt(path, tc.vars, model);
    const criteria = await judgeAllCriteria(output, tc.criteria);
    const passCount = criteria.filter((c) => c.pass).length;
    const failCount = criteria.length - passCount;
    results.push({ caseId: tc.id, output, criteria, passCount, failCount });
    process.stdout.write(` ${passCount}/${criteria.length}\n`);
  }

  const totalPass = results.reduce((s, r) => s + r.passCount, 0);
  const totalCriteria = results.reduce((s, r) => s + r.criteria.length, 0);

  return {
    evalName: evalFile.name,
    templatePath: path,
    results,
    totalPass,
    totalCriteria,
  };
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
  const caseIds = runs[0]?.results.map((r) => r.caseId) ?? [];
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
): Promise<EvalComparison> {
  const runs: ModelEvalRun[] = [];
  for (const model of models) {
    const label = modelLabel(model);
    console.log(`\n[${label}]`);
    const run = await runEval(evalFile, undefined, model);
    runs.push({ ...run, model });
    printRun(run);
  }

  return {
    evalName: evalFile.name,
    templatePath: evalFile.prompt,
    models,
    runs,
    comparisonTable: buildComparisonTable(runs),
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
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const evalFile = loadEvalFile(args.evalFile);

  console.log(
    `\nEval: ${evalFile.name} (${evalFile.testCases.length} test case(s))`,
  );

  // Multi-model comparison mode
  if (args.models.length > 1) {
    const comparison = await runMultiModelEval(evalFile, args.models);
    printComparison(comparison);

    if (args.outputJson) writeOutputFile(args.outputJson, toJson(comparison));
    if (args.outputCsv) writeOutputFile(args.outputCsv, toCsv(comparison));
    return;
  }

  // Single-model mode (default: Claude, or first entry in --models)
  const singleModel = args.models[0];
  let run = await runEval(evalFile, undefined, singleModel);
  printRun(run);

  // Write output files for single-model run too (wraps in a minimal comparison)
  if (args.outputJson || args.outputCsv) {
    const model = singleModel ?? {
      provider: "claude" as const,
      model: "sonnet",
    };
    const comparison: EvalComparison = {
      evalName: evalFile.name,
      templatePath: evalFile.prompt,
      models: [model],
      runs: [{ ...run, model }],
      comparisonTable: buildComparisonTable([{ ...run, model }]),
    };
    if (args.outputJson) writeOutputFile(args.outputJson, toJson(comparison));
    if (args.outputCsv) writeOutputFile(args.outputCsv, toCsv(comparison));
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
    run = await runEval(evalFile);
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
