#!/usr/bin/env node
// ============================================================================
// EVAL — Internal dev tool for testing and refining executant prompt templates
// ============================================================================
// Usage:
//   npm run eval -- evals/plan-decompose.eval.yaml
//   npm run eval -- --refine evals/plan-decompose.eval.yaml
//   npm run eval -- --refine --max-iter 3 evals/plan-decompose.eval.yaml

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEvalFile } from './load.js';
import { runPrompt } from './runner.js';
import { judgeAllCriteria } from './judge.js';
import { refinePrompt, saveRefinedTemplate } from './refine.js';
import {
  printRun, printRefinementHeader, printRefinementSuccess,
  printRefinementExhausted, printDiff,
} from './report.js';
import type { EvalArgs, EvalRun, FailureContext, TestResult } from './types.js';

export function parseArgs(rawArgs: string[]): EvalArgs {
  let refine = false;
  let maxIter = 5;
  let evalFile = '';

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === '#') break;  // # acts as an inline comment delimiter (shell-script usage: eval foo.yaml # note)
    if (arg === '--refine') { refine = true; }
    else if (arg === '--max-iter' && rawArgs[i + 1]) { maxIter = parseInt(rawArgs[++i]!, 10); }
    else if (!arg.startsWith('-') && !evalFile) { evalFile = arg; }  // first positional wins
  }

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log('Usage: npm run eval -- [--refine] [--max-iter N] <eval-file.yaml>');
    process.exit(0);
  }

  if (!evalFile) {
    throw new Error('Usage: npm run eval -- [--refine] [--max-iter N] <eval-file.yaml>');
  }

  return { evalFile, refine, maxIter };
}

async function runEval(evalFile: ReturnType<typeof loadEvalFile>, templatePath?: string): Promise<EvalRun> {
  const path = templatePath ?? evalFile.prompt;
  const results: TestResult[] = [];

  for (const tc of evalFile.testCases) {
    process.stdout.write(`  running ${tc.id}…`);
    const output = await runPrompt(path, tc.vars);
    const criteria = await judgeAllCriteria(output, tc.criteria);
    const passCount = criteria.filter((c) => c.pass).length;
    const failCount = criteria.length - passCount;
    results.push({ caseId: tc.id, output, criteria, passCount, failCount });
    process.stdout.write(` ${passCount}/${criteria.length}\n`);
  }

  const totalPass = results.reduce((s, r) => s + r.passCount, 0);
  const totalCriteria = results.reduce((s, r) => s + r.criteria.length, 0);

  return { evalName: evalFile.name, templatePath: path, results, totalPass, totalCriteria };
}

export function collectFailures(run: EvalRun, evalFile: ReturnType<typeof loadEvalFile>): FailureContext[] {
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

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const evalFile = loadEvalFile(args.evalFile);

  console.log(`\nEval: ${evalFile.name} (${evalFile.testCases.length} test case(s))`);

  let run = await runEval(evalFile);
  printRun(run);

  if (!args.refine || run.totalPass === run.totalCriteria) return;

  const originalTemplate = readFileSync(evalFile.prompt, 'utf8');
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
      bestTemplate = readFileSync(evalFile.prompt, 'utf8');
    }

    if (run.totalPass === run.totalCriteria) {
      printRefinementSuccess(iter);
      break;
    }

    if (iter === args.maxIter) {
      printRefinementExhausted(args.maxIter);
      if (bestRun !== run) {
        console.log('Restoring best-performing version…');
        writeFileSync(evalFile.prompt, bestTemplate, 'utf8');
      }
    }
  }

  const finalTemplate = readFileSync(evalFile.prompt, 'utf8');
  printDiff(originalTemplate, finalTemplate);
}

// Only run when invoked directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('eval error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
