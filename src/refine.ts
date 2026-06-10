// ============================================================================
// REFINE SUBCOMMAND
// ============================================================================
// Usage:
//   executant refine <task-file> "instructions"
//   executant refine <task-file> -f instructions.txt
//   cat instructions.txt | executant refine <task-file>
//
// Applies natural language refinement instructions to an existing YAML
// workflow file, running it through the same validate pipeline as `plan`.

import { existsSync, readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { METHODOLOGY } from "./tasks/claude.js";
import { loadPrompt, fillTemplate, DEFAULT_MODEL } from "./lib/utils.js";
import { runRetryLoop, WORKFLOW_JSON_SCHEMA } from "./plan.js";
import type { PlanEvent } from "./ui/PlanApp.js";
import type { ClaudeTask } from "./types.js";

const PLAN_REFINE_PROMPT = loadPrompt("plan-refine");
const PLAN_SYSTEM_RULES = loadPrompt("plan-system-rules");
const MAX_REFINE_RETRIES = 3;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface RefineArgs {
  taskFile: string;
  existingYaml: string;
  instructions: string;
  description: string;
}

export function parseRefineArgs(rawArgs: string[]): RefineArgs {
  if (rawArgs[0] === "-h" || rawArgs[0] === "--help") {
    console.log(`Usage: executant refine <task-file> [OPTIONS] [INSTRUCTIONS]

Refine an existing task YAML with natural language instructions.

Options:
  -f, --file <path>    Read instructions from file
  -h, --help           Show this help message

Examples:
  executant refine tasks/todo/my-task.yaml "make it simpler"
  executant refine tasks/todo/my-task.yaml -f instructions.txt
  cat instructions.txt | executant refine tasks/todo/my-task.yaml`);
    process.exit(0);
  }

  const taskFile = rawArgs[0];
  if (!taskFile) {
    console.error("Error: No task file specified");
    console.error("Usage: executant refine <task-file> [INSTRUCTIONS]");
    process.exit(1);
  }
  if (!existsSync(taskFile)) {
    console.error(`Error: File not found: ${taskFile}`);
    process.exit(1);
  }

  let existingYaml: string;
  try {
    existingYaml = readFileSync(taskFile, "utf8").trim();
  } catch {
    console.error(`Error: Cannot read file: ${taskFile}`);
    process.exit(1);
  }

  let description = "Refine workflow";
  try {
    const parsed = loadYaml(existingYaml) as Record<string, unknown>;
    if (typeof parsed?.goal === "string") description = parsed.goal;
  } catch {
    // use default description
  }

  const remaining = rawArgs.slice(1);
  let instructions = "";

  if (remaining[0] === "-f" || remaining[0] === "--file") {
    const filePath = remaining[1];
    if (!filePath) {
      console.error("Error: -f/--file requires a file path argument");
      process.exit(1);
    }
    if (!existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }
    try {
      instructions = readFileSync(filePath, "utf8").trim();
    } catch {
      console.error(`Error: Cannot read file: ${filePath}`);
      process.exit(1);
    }
  } else if (remaining.length > 0) {
    instructions = remaining.join(" ").trim();
  } else if (!process.stdin.isTTY) {
    try {
      instructions = readFileSync("/dev/stdin", "utf8").trim();
    } catch {
      // ignore
    }
  }

  if (!instructions) {
    console.error("Error: No refinement instructions provided");
    console.error("Usage: executant refine <task-file> [INSTRUCTIONS]");
    console.error("       executant refine <task-file> -f <filepath>");
    console.error("       cat instructions.txt | executant refine <task-file>");
    process.exit(1);
  }

  return { taskFile, existingYaml, instructions, description };
}

// ---------------------------------------------------------------------------
// Streaming refine — async generator yielding PlanEvents
// ---------------------------------------------------------------------------

export async function* streamRefine(
  args: RefineArgs,
): AsyncGenerator<PlanEvent> {
  const { taskFile, existingYaml, instructions, description } = args;

  yield { type: "plan:start", description };
  yield { type: "plan:stages", names: ["Refine", "Validate"] };
  yield { type: "plan:stage", stage: 1, total: 2, name: "Refine" };

  yield* runRetryLoop({
    maxRetries: MAX_REFINE_RETRIES,
    retryStageName: "Refine",
    retryStage: 1,
    retryTotal: 2,
    validateStage: 2,
    validateTotal: 2,
    schemaErrorLabel: "Refined plan",
    judgeRejectLabel: "refinement",
    description,
    taskFile,
    buildTask: (retryPrefix) => {
      const basePrompt = fillTemplate(PLAN_REFINE_PROMPT, {
        DESCRIPTION: description,
        EXISTING_YAML: existingYaml,
        INSTRUCTIONS: instructions,
      });
      return {
        type: "claude",
        name: "plan:refine",
        prompt: retryPrefix ? `${retryPrefix}\n\n${basePrompt}` : basePrompt,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        model: DEFAULT_MODEL,
        appendSystemPrompt: `${METHODOLOGY}\n\n${PLAN_SYSTEM_RULES}`,
        jsonSchema: WORKFLOW_JSON_SCHEMA,
      } satisfies ClaudeTask;
    },
  });
}
