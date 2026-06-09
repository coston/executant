#!/usr/bin/env node
// ============================================================================
// EVAL:WORKFLOW — End-to-end agentic evaluation CLI
// ============================================================================
// Usage:
//   npm run eval:workflow -- --models claude/sonnet evals/workflow/task.yaml
//   npm run eval:workflow -- --models claude/sonnet,opencode/llama-qwen7b/qwen2.5-coder-7b \
//                            --output-csv results/workflow.csv \
//                            evals/workflow/add-workflow-description.yaml

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelTarget } from "./index.js";
import { runWorkflowEval } from "./workflow.js";
import { printWorkflowComparison, toWorkflowCsv } from "./workflow-report.js";
import type { WorkflowEvalArgs, ModelTarget } from "./types.js";

function parseArgs(rawArgs: string[]): WorkflowEvalArgs {
  let taskFile = "";
  const models: ModelTarget[] = [];
  let outputCsv: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run eval:workflow -- [OPTIONS] <task.yaml>",
          "",
          "Options:",
          "  --models M1,M2,...    Models to evaluate, e.g. claude/sonnet or opencode/llama-qwen7b/qwen2.5-coder-7b",
          "                        Defaults to claude/sonnet when omitted",
          "  --output-csv <path>   Write comparison CSV to file",
          "",
          "Example:",
          "  npm run eval:workflow -- --models claude/sonnet evals/workflow/add-workflow-description.yaml",
        ].join("\n"),
      );
      process.exit(0);
    } else if (arg === "--models" && rawArgs[i + 1]) {
      const specs = rawArgs[++i]!.split(",");
      for (const spec of specs) models.push(parseModelTarget(spec.trim()));
    } else if (arg === "--output-csv" && rawArgs[i + 1]) {
      outputCsv = rawArgs[++i];
    } else if (!arg.startsWith("-") && !taskFile) {
      taskFile = arg;
    }
  }

  if (!taskFile) {
    throw new Error("Usage: npm run eval:workflow -- [--models M] <task.yaml>");
  }

  if (models.length === 0) {
    models.push({ provider: "claude", model: "sonnet" });
  }

  return { taskFile, models, outputCsv };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `\nWorkflow eval: ${args.taskFile} (${args.models.length} model(s))`,
  );

  const comparison = await runWorkflowEval(args.taskFile, args.models);
  printWorkflowComparison(comparison);

  if (args.outputCsv) {
    mkdirSync(dirname(args.outputCsv), { recursive: true });
    writeFileSync(args.outputCsv, toWorkflowCsv(comparison), "utf8");
    console.log(`  Wrote ${args.outputCsv}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(
      "eval:workflow error:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
