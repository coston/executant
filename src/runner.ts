// ============================================================================
// WORKFLOW RUNNER
// ============================================================================
// The runner is a pure async generator. It accepts a Workflow and yields a
// stream of Events. It has no knowledge of the UI or how output is displayed.
//
// Architecture principle: the runner is the only place that knows task
// sequencing and quality-control logic. Task runners (command.ts, claude.ts)
// only know how to execute a single step.

import { exec } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ClaudeTask, CommandTask, Event, ForEachTask, LogTask, RunOptions, Task, Workflow } from './types.js';
import { CommandError, runCommand } from './tasks/command.js';
import { runClaude, runClaudeStructured } from './tasks/claude.js';
import { loadPrompt } from './lib/utils.js';

const JUDGE_RETRY_CONTEXT = loadPrompt('judge-retry-context');
const SELF_HEALING_PROMPT = loadPrompt('self-healing-fix');
const JUDGE_EVALUATION_PROMPT = loadPrompt('judge-evaluation');

const execPromise = promisify(exec);

const MAX_JUDGE_RETRIES = 5;
const MAX_HEALING_ATTEMPTS = 5;

const JudgeOutputSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string().optional(),
  feedback: z.string(),
});

// ============================================================================
// Public API
// ============================================================================

/**
 * Executes a Workflow sequentially, yielding typed Events throughout.
 *
 * Consumers:
 *   - The Ink UI feeds this into a useReducer to build ExecutionState
 *   - Tests can collect all events into an array for assertions
 *   - CI mode pipes events as NDJSON to stdout
 */
export async function* runWorkflow(
  workflow: Workflow,
  options: RunOptions = {},
): AsyncGenerator<Event> {
  const workflowStart = Date.now();
  yield { type: 'workflow:start', workflow };

  for (const [i, task] of workflow.tasks.entries()) {
    const stepNumber = i + 1; // 1-based

    // --step filter: run only a single step matched by name or 1-based index
    if (options.stepFilter !== undefined) {
      const matchByIndex =
        /^\d+$/.test(options.stepFilter) &&
        parseInt(options.stepFilter, 10) === stepNumber;
      const matchByName = task.name === options.stepFilter;
      if (!matchByIndex && !matchByName) {
        yield { type: 'step:skip', index: i, name: task.name };
        continue;
      }
    }

    // --from-step filter: skip all steps before N
    if (options.fromStep !== undefined && stepNumber < options.fromStep) {
      yield { type: 'step:skip', index: i, name: task.name };
      continue;
    }

    const stepStart = Date.now();
    yield { type: 'step:start', index: i, name: task.name };

    try {
      for await (const event of runStep(task)) {
        if (event.type === 'step:iteration' || event.type === 'output:text' || event.type === 'output:tool') {
          yield { ...event, index: i };
        } else {
          yield event;
        }
      }
      yield {
        type: 'step:complete',
        index: i,
        name: task.name,
        durationMs: Date.now() - stepStart,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      yield { type: 'step:error', index: i, name: task.name, error };
      if (!task.continueOnError) throw error;
    }
  }

  yield {
    type: 'workflow:complete',
    workflow,
    durationMs: Date.now() - workflowStart,
  };
}

// ============================================================================
// Step dispatch — routes to quality-control wrappers when needed
// ============================================================================

async function* runStep(task: Task): AsyncGenerator<Event> {
  switch (task.type) {
    case 'log':
      yield* runLog(task);
      break;
    case 'command': {
      const gen = task.selfHealing ? runCommandWithHealing(task) : runCommand(task);
      if (task.output) {
        const lines: string[] = [];
        yield* collectLines(gen, lines);
        mkdirSync(dirname(task.output), { recursive: true });
        writeFileSync(task.output, lines.join('\n'), 'utf8');
      } else {
        yield* gen;
      }
      break;
    }
    case 'claude': {
      const expanded = expandContext(task);
      yield* expanded.llmAsJudge ? runClaudeWithJudge(expanded) : runClaude(expanded);
      break;
    }
    case 'forEach':
      yield* runForEach(task);
      break;
    default: {
      // Exhaustiveness: TypeScript errors here if a new Task variant is added
      // to types.ts without a corresponding case above.
      const _: never = task;
      throw new Error(`Unknown task type: ${JSON.stringify(_)}`);
    }
  }
}

async function* runLog(task: LogTask): AsyncGenerator<Event> {
  // index: -1 here — runWorkflow patches it to the real step index
  yield { type: 'output:text', index: -1, text: task.message };
}

// ============================================================================
// forEach: run an inner task once per item
// ============================================================================

async function* runForEach(task: ForEachTask): AsyncGenerator<Event> {
  const items = await resolveItems(task.forEach);
  const total = items.length;

  for (const [i, item] of items.entries()) {
    // index: -1 here — runWorkflow patches it to the real step index
    yield { type: 'step:iteration', index: -1, item, iteration: i + 1, total };

    const substituted = substituteItem(task.inner, item);
    yield* runStep(substituted);
  }
}

/**
 * Returns the list of items for a forEach step.
 * If `forEach` is a string it is executed as a shell command and the output
 * is split on newlines (empty lines are ignored).
 */
async function resolveItems(forEach: string[] | string): Promise<string[]> {
  if (Array.isArray(forEach)) return forEach.filter(Boolean);
  try {
    const { stdout } = await execPromise(forEach, { shell: '/bin/sh', timeout: 30_000 });
    return stdout.split('\n').filter((l: string) => l.trim().length > 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`forEach shell command failed: ${msg}\nCommand: ${forEach}`);
  }
}

/** Replaces `{{item}}` placeholders in the inner task's template fields. */
function substituteItem(
  task: CommandTask | ClaudeTask | LogTask,
  item: string,
): CommandTask | ClaudeTask | LogTask {
  const sub = (s: string) => s.replace(/\{\{item\}\}/g, item);
  switch (task.type) {
    case 'command': return { ...task, name: sub(task.name), command: sub(task.command) };
    case 'claude':  return { ...task, name: sub(task.name), prompt: sub(task.prompt), allowedTools: task.allowedTools?.map(sub) };
    case 'log':     return { ...task, name: sub(task.name), message: sub(task.message) };
    default: {
      const _: never = task;
      throw new Error(`Unknown inner task type: ${JSON.stringify(_)}`);
    }
  }
}

// ============================================================================
// Self-healing: auto-repair failed script steps via Claude
// ============================================================================

/**
 * Runs a command in a retry loop. On each failure, Claude gets full tool
 * access plus accumulated context from all prior attempts to diagnose and
 * fix the underlying issue. The command exit code is the judge: 0 = pass.
 * Retries up to maxHealingAttempts (default 5).
 */
async function* runCommandWithHealing(task: CommandTask): AsyncGenerator<Event> {
  const maxAttempts = task.maxHealingAttempts ?? MAX_HEALING_ATTEMPTS;
  const attemptHistory: Array<{ fixSummary: string; exitCode: number; cmdOutput: string }> = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const lines: string[] = [];

    try {
      yield* collectLines(runCommand(task), lines);
      // Command succeeded.
      if (attempt > 0) {
        yield { type: 'log', level: 'info', text: `[self-healing] Command passed after ${attempt + 1} attempts` };
      }
      return;
    } catch (err) {
      const exitCode = err instanceof CommandError ? err.exitCode : 1;
      const output = lines.join('\n');

      const remaining = maxAttempts - attempt - 1;
      if (remaining === 0) {
        yield { type: 'log', level: 'warn', text: `[self-healing] Exhausted ${maxAttempts} attempts` };
        throw new Error(
          `Step "${task.name}" failed after ${maxAttempts} self-healing attempts (last exit code: ${exitCode})`,
        );
      }

      yield {
        type: 'log',
        level: 'warn',
        text: `[self-healing] Attempt ${attempt + 1}/${maxAttempts} failed (exit ${exitCode}), invoking Claude to fix…`,
      };

      const historyBlock = buildAttemptHistory(attemptHistory);
      const healPrompt = buildHealingPrompt(task.command, exitCode, output, historyBlock);

      const healTask: ClaudeTask = {
        type: 'claude',
        name: `${task.name}:heal-${attempt + 1}`,
        prompt: healPrompt,
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      };

      const toolCalls: string[] = [];
      const claudeLines: string[] = [];
      for await (const event of runClaude(healTask)) {
        if (event.type === 'output:text') claudeLines.push(event.text);
        else if (event.type === 'output:tool') toolCalls.push(formatToolCall(event.tool, event.input));
        yield event;
      }

      // Record this attempt for future context.
      attemptHistory.push({
        fixSummary: buildFixSummary(toolCalls, claudeLines),
        exitCode,
        cmdOutput: output,
      });

      yield { type: 'log', level: 'info', text: `[self-healing] Re-running command (${remaining} attempt(s) left)…` };
    }
  }
}

// ============================================================================
// LLM-as-judge: evaluate Claude output quality and retry on failure
// ============================================================================

/**
 * Runs a Claude step and then evaluates its output with a separate judge
 * invocation. If the judge returns FAIL, the step is retried with the judge's
 * feedback appended to the original prompt. Maximum MAX_JUDGE_RETRIES attempts.
 */
async function* runClaudeWithJudge(task: ClaudeTask): AsyncGenerator<Event> {
  let judgeContext = '';

  for (let attempt = 0; attempt < MAX_JUDGE_RETRIES; attempt++) {
    // On retries, append judge feedback so Claude can address it.
    const prompt =
      attempt === 0
        ? task.prompt
        : `${task.prompt}\n\n${JUDGE_RETRY_CONTEXT.replace('{{FEEDBACK}}', judgeContext)}`;

    const lines: string[] = [];
    yield* collectLines(runClaude({ ...task, prompt }), lines);

    // Evaluate output quality.
    yield { type: 'log', level: 'info', text: `[judge] Evaluating "${task.name}"…` };
    const verdict = await evaluateWithJudge(task.name, task.prompt, lines.join('\n'));

    if (verdict.pass) {
      yield { type: 'log', level: 'info', text: '[judge] PASS' };
      return;
    }

    judgeContext = verdict.feedback;
    yield { type: 'log', level: 'warn', text: `[judge] FAIL — ${verdict.feedback}` };

    const remaining = MAX_JUDGE_RETRIES - attempt - 1;
    if (remaining === 0) {
      throw new Error(
        `Step "${task.name}" failed judge evaluation after ${MAX_JUDGE_RETRIES} attempts`,
      );
    }
    yield { type: 'log', level: 'info', text: `[judge] Retrying (${remaining} attempt(s) left)…` };
  }
}

/**
 * Runs a judge Claude invocation and parses its JSON response.
 * The judge gets no tools — it only reads what's passed in the prompt.
 */
export async function evaluateWithJudge(
  stepName: string,
  stepInstructions: string,
  output: string,
): Promise<{ pass: boolean; feedback: string }> {
  const result = await runClaudeStructured(
    {
      type: 'claude',
      name: `judge:${stepName}`,
      prompt: buildJudgePrompt(stepName, stepInstructions, output),
      allowedTools: [],
      permissionMode: 'default', // judge only reads text — no tool access needed
    },
    JudgeOutputSchema,
  );
  return { pass: result.pass, feedback: result.feedback };
}

// ============================================================================
// Shared utilities
// ============================================================================

/**
 * Passes all events from gen through to the caller while also collecting
 * output:text lines into an array for post-step analysis (judge, healing).
 */
async function* collectLines(
  gen: AsyncGenerator<Event>,
  lines: string[],
): AsyncGenerator<Event> {
  for await (const event of gen) {
    if (event.type === 'output:text') lines.push(event.text);
    yield event;
  }
}

// ============================================================================
// Context injection
// ============================================================================

/**
 * Returns a new ClaudeTask with context file contents prepended to the prompt.
 * Each file is wrapped in a labelled code fence so Claude can distinguish them.
 * If no contextFiles are set (or the array is empty) the task is returned as-is.
 */
function readContextFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Context file "${filePath}" could not be read: ${msg}`);
  }
}

export function expandContext(task: ClaudeTask): ClaudeTask {
  if (!task.contextFiles || task.contextFiles.length === 0) return task;
  const header = task.contextFiles
    .map((fp) => `### ${fp}\n\`\`\`\n${readContextFile(fp)}\n\`\`\``)
    .join('\n\n');
  return { ...task, prompt: `${header}\n\n${task.prompt}` };
}

// ============================================================================
// Prompt builders
// ============================================================================

function buildHealingPrompt(
  command: string,
  exitCode: number,
  output: string,
  attemptHistory: string,
): string {
  return SELF_HEALING_PROMPT
    .replaceAll('{{COMMAND}}', command)
    .replaceAll('{{EXIT_CODE}}', String(exitCode))
    .replaceAll('{{OUTPUT}}', output)
    .replaceAll('{{ATTEMPT_HISTORY}}', attemptHistory);
}

function buildJudgePrompt(stepName: string, instructions: string, output: string): string {
  return JUDGE_EVALUATION_PROMPT
    .replace('{{STEP_NAME}}', stepName)
    .replace('{{STEP_INSTRUCTIONS}}', instructions)
    .replace('{{OUTPUT}}', output);
}

function formatToolCall(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Edit' || tool === 'Write') return `${tool}(${String(input['file_path'] ?? '')})`;
  if (tool === 'Bash') return `Bash(${String(input['command'] ?? '')})`;
  return tool;
}

function buildFixSummary(toolCalls: string[], claudeLines: string[]): string {
  if (toolCalls.length > 0) return toolCalls.join(', ');
  return claudeLines.join(' ').trim() || 'No changes made';
}

function buildAttemptHistory(
  attempts: Array<{ fixSummary: string; exitCode: number; cmdOutput: string }>,
): string {
  if (attempts.length === 0) return '';
  const blocks = attempts.map((a, i) =>
    `--- Attempt ${i + 1} ---\nFix applied: ${a.fixSummary}\nResult: Failed with exit code ${a.exitCode}\nOutput: ${a.cmdOutput}`,
  );
  return `PREVIOUS ATTEMPTS:\n${blocks.join('\n\n')}`;
}
