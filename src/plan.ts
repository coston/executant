// ============================================================================
// PLAN SUBCOMMAND
// ============================================================================
// Usage:
//   executant plan "description"
//   executant plan -f prompt-file.txt
//   cat prompt.txt | executant plan
//
// Generates a YAML workflow file in .claude/executant.local/tasks/todo/
// via a three-pass pipeline: research → decompose → validate.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { runClaude, runClaudeStructured } from './tasks/claude.js';
import { loadPrompt, slugify, timestamp } from './lib/utils.js';
import type { PlanEvent } from './ui/PlanApp.js';
import type { ClaudeTask } from './types.js';

const PLAN_RESEARCH_PROMPT = loadPrompt('plan-research');
const PLAN_DECOMPOSE_PROMPT = loadPrompt('plan-decompose');
const PLAN_JUDGE_PROMPT = loadPrompt('plan-judge');
const PLAN_SYSTEM_RULES = loadPrompt('plan-system-rules');
const PLAN_RETRY_PARSE_ERROR = loadPrompt('plan-retry-parse-error');
const PLAN_RETRY_SCHEMA_ERROR = loadPrompt('plan-retry-schema-error');
const PLAN_RETRY_JUDGE = loadPrompt('plan-retry-judge');
const MAX_PLAN_RETRIES = 3;
const TOTAL_PLAN_STAGES = 3;

// ---------------------------------------------------------------------------
// Zod schemas — validate JSON output before serialising to YAML
// ---------------------------------------------------------------------------

const StepSchema = z.object({
  name: z.string(),
  type: z.enum(['prompt', 'script', 'log']).optional(),
  prompt: z.string().optional(),
  command: z.string().optional(),
  message: z.string().optional(),
  continue_on_error: z.boolean().optional(),
  self_healing: z.boolean().optional(),
  max_healing_attempts: z.number().int().positive().optional(),
  output: z.string().optional(),
  llm_as_judge: z.boolean().optional(),
  allowed_tools: z.array(z.string()).optional(),
  forEach: z.union([z.array(z.string()), z.string()]).optional(),
  context: z.array(z.string()).optional(),
});

const WorkflowSchema = z.object({
  goal: z.string(),
  steps: z.array(StepSchema).min(1),
  vars: z.record(z.string()).optional(),
  self_improve: z.boolean().optional(),
});

const PlanJudgeOutputSchema = z.object({
  pass: z.boolean(),
  feedback: z.string(),
});

const WORKFLOW_JSON_SCHEMA = zodToJsonSchema(WorkflowSchema) as Record<string, unknown>;

function walkUp(startDir: string, check: (dir: string) => string | null): string | null {
  let dir = startDir;
  while (true) {
    const found = check(dir);
    if (found !== null) return found;
    const parent = join(dir, '..');
    if (resolve(parent) === resolve(dir)) return null;
    dir = parent;
  }
}

export function findGitRoot(startDir: string): string | null {
  return walkUp(startDir, (dir) => existsSync(join(dir, '.git')) ? dir : null);
}

export function findProjectRoot(startDir: string): string | null {
  return walkUp(startDir, (dir) => {
    const candidate = join(dir, '.claude', 'executant.local', 'tasks');
    return existsSync(candidate) ? candidate : null;
  });
}

// ---------------------------------------------------------------------------
// CLI argument parsing (sync — runs before streaming starts)
// ---------------------------------------------------------------------------

export interface PlanArgs {
  description: string;
  taskFile: string;
  todoDir: string;
  fast: boolean;
}

export function isSimpleRequest(description: string): boolean {
  if (/\b\d+\s+(times|iterations?|passes)\b/i.test(description)) return true;
  if (/\bfor\s+each\b/i.test(description)) return true;
  return false;
}

export function parsePlanArgs(rawArgs: string[]): PlanArgs {
  let description = '';
  let fast = false;

  // Filter out fast flags before other processing
  const args = rawArgs.filter((a) => {
    if (a === '-q' || a === '--fast') { fast = true; return false; }
    return true;
  });

  if (args[0] === '-h' || args[0] === '--help') {
    console.log(`Usage: executant plan [OPTIONS] [DESCRIPTION]

Generate a task plan from a description.

Options:
  -f, --file <path>    Read prompt from file
  -q, --fast           Skip codebase research (auto-detected for simple tasks)
  -h, --help           Show this help message

Examples:
  executant plan "add user authentication"
  executant plan -f plan-prompt.txt
  cat prompt.txt | executant plan`);
    process.exit(0);
  }

  if (args[0] === '-f' || args[0] === '--file') {
    const filePath = args[1];
    if (!filePath) {
      console.error('Error: -f/--file requires a file path argument');
      process.exit(1);
    }
    if (!existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }
    try {
      description = readFileSync(filePath, 'utf8').trim();
    } catch {
      console.error(`Error: Cannot read file: ${filePath}`);
      process.exit(1);
    }
  } else if (args.length > 0) {
    description = args.join(' ').trim();
  } else if (!process.stdin.isTTY) {
    try {
      description = readFileSync('/dev/stdin', 'utf8').trim();
    } catch {
      // ignore
    }
  }

  if (!description) {
    console.error('Error: No task description provided');
    console.error('Usage: executant plan [OPTIONS] [DESCRIPTION]');
    console.error('       executant plan -f <filepath>');
    console.error('       cat prompt.txt | executant plan');
    process.exit(1);
  }

  let taskDir = findProjectRoot(process.cwd());
  if (!taskDir) {
    const base = findGitRoot(process.cwd()) ?? process.cwd();
    taskDir = join(base, '.claude', 'executant.local', 'tasks');
    mkdirSync(taskDir, { recursive: true });
  }

  const todoDir = join(taskDir, 'todo');
  mkdirSync(todoDir, { recursive: true });

  const slug = slugify(description);
  const ts = timestamp();
  const taskFile = join(todoDir, `${ts}-${slug}.yaml`);

  return { description, taskFile, todoDir, fast };
}

// ---------------------------------------------------------------------------
// Pass 3: Validate (non-generator — runs silently, swallows errors)
// ---------------------------------------------------------------------------

async function runPass3Judge(
  description: string,
  workflow: z.infer<typeof WorkflowSchema>,
): Promise<{ pass: boolean; feedback: string; skipped?: boolean }> {
  try {
    const task: Omit<ClaudeTask, 'jsonSchema'> = {
      type: 'claude',
      name: 'plan:judge',
      prompt: PLAN_JUDGE_PROMPT
        .replace('{{DESCRIPTION}}', description)
        .replace('{{WORKFLOW_JSON}}', JSON.stringify(workflow, null, 2)),
      allowedTools: [],
      permissionMode: 'default',
      model: 'sonnet',
    };
    return await runClaudeStructured(task, PlanJudgeOutputSchema);
  } catch {
    return { pass: true, feedback: '', skipped: true };
  }
}

// ---------------------------------------------------------------------------
// Streaming plan generation — async generator yielding PlanEvents
// ---------------------------------------------------------------------------

/**
 * Runs a plan generation pipeline:
 *   Fast path (2 passes) — when the request is self-contained or --fast is set:
 *     Pass 1 — Decompose to Steps, Pass 2 — Validate
 *   Full path (3 passes) — when codebase research is needed:
 *     Pass 1 — Research & Planning, Pass 2 — Decompose to Steps, Pass 3 — Validate
 */
export async function* streamPlan(args: PlanArgs): AsyncGenerator<PlanEvent> {
  const { description, taskFile } = args;
  const skipResearch = args.fast || isSimpleRequest(description);

  yield { type: 'plan:start', description };

  let researchDoc: string;

  if (skipResearch) {
    yield { type: 'plan:stages', names: ['Decompose to Steps', 'Validate'] };
    researchDoc = 'No codebase research performed — the task is self-contained. Work directly from the user\'s original goal.';
  } else {
    yield { type: 'plan:stages', names: ['Research & Planning', 'Decompose to Steps', 'Validate'] };

    // --- Pass 1: Research & Planning ---
    yield { type: 'plan:stage', stage: 1, total: TOTAL_PLAN_STAGES, name: 'Research & Planning' };

    const researchLines: string[] = [];
    try {
      const researchTask: ClaudeTask = {
        type: 'claude',
        name: 'plan:research',
        prompt: PLAN_RESEARCH_PROMPT.replace('{{DESCRIPTION}}', description),
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        model: 'opus',
      };
      for await (const event of runClaude(researchTask)) {
        if (event.type === 'output:tool') {
          yield { type: 'plan:tool', tool: event.tool, input: event.input };
        } else if (event.type === 'output:text') {
          researchLines.push(event.text);
          yield { type: 'plan:text', text: event.text };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'plan:error', message: `Research pass failed: ${msg}` };
      return;
    }

    researchDoc = researchLines.join('\n');
    if (!researchDoc.trim()) {
      yield { type: 'plan:error', message: 'Research pass produced no output — cannot decompose' };
      return;
    }
  }

  // Stage index offset: 1 when research was skipped, 2 when research ran
  const decomposeStage = skipResearch ? 1 : 2;
  const validateStage = skipResearch ? 2 : 3;
  const totalStages = skipResearch ? 2 : TOTAL_PLAN_STAGES;

  // --- Pass 2 (or 1 in fast mode): Decompose to Steps (with retries) ---
  yield { type: 'plan:stage', stage: decomposeStage, total: totalStages, name: 'Decompose to Steps' };

  let retryPrefix = '';

  for (let attempt = 0; attempt < MAX_PLAN_RETRIES; attempt++) {
    if (attempt > 0) {
      yield {
        type: 'plan:retry',
        attempt: attempt + 1,
        maxAttempts: MAX_PLAN_RETRIES,
        reason: retryPrefix.replace(/\n/g, ' '),
      };
      // Re-emit decompose stage so the TUI reflects the retry (judge rejection re-enters decompose)
      yield { type: 'plan:stage', stage: decomposeStage, total: totalStages, name: 'Decompose to Steps' };
    }

    const basePrompt = PLAN_DECOMPOSE_PROMPT
      .replace('{{DESCRIPTION}}', description)
      .replace('{{RESEARCH_DOC}}', researchDoc);

    const decomposeTask: ClaudeTask = {
      type: 'claude',
      name: 'plan:decompose',
      prompt: retryPrefix ? `${retryPrefix}\n\n${basePrompt}` : basePrompt,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      model: 'opus',
      appendSystemPrompt: PLAN_SYSTEM_RULES,
      jsonSchema: WORKFLOW_JSON_SCHEMA,
    };

    let structuredOutput: unknown;
    const decomposeTextLines: string[] = [];

    try {
      for await (const event of runClaude(decomposeTask)) {
        if (event.type === 'output:tool') {
          yield { type: 'plan:tool', tool: event.tool, input: event.input };
        } else if (event.type === 'output:text') {
          decomposeTextLines.push(event.text);
          yield { type: 'plan:text', text: event.text };
        } else if (event.type === 'output:structured') {
          structuredOutput = event.data;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_PLAN_RETRIES - 1) {
        yield { type: 'plan:error', message: msg };
        return;
      }
      retryPrefix = PLAN_RETRY_PARSE_ERROR
        .replace('{{ERROR}}', msg)
        .replace('{{EXCERPT}}', decomposeTextLines.join('\n'));
      continue;
    }

    if (structuredOutput === undefined) {
      const issues = 'No structured output returned — ensure the response is a JSON object';
      if (attempt === MAX_PLAN_RETRIES - 1) {
        yield { type: 'plan:error', message: issues };
        return;
      }
      retryPrefix = PLAN_RETRY_SCHEMA_ERROR.replace('{{ISSUES}}', issues);
      continue;
    }

    const zodResult = WorkflowSchema.safeParse(structuredOutput);
    if (!zodResult.success) {
      const issues = zodResult.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
      if (attempt === MAX_PLAN_RETRIES - 1) {
        yield { type: 'plan:error', message: `Plan did not match expected schema:\n${issues}` };
        return;
      }
      retryPrefix = PLAN_RETRY_SCHEMA_ERROR.replace('{{ISSUES}}', issues);
      continue;
    }

    // --- Pass 3 (or 2 in fast mode): Validate ---
    yield { type: 'plan:stage', stage: validateStage, total: totalStages, name: 'Validate' };

    const judgeResult = await runPass3Judge(description, zodResult.data);

    if (judgeResult.skipped) {
      yield { type: 'plan:warn', message: 'Judge skipped due to error — proceeding without validation' };
    }

    // Judge is non-blocking: if it rejects on the final attempt the workflow is
    // written anyway — retries are exhausted and discarding the work would be worse.
    if (!judgeResult.pass && attempt < MAX_PLAN_RETRIES - 1) {
      retryPrefix = PLAN_RETRY_JUDGE.replace('{{FEEDBACK}}', judgeResult.feedback);
      continue;
    }

    if (!judgeResult.pass) {
      yield { type: 'plan:warn', message: `Judge rejected plan but retries exhausted: ${judgeResult.feedback}` };
    }

    // All passes succeeded (or judge override on final attempt) — write YAML
    const { goal, vars, steps, ...rest } = zodResult.data;
    const ordered = { goal, ...(vars && { vars }), steps, ...rest };

    const yamlContent = dumpYaml(ordered, {
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
      forceQuotes: false,
    }).trimEnd();

    writeFileSync(taskFile, yamlContent + '\n', 'utf8');

    const preview = yamlContent.split('\n').slice(0, 30).join('\n')
      + (yamlContent.split('\n').length > 30 ? '\n...' : '');

    yield { type: 'plan:complete', taskFile, preview };
    return;
  }

  yield { type: 'plan:error', message: 'Plan generation failed after maximum retries' };
}
