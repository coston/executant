import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runClaudeStructured } from "../tasks/claude.js";
import { stripPromptHeader } from "../lib/utils.js";
import type { CriterionResult } from "./types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CRITERION_JUDGE_PROMPT = stripPromptHeader(
  readFileSync(join(__dir, "prompts", "criterion-judge.txt"), "utf8"),
);

const CriterionJudgeSchema = z.object({
  pass: z.boolean(),
  reason: z.string(),
});

const MAX_JUDGE_OUTPUT_CHARS = 16_000;

/**
 * Evaluates whether an output satisfies a specific criterion.
 * Uses Claude CLI with structured JSON output.
 */
export async function judgeOutput(
  output: string,
  criterion: string,
): Promise<CriterionResult> {
  const truncated =
    output.length > MAX_JUDGE_OUTPUT_CHARS
      ? output.slice(0, MAX_JUDGE_OUTPUT_CHARS) + "\n... (truncated)"
      : output;
  const prompt = CRITERION_JUDGE_PROMPT.replace(
    "{{OUTPUT}}",
    truncated,
  ).replace("{{CRITERION}}", criterion);

  const result = await runClaudeStructured(
    {
      type: "claude",
      name: "eval:criterion-judge",
      prompt,
      allowedTools: [],
      permissionMode: "default",
    },
    CriterionJudgeSchema,
  );

  return { criterion, pass: result.pass, reason: result.reason };
}

async function withConcurrency<T>(
  limit: number,
  tasks: (() => Promise<T>)[],
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]!();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return results;
}

/**
 * Judges all criteria for a given output with a concurrency cap of 3.
 */
export async function judgeAllCriteria(
  output: string,
  criteria: string[],
): Promise<CriterionResult[]> {
  return withConcurrency(
    3,
    criteria.map((c) => async () => {
      try {
        return await judgeOutput(output, c);
      } catch (err) {
        return {
          criterion: c,
          pass: false,
          reason: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );
}
