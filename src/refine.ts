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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { load as loadYaml, dump as dumpYaml } from "js-yaml";
import { runClaude, METHODOLOGY } from "./tasks/claude.js";
import {
  loadPrompt,
  getErrorMessage,
  fillTemplate,
  formatZodIssues,
} from "./lib/utils.js";
import {
  normalizeWorkflow,
  runPass3Judge,
  WorkflowSchema,
  WORKFLOW_JSON_SCHEMA,
} from "./plan.js";
import type { PlanEvent } from "./ui/PlanApp.js";
import type { ClaudeTask } from "./types.js";

const PLAN_REFINE_PROMPT = loadPrompt("plan-refine");
const PLAN_SYSTEM_RULES = loadPrompt("plan-system-rules");
const PLAN_RETRY_PARSE_ERROR = loadPrompt("plan-retry-parse-error");
const PLAN_RETRY_SCHEMA_ERROR = loadPrompt("plan-retry-schema-error");
const PLAN_RETRY_JUDGE = loadPrompt("plan-retry-judge");
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

  let retryPrefix = "";

  for (let attempt = 0; attempt < MAX_REFINE_RETRIES; attempt++) {
    if (attempt > 0) {
      yield {
        type: "plan:retry",
        attempt: attempt + 1,
        maxAttempts: MAX_REFINE_RETRIES,
        reason: retryPrefix.replace(/\n/g, " "),
      };
      yield { type: "plan:stage", stage: 1, total: 2, name: "Refine" };
    }

    const basePrompt = fillTemplate(PLAN_REFINE_PROMPT, {
      DESCRIPTION: description,
      EXISTING_YAML: existingYaml,
      INSTRUCTIONS: instructions,
    });

    const refineTask: ClaudeTask = {
      type: "claude",
      name: "plan:refine",
      prompt: retryPrefix ? `${retryPrefix}\n\n${basePrompt}` : basePrompt,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      model: "sonnet",
      appendSystemPrompt: `${METHODOLOGY}\n\n${PLAN_SYSTEM_RULES}`,
      jsonSchema: WORKFLOW_JSON_SCHEMA,
    };

    let structuredOutput: unknown;
    const textLines: string[] = [];

    try {
      for await (const event of runClaude(refineTask)) {
        if (event.type === "output:tool") {
          yield { type: "plan:tool", tool: event.tool, input: event.input };
        } else if (event.type === "output:text") {
          textLines.push(event.text);
          yield { type: "plan:text", text: event.text };
        } else if (event.type === "output:structured") {
          structuredOutput = event.data;
        }
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      if (attempt === MAX_REFINE_RETRIES - 1) {
        yield { type: "plan:error", message: msg };
        return;
      }
      retryPrefix = fillTemplate(PLAN_RETRY_PARSE_ERROR, {
        ERROR: msg,
        EXCERPT: textLines.join("\n"),
      });
      continue;
    }

    if (structuredOutput === undefined) {
      const issues =
        "No structured output returned — ensure the response is a JSON object";
      if (attempt === MAX_REFINE_RETRIES - 1) {
        yield { type: "plan:error", message: issues };
        return;
      }
      retryPrefix = fillTemplate(PLAN_RETRY_SCHEMA_ERROR, { ISSUES: issues });
      continue;
    }

    const zodResult = WorkflowSchema.safeParse(structuredOutput);
    if (!zodResult.success) {
      const issues = formatZodIssues(zodResult.error.issues);
      if (attempt === MAX_REFINE_RETRIES - 1) {
        yield {
          type: "plan:error",
          message: `Refined plan did not match expected schema:\n${issues}`,
        };
        return;
      }
      retryPrefix = fillTemplate(PLAN_RETRY_SCHEMA_ERROR, { ISSUES: issues });
      continue;
    }

    // --- Pass 2: Validate ---
    yield { type: "plan:stage", stage: 2, total: 2, name: "Validate" };

    const judgeResult = await runPass3Judge(description, zodResult.data);

    if (judgeResult.skipped) {
      yield {
        type: "plan:warn",
        message: "Judge skipped due to error — proceeding without validation",
      };
    }

    if (!judgeResult.pass && attempt < MAX_REFINE_RETRIES - 1) {
      retryPrefix = fillTemplate(PLAN_RETRY_JUDGE, {
        FEEDBACK: judgeResult.feedback,
      });
      continue;
    }

    if (!judgeResult.pass) {
      yield {
        type: "plan:warn",
        message: `Judge rejected refinement but retries exhausted: ${judgeResult.feedback}`,
      };
    }

    const { goal, vars, steps, ...rest } = normalizeWorkflow(zodResult.data);
    const ordered = { goal, ...(vars && { vars }), steps, ...rest };

    const yamlContent = dumpYaml(ordered, {
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
      forceQuotes: false,
    }).trimEnd();

    writeFileSync(taskFile, yamlContent + "\n", "utf8");

    const yamlLines = yamlContent.split("\n");
    const preview =
      yamlLines.slice(0, 30).join("\n") +
      (yamlLines.length > 30 ? "\n..." : "");

    yield { type: "plan:complete", taskFile, preview };
    return;
  }

  yield {
    type: "plan:error",
    message: "Refine failed after maximum retries",
  };
}
