// ============================================================================
// WORKFLOW RUNNER
// ============================================================================
// The runner is a pure async generator. It accepts a Workflow and yields a
// stream of Events. It has no knowledge of the UI or how output is displayed.
//
// Architecture principle: the runner is the only place that knows task
// sequencing and quality-control logic. Task runners (command.ts, claude.ts)
// only know how to execute a single step.

import { exec } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  ClaudeTask,
  CommandTask,
  Event,
  ForEachTask,
  InterjectChannel,
  LogTask,
  RunOptions,
  StepHealingEvent,
  StepJudgeEvent,
  StepSummary,
  Task,
  TokenUsage,
  Workflow,
  WorkflowTask,
} from "./types.js";
import { traceparentEnv } from "./lib/trace-context.js";
import { CommandError, runCommand } from "./tasks/command.js";
import { runAgent, runAgentStructured } from "./tasks/agent.js";
import {
  generateRetrospective,
  isRetrospectiveEnabled,
} from "./retrospective.js";
import {
  buildRunReport,
  generateEfficiencySuggestion,
  isEfficiencySuggestionEnabled,
} from "./report.js";
import {
  loadPrompt,
  getErrorMessage,
  fillTemplate,
  formatToolCall,
  normalizeError,
  DEFAULT_MODEL,
} from "./lib/utils.js";

const JUDGE_RETRY_CONTEXT = loadPrompt("judge-retry-context");
const SELF_HEALING_PROMPT = loadPrompt("self-healing-fix");
const JUDGE_EVALUATION_PROMPT = loadPrompt("judge-evaluation");

const execPromise = promisify(exec);

export const MAX_JUDGE_RETRIES = 5;
const MAX_HEALING_ATTEMPTS = 5;

/**
 * Internal signal only — never escapes runWorkflow(). Thrown by
 * runNestedWorkflow() when a nested workflow step notices .executant-cancel
 * and stops itself, so every enclosing runWorkflow() call also stops instead
 * of treating the nested cancellation as if that one step had merely
 * succeeded (whatever remained of the child's own steps would otherwise run
 * to completion invisibly, and the outer run would carry on to its own next
 * step as if nothing had happened).
 */
class NestedCancellation extends Error {}

const JudgeOutputSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string().optional(),
  feedback: z.string(),
});

export function shouldSkipStep(
  stepNumber: number,
  name: string,
  options: RunOptions,
): boolean {
  if (options.stepFilter !== undefined) {
    const matchByIndex =
      /^\d+$/.test(options.stepFilter) &&
      parseInt(options.stepFilter, 10) === stepNumber;
    return !matchByIndex && name !== options.stepFilter;
  }
  if (options.fromStep !== undefined && stepNumber < options.fromStep[0]) {
    return true;
  }
  return options.toStep !== undefined && stepNumber > options.toStep;
}

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
 *
 * When `channel` is provided, user interjections typed in the TUI are
 * delivered to running Claude steps via stdin. Messages sent during non-Claude
 * steps are queued and prepended to the next Claude step's prompt.
 */
const LAST_OUTPUT_MAX_LINES = 100;

export async function* runWorkflow(
  workflow: Workflow,
  options: RunOptions = {},
  channel?: InterjectChannel,
): AsyncGenerator<Event> {
  const workflowStart = Date.now();
  const workDir = options.workDir ?? process.cwd();
  const cancelFile = join(workDir, ".executant-cancel");
  yield { type: "workflow:start", workflow };

  let lastStepOutput: string | undefined;
  // Accumulated across the whole run for the final workflow:report — only
  // read when options.report !== false (see the report block after the loop).
  let totalCostUsd = 0;
  const usageEvents: TokenUsage[] = [];
  const stepNarrative: StepSummary[] = [];

  for (const [i, task] of workflow.tasks.entries()) {
    // Cooperative cancellation: operator writes this file to stop between steps.
    if (existsSync(cancelFile)) {
      try {
        unlinkSync(cancelFile);
      } catch {
        /* race — file already removed */
      }
      yield {
        type: "workflow:cancelled",
        workflow,
        durationMs: Date.now() - workflowStart,
      };
      return;
    }

    const stepNumber = i + 1; // 1-based

    if (shouldSkipStep(stepNumber, task.name, options)) {
      yield { type: "step:skip", index: i, name: task.name };
      continue;
    }

    const stepStart = Date.now();
    yield { type: "step:start", index: i, name: task.name };

    const from =
      options.fromStep && options.fromStep[0] === stepNumber
        ? options.fromStep.slice(1)
        : undefined;

    const lines: string[] = [];
    // Quality-control activity and loop position, accumulated as the step runs.
    // Both are the story a post-mortem needs and neither survives in the error
    // message: a judge exhaustion says only "failed after 5 attempts", and a
    // forEach failure names the container rather than the item that broke.
    // qualityHistory is also what the run report's stepNarrative carries
    // forward — kept even for a step that ultimately succeeds, since a step
    // that needed 2 self-healing attempts before passing is exactly the kind
    // of "prompting fell short" signal an efficiency analysis needs and a
    // step's bare success/failure never shows.
    const qualityHistory: string[] = [];
    let position: string | undefined;
    let stepCostUsd = 0;
    try {
      for await (const event of runStep(task, from, channel, workDir)) {
        if (
          event.type === "step:iteration" ||
          event.type === "step:inner" ||
          event.type === "step:iteration-complete" ||
          event.type === "output:text" ||
          event.type === "output:tool" ||
          event.type === "output:cost" ||
          event.type === "output:usage" ||
          event.type === "step:healing" ||
          event.type === "step:judge"
        ) {
          if (event.type === "output:text") {
            if (lines.length >= LAST_OUTPUT_MAX_LINES) lines.shift();
            lines.push(event.text);
          }
          if (event.type === "output:cost") {
            totalCostUsd += event.usd;
            stepCostUsd += event.usd;
          }
          if (event.type === "output:usage") usageEvents.push(event.usage);
          if (event.type === "step:iteration")
            position = `iteration ${event.iteration}/${event.total} (item: ${event.item})`;
          if (event.type === "step:inner")
            position = `${position ?? "iteration ?"} → child step ${event.innerIndex + 1}/${event.innerTotal} "${event.name}"`;
          if (event.type === "step:judge" || event.type === "step:healing")
            qualityHistory.push(describeQualityEvent(event));
          yield { ...event, index: i };
        } else {
          yield event;
        }
      }
      lastStepOutput = lines.join("\n") || undefined;
      yield {
        type: "step:complete",
        index: i,
        name: task.name,
        durationMs: Date.now() - stepStart,
      };
      stepNarrative.push({
        name: task.name,
        durationMs: Date.now() - stepStart,
        costUsd: stepCostUsd,
        qualityEvents: qualityHistory,
      });
    } catch (err) {
      // A nested workflow step noticed .executant-cancel and stopped itself —
      // that must stop THIS run too, not read as this step merely finishing.
      // Checked before continueOnError: cancellation is an operator request,
      // not a failure to tolerate.
      if (err instanceof NestedCancellation) {
        yield {
          type: "workflow:cancelled",
          workflow,
          durationMs: Date.now() - workflowStart,
        };
        return;
      }
      const error = normalizeError(err);
      const lastOutput = lines.join("\n") || undefined;
      lastStepOutput = lastOutput;
      yield {
        type: "step:error",
        index: i,
        name: task.name,
        error,
        lastOutput,
      };
      if (!task.continueOnError) {
        // The run is over — spend one analysis call explaining why before the
        // error propagates, so the user gets a post-mortem instead of a stack
        // trace. Failures inside the analysis are swallowed by
        // generateRetrospective; the original error always wins.
        if (options.retrospective ?? isRetrospectiveEnabled()) {
          yield {
            type: "log",
            level: "info",
            text: `[retrospective] Analysing why "${task.name}" failed…`,
          };
          const retrospective = await generateRetrospective({
            workflow,
            task,
            error,
            lastOutput,
            qualityHistory,
            position,
          });
          if (retrospective) {
            yield { type: "step:retrospective", index: i, retrospective };
          } else {
            // Say so rather than leaving the "Analysing…" line hanging.
            yield {
              type: "log",
              level: "warn",
              text: "[retrospective] Analysis unavailable — see the error above",
            };
          }
        }
        throw error;
      }
      // continueOnError kept the run going — record the failure itself as
      // the strongest possible "prompting fell short" signal for this step.
      stepNarrative.push({
        name: task.name,
        durationMs: Date.now() - stepStart,
        costUsd: stepCostUsd,
        qualityEvents: [...qualityHistory, `step failed: ${error.message}`],
        failed: true,
      });
    }
  }

  if (options.report ?? true) {
    // Best-effort — generateEfficiencySuggestion never throws, so this can't
    // knock the run's success reporting off course. Duration/cost/token/
    // narrative are always computed (they're free); the suggestion call is
    // opt-in only (EXECUTANT_REPORT_SUGGESTION=1) so an automated/CI run is
    // never disturbed by an extra API call it didn't ask for. Interactively,
    // the TUI offers the same analysis on demand via a keypress once the run
    // report is on screen (src/ui/ReportPrompt.tsx) — that path calls
    // generateEfficiencySuggestion directly, outside this generator, since by
    // then runWorkflow has already finished.
    const suggestion = isEfficiencySuggestionEnabled()
      ? await generateEfficiencySuggestion(workflow, stepNarrative)
      : undefined;
    yield {
      type: "workflow:report",
      report: buildRunReport({
        durationMs: Date.now() - workflowStart,
        totalCostUsd,
        usageEvents,
        stepNarrative,
        suggestion,
      }),
    };
  }

  yield {
    type: "workflow:complete",
    workflow,
    durationMs: Date.now() - workflowStart,
    lastOutput: lastStepOutput,
  };
}

// ============================================================================
// Step dispatch — routes to quality-control wrappers when needed
// ============================================================================

async function* runStep(
  task: Task,
  from: number[] | undefined,
  channel: InterjectChannel | undefined,
  workDir: string,
): AsyncGenerator<Event> {
  switch (task.type) {
    case "log":
      yield* runLog(task);
      break;
    case "command": {
      const gen = task.selfHealing
        ? runCommandWithHealing(task)
        : runCommand(task);
      if (task.output) {
        const lines: string[] = [];
        yield* collectLines(gen, lines);
        mkdirSync(dirname(task.output), { recursive: true });
        writeFileSync(task.output, lines.join("\n"), "utf8");
      } else {
        yield* gen;
      }
      break;
    }
    case "claude": {
      const expanded = expandContext(task);
      // Prepend any messages queued during non-Claude steps so they arrive as
      // context at the start of this turn rather than being lost.
      const queued = channel?.consumeQueue() ?? [];
      const enriched =
        queued.length > 0
          ? {
              ...expanded,
              prompt: `[User correction from a previous step]\n${queued.join("\n")}\n\n---\n${expanded.prompt}`,
            }
          : expanded;
      yield* enriched.llmAsJudge
        ? runClaudeWithJudge(enriched)
        : runAgent(enriched);
      // A prompt step's real artifact is whatever it wrote via tool calls,
      // not its narration text — so `output:` here is a postcondition check,
      // not a capture (contrast the command case above, which does capture
      // stdout). Deliberately no self-healing/judge retry on this failure:
      // that could paper over the agent skipping the write entirely instead
      // of surfacing it, the same reasoning that keeps self_healing off
      // deterministic script steps whose failure should hard-stop the run.
      if (enriched.output && !existsSync(enriched.output)) {
        throw new Error(
          `Step "${enriched.name}" expected to produce "${enriched.output}" but it doesn't exist`,
        );
      }
      break;
    }
    case "forEach":
      yield* runForEach(task, from, channel, workDir);
      break;
    case "workflow":
      yield* runNestedWorkflow(task, from, channel, workDir);
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
  yield { type: "output:text", index: -1, text: task.message };
}

// ============================================================================
// forEach: run an inner task once per item
// ============================================================================

async function* runForEach(
  task: ForEachTask,
  from: number[] | undefined,
  channel: InterjectChannel | undefined,
  workDir: string,
): AsyncGenerator<Event> {
  const items = await resolveItems(task.forEach);
  const total = items.length;

  // A zero-item forEach completes "successfully" doing nothing — which
  // reads identically to a healthy no-op unless it's called out. Usually a
  // sign the source command's own inputs (e.g. an unresolved var, an
  // empty/missing file) aren't what was expected, not that there's
  // genuinely no work.
  if (total === 0 && (from?.[0] ?? 1) === 1) {
    yield {
      type: "log",
      level: "warn",
      text: `forEach resolved to 0 items in "${task.name}" — this step will do nothing. Check the source command's own inputs.`,
    };
  }

  const concurrency = task.concurrency ?? 1;
  if (concurrency > 1) {
    // No --from-step support here: iterations aren't run in a knowable
    // order, so there's no single "resume from iteration N" that means
    // anything. Re-running the whole step is the correct recovery — each
    // iteration should detect and skip its own already-done work rather
    // than lean on infra-level resume (see AGENTS.md).
    if (from && from.length > 0) {
      yield {
        type: "log",
        level: "warn",
        text: `[from-step] "${task.name}" runs with concurrency ${concurrency} and doesn't support resuming into a specific iteration — running all ${total} iterations from the start.`,
      };
    }
    yield* runForEachConcurrent(task, items, concurrency, channel, workDir);
    return;
  }

  yield* runForEachSequential(task, items, from, channel, workDir);
}

async function* runForEachSequential(
  task: ForEachTask,
  items: string[],
  from: number[] | undefined,
  channel: InterjectChannel | undefined,
  workDir: string,
): AsyncGenerator<Event> {
  const total = items.length;
  const innerTotal = task.inner.length;
  const startIteration = from?.[0] ?? 1;

  if (startIteration > 1 && startIteration > total) {
    yield {
      type: "log",
      level: "warn",
      text: `[from-step] No iterations to run: target iteration ${startIteration} exceeds total ${total} in "${task.name}"`,
    };
    return;
  }

  for (const [i, item] of items.entries()) {
    const iteration = i + 1;
    if (iteration < startIteration) continue; // silent skip

    // index: -1 here — runWorkflow patches it to the real step index
    yield { type: "step:iteration", index: -1, item, iteration, total };

    // On the first resumed iteration propagate the tail; after that run all.
    const iterFrom = iteration === startIteration ? from?.slice(1) : undefined;
    const startChild = iterFrom?.[0] ?? 1;

    for (const [j, innerTask] of task.inner.entries()) {
      const childIdx = j + 1;
      if (childIdx < startChild) continue; // silent skip

      const substituted = substituteItem(innerTask, item);
      if (innerTotal > 1) {
        yield {
          type: "step:inner",
          index: -1,
          iteration,
          innerIndex: j,
          innerTotal,
          name: substituted.name,
        };
      }
      // Pass deeper tail for nested forEach; after the first child run all.
      const childFrom =
        childIdx === startChild ? iterFrom?.slice(1) : undefined;
      try {
        for await (const event of runStep(
          substituted,
          childFrom,
          channel,
          workDir,
        )) {
          // step:iteration and step:inner from nested forEach tasks would
          // land in the parent task's iterationHistory (via runWorkflow's
          // index-patching), creating duplicate iteration numbers and
          // breaking key={record.iteration} in the UI.
          if (event.type !== "step:iteration" && event.type !== "step:inner") {
            yield event;
          }
        }
      } catch (err) {
        const error = normalizeError(err);
        if (!substituted.continueOnError) {
          yield {
            type: "log",
            level: "warn",
            text: `[forEach] Step "${substituted.name}" failed — aborting remaining children and iterations`,
          };
          yield {
            type: "step:iteration-complete",
            index: -1,
            iteration,
            status: "error",
            error: error.message,
          };
          throw error;
        }
        yield {
          type: "log",
          level: "warn",
          text: `[forEach] Step "${substituted.name}" failed (continuing): ${error.message}`,
        };
      }
    }
    yield {
      type: "step:iteration-complete",
      index: -1,
      iteration,
      status: "complete",
    };
  }
}

/**
 * Runs iterations in batches of `concurrency`, all items in a batch started
 * together and interleaved live via mergeAsyncGenerators — batch N+1 starts
 * only once every item in batch N has finished (success or not). Not a
 * streaming pool: a slow item in a batch holds up the next batch's start
 * even if other slots are free, which keeps the "batch of N, then the next
 * batch" mental model simple and matches the "cap N concurrent" pattern
 * already used by hand in several workflow prompts.
 */
async function* runForEachConcurrent(
  task: ForEachTask,
  items: string[],
  concurrency: number,
  channel: InterjectChannel | undefined,
  workDir: string,
): AsyncGenerator<Event> {
  const total = items.length;

  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency);
    const gens = batch.map((item, k) =>
      runOneIteration(task, item, start + k + 1, total, channel, workDir),
    );

    let batchError: string | undefined;
    for await (const event of mergeAsyncGenerators(gens)) {
      if (
        event.type === "step:iteration-complete" &&
        event.status === "error"
      ) {
        batchError ??= event.error;
      }
      yield event;
    }

    if (batchError !== undefined && !task.continueOnError) {
      yield {
        type: "log",
        level: "warn",
        text: `[forEach] An iteration failed in "${task.name}" — aborting remaining batches`,
      };
      throw new Error(
        `forEach "${task.name}" had a failing iteration: ${batchError}`,
      );
    }
  }
}

/**
 * Runs one forEach iteration's inner steps in order (an iteration's OWN
 * steps are still sequential — e.g. "extract" must finish before "write"
 * reads its output — only iterations run concurrently with each other, not
 * an iteration's own children). Never throws: every failure, expected or
 * not, becomes a step:iteration-complete(status: "error") event instead, so
 * a rejected promise can never reach mergeAsyncGenerators' Promise.race and
 * silently take down sibling iterations that are still in flight.
 */
async function* runOneIteration(
  task: ForEachTask,
  item: string,
  iteration: number,
  total: number,
  channel: InterjectChannel | undefined,
  workDir: string,
): AsyncGenerator<Event> {
  const innerTotal = task.inner.length;
  try {
    // index: -1 here — runWorkflow patches it to the real step index
    yield { type: "step:iteration", index: -1, item, iteration, total };

    for (const [j, innerTask] of task.inner.entries()) {
      const substituted = substituteItem(innerTask, item);
      if (innerTotal > 1) {
        yield {
          type: "step:inner",
          index: -1,
          iteration,
          innerIndex: j,
          innerTotal,
          name: substituted.name,
        };
      }
      try {
        for await (const event of runStep(
          substituted,
          undefined,
          channel,
          workDir,
        )) {
          if (event.type !== "step:iteration" && event.type !== "step:inner") {
            yield event;
          }
        }
      } catch (err) {
        const error = normalizeError(err);
        if (!substituted.continueOnError) {
          yield {
            type: "log",
            level: "warn",
            text: `[forEach] Step "${substituted.name}" failed in iteration ${iteration} ("${item}") — aborting the rest of this iteration`,
          };
          yield {
            type: "step:iteration-complete",
            index: -1,
            iteration,
            status: "error",
            error: error.message,
          };
          return;
        }
        yield {
          type: "log",
          level: "warn",
          text: `[forEach] Step "${substituted.name}" failed in iteration ${iteration} ("${item}", continuing): ${error.message}`,
        };
      }
    }
    yield {
      type: "step:iteration-complete",
      index: -1,
      iteration,
      status: "complete",
    };
  } catch (err) {
    // Belt and suspenders: nothing above should reach here (both throw
    // sites are already caught), but a mis-shaped task or a future edit
    // that adds an uncaught path must still surface as a failed iteration,
    // never as an unhandled rejection that kills unrelated sibling
    // iterations sharing this batch.
    yield {
      type: "step:iteration-complete",
      index: -1,
      iteration,
      status: "error",
      error: normalizeError(err).message,
    };
  }
}

/**
 * Merges multiple async generators into one, yielding each value as soon as
 * its generator produces it — not round-robin, not batched by source.
 * Finished generators drop out; the merge ends once all have.
 */
async function* mergeAsyncGenerators<T>(
  generators: AsyncGenerator<T>[],
): AsyncGenerator<T> {
  const pending = new Map<
    number,
    Promise<{ idx: number; result: IteratorResult<T> }>
  >();

  const pull = (idx: number) =>
    generators[idx]!.next().then((result) => ({ idx, result }));

  generators.forEach((_, idx) => pending.set(idx, pull(idx)));

  while (pending.size > 0) {
    const { idx, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(idx);
    } else {
      yield result.value;
      pending.set(idx, pull(idx));
    }
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
    const { stdout } = await execPromise(forEach, {
      shell: "/bin/sh",
      timeout: 30_000,
      // The resolution command is a step subprocess like any other — it must
      // inherit the current step's TRACEPARENT, not a stale outer one.
      env: { ...process.env, ...traceparentEnv() },
    });
    return stdout.split("\n").filter((l: string) => l.trim().length > 0);
  } catch (err) {
    throw new Error(
      `forEach shell command failed: ${getErrorMessage(err)}\nCommand: ${forEach}`,
    );
  }
}

/** Replaces `{{item}}` placeholders in a task's template fields. */
function substituteItem(task: Task, item: string): Task {
  const sub = (s: string) => s.replace(/\{\{item\}\}/g, item);
  switch (task.type) {
    case "command":
      return { ...task, name: sub(task.name), command: sub(task.command) };
    case "claude":
      return {
        ...task,
        name: sub(task.name),
        prompt: sub(task.prompt),
        allowedTools: task.allowedTools?.map(sub),
      };
    case "log":
      return { ...task, name: sub(task.name), message: sub(task.message) };
    case "forEach":
      return {
        ...task,
        name: sub(task.name),
        forEach: Array.isArray(task.forEach) ? task.forEach : sub(task.forEach),
        inner: task.inner.map((t) => substituteItem(t, item)),
      };
    case "workflow":
      // load-workflow.ts rejects workflow steps inside forEach/repeat at
      // parse time — a WorkflowTask should never reach here.
      throw new Error(
        `Step "${task.name}": workflow steps cannot appear inside forEach (this should have been rejected at load time)`,
      );
    default: {
      const _: never = task;
      throw new Error(`Unknown task type: ${JSON.stringify(_)}`);
    }
  }
}

// ============================================================================
// workflow: runs another workflow as a self-contained nested sub-run
// ============================================================================

async function* runNestedWorkflow(
  task: WorkflowTask,
  from: number[] | undefined,
  channel: InterjectChannel | undefined,
  workDir: string,
): AsyncGenerator<Event> {
  if (from && from.length > 0) {
    throw new Error(
      `Step "${task.name}": resuming into a nested workflow step is not supported — resume from an earlier step or omit the extra --from-step path components`,
    );
  }
  if (!task.workflow) {
    throw new Error(
      `Step "${task.name}" references an unresolved workflow — this is an executant bug (resolveWorkflow() must run before runWorkflow())`,
    );
  }

  // retrospective:false — only the outermost runWorkflow() call should ever
  // generate a post-mortem. Without this, a failing grandchild step would
  // trigger a retrospective here AND again when the error bubbles to the
  // parent's own catch block: duplicate LLM calls, and the parent's version
  // (task = this WorkflowTask wrapper) is far less useful than the child's.
  // workDir is inherited unchanged (not derived from the child workflow's own
  // location) so a single .executant-cancel file stops the whole run at the
  // next step boundary, wherever it is — not just steps at the top level.
  // The child's steps are surfaced to the TUI as iteration rows under this
  // step — one row per child step — so a `workflow:` step expands in the step
  // list instead of hiding its progress in the log pane. Reusing the existing
  // iteration machinery keeps the UI (and the reducer) untouched.
  const childTotal = task.workflow.tasks.length;
  let childIndex = 0;

  for await (const event of runWorkflow(
    task.workflow,
    { retrospective: false, report: false, workDir },
    channel,
  )) {
    switch (event.type) {
      // Load-bearing, not cosmetic: forwarding these unfiltered corrupts the
      // OUTER run. workflow:complete trips the TUI's exit() and CI mode's
      // process.exit(4) the moment the FIRST nested step finishes;
      // workflow:start resets the TUI's startTime and truncates the log file
      // (the logger recreates it on every workflow:start) mid-run.
      case "workflow:start":
      case "workflow:complete":
        continue;
      // The child noticed .executant-cancel and stopped itself — that must
      // stop the WHOLE run, not read as this step having simply finished (see
      // NestedCancellation). Not swallowed like the two cases above.
      case "workflow:cancelled":
        throw new NestedCancellation();
      case "step:skip":
        continue;
      case "step:retrospective":
        continue; // disabled above via retrospective:false — should never fire
      case "step:start":
        childIndex = event.index + 1;
        yield {
          type: "step:iteration",
          index: -1,
          item: event.name,
          iteration: childIndex,
          total: childTotal,
        };
        yield { type: "output:text", index: -1, text: `→ ${event.name}` };
        continue;
      case "step:complete":
        // Without this, the row's endTime never gets set — IterationRow
        // falls back to `Date.now() - startTime` for its duration, so an
        // already-finished child step keeps showing a live, growing elapsed
        // time (tracking the PARENT step's wall clock) instead of freezing
        // at how long that child actually took.
        yield {
          type: "step:iteration-complete",
          index: -1,
          iteration: childIndex,
          status: "complete",
        };
        yield {
          type: "output:text",
          index: -1,
          text: `✓ ${event.name} (${event.durationMs}ms)`,
        };
        continue;
      case "step:error":
        // Don't swallow: this just adds a log line before the child's
        // runWorkflow() rethrows out of this loop, which propagates as this
        // step's own failure in the parent.
        yield {
          type: "step:iteration-complete",
          index: -1,
          iteration: childIndex,
          status: "error",
          error: event.error.message,
        };
        yield {
          type: "output:text",
          index: -1,
          text: `✗ ${event.name}: ${event.error.message}`,
        };
        continue;
      // A forEach (or deeper nesting) inside the child would otherwise append
      // its own rows here, competing with the one-row-per-child-step mapping
      // above. Fold that progress into the current child's row instead.
      case "step:iteration":
        yield {
          type: "step:inner",
          index: -1,
          iteration: childIndex,
          innerIndex: event.iteration - 1,
          innerTotal: event.total,
          name: event.item,
        };
        continue;
      case "step:inner":
        continue;
      default:
        // output:text/tool/cost/structured,
        // step:healing/judge, log — pass through unchanged. The OUTER
        // runWorkflow's index-patch block below unconditionally overwrites
        // .index for these types regardless of what they already carry, so
        // an event from deep inside the nested child still gets correctly
        // re-attributed to the parent's row.
        // (step:interjection is synthesized directly by the TUI, not by
        // runWorkflow's own generator, so it never appears here.)
        yield event;
    }
  }
}
// Self-healing: auto-repair failed script steps via Claude
// ============================================================================

/**
 * Runs a command in a retry loop. On each failure, Claude gets full tool
 * access plus accumulated context from all prior attempts to diagnose and
 * fix the underlying issue. The command exit code is the judge: 0 = pass.
 * Retries up to maxHealingAttempts (default 5).
 */
async function* runCommandWithHealing(
  task: CommandTask,
): AsyncGenerator<Event> {
  const maxAttempts = task.maxHealingAttempts ?? MAX_HEALING_ATTEMPTS;
  // index: -1 here — runWorkflow patches it to the real step index
  const healingEvent = (
    phase: StepHealingEvent["phase"],
    attempt: number,
    exitCode?: number,
  ): StepHealingEvent => ({
    type: "step:healing",
    index: -1,
    phase,
    attempt,
    maxAttempts,
    ...(exitCode !== undefined ? { exitCode } : {}),
  });
  const attemptHistory: Array<{
    fixSummary: string;
    exitCode: number;
    cmdOutput: string;
  }> = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const lines: string[] = [];

    try {
      yield* collectLines(runCommand(task), lines);
      // Command succeeded.
      if (attempt > 0) {
        yield healingEvent("healed", attempt + 1);
        yield {
          type: "log",
          level: "info",
          text: `[self-healing] Command passed after ${attempt + 1} attempts`,
        };
      }
      return;
    } catch (err) {
      const exitCode = err instanceof CommandError ? err.exitCode : 1;
      const output = lines.join("\n");

      const remaining = maxAttempts - attempt - 1;
      if (remaining === 0) {
        yield healingEvent("exhausted", attempt + 1, exitCode);
        yield {
          type: "log",
          level: "warn",
          text: `[self-healing] Exhausted ${maxAttempts} attempts`,
        };
        throw new Error(
          `Step "${task.name}" failed after ${maxAttempts} self-healing attempts (last exit code: ${exitCode})`,
        );
      }

      yield healingEvent("attempt-failed", attempt + 1, exitCode);
      yield {
        type: "log",
        level: "warn",
        text: `[self-healing] Attempt ${attempt + 1}/${maxAttempts} failed (exit ${exitCode}), invoking Claude to fix…`,
      };

      const historyBlock = buildAttemptHistory(attemptHistory);
      const healPrompt = buildHealingPrompt(
        task.command,
        exitCode,
        output,
        historyBlock,
      );

      const healTask: ClaudeTask = {
        type: "claude",
        name: `${task.name}:heal-${attempt + 1}`,
        prompt: healPrompt,
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
        model: DEFAULT_MODEL,
        provider: "claude",
      };

      const toolCalls: string[] = [];
      const claudeLines: string[] = [];
      for await (const event of runAgent(healTask)) {
        if (event.type === "output:text") claudeLines.push(event.text);
        else if (event.type === "output:tool")
          toolCalls.push(formatToolCall(event.tool, event.input));
        yield event;
      }

      // Record this attempt for future context.
      attemptHistory.push({
        fixSummary: buildFixSummary(toolCalls, claudeLines),
        exitCode,
        cmdOutput: output,
      });

      yield {
        type: "log",
        level: "info",
        text: `[self-healing] Re-running command (${remaining} attempt(s) left)…`,
      };
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
 * The channel is only passed to the main step invocations, not the judge.
 */
async function* runClaudeWithJudge(task: ClaudeTask): AsyncGenerator<Event> {
  let judgeContext = "";

  for (let attempt = 0; attempt < MAX_JUDGE_RETRIES; attempt++) {
    // On retries, append judge feedback so Claude can address it.
    const prompt =
      attempt === 0
        ? task.prompt
        : `${task.prompt}\n\n${fillTemplate(JUDGE_RETRY_CONTEXT, { FEEDBACK: judgeContext })}`;

    const lines: string[] = [];
    yield* collectLines(runAgent({ ...task, prompt }), lines);

    // Evaluate output quality.
    yield {
      type: "log",
      level: "info",
      text: `[judge] Evaluating "${task.name}"…`,
    };
    const verdict = await evaluateWithJudge(
      task.name,
      task.prompt,
      lines.join("\n"),
    );

    // index: -1 here — runWorkflow patches it to the real step index
    yield {
      type: "step:judge",
      index: -1,
      verdict: verdict.pass ? "pass" : "fail",
      attempt: attempt + 1,
      maxAttempts: MAX_JUDGE_RETRIES,
      ...(verdict.pass ? {} : { feedback: verdict.feedback }),
    };

    if (verdict.pass) {
      yield { type: "log", level: "info", text: "[judge] PASS" };
      return;
    }

    judgeContext = verdict.feedback;
    yield {
      type: "log",
      level: "warn",
      text: `[judge] FAIL — ${verdict.feedback}`,
    };

    const remaining = MAX_JUDGE_RETRIES - attempt - 1;
    if (remaining === 0) {
      throw new Error(
        `Step "${task.name}" failed judge evaluation after ${MAX_JUDGE_RETRIES} attempts`,
      );
    }
    yield {
      type: "log",
      level: "info",
      text: `[judge] Retrying (${remaining} attempt(s) left)…`,
    };
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
  const result = await runAgentStructured(
    {
      type: "claude",
      name: `judge:${stepName}`,
      prompt: buildJudgePrompt(stepName, stepInstructions, output),
      allowedTools: [],
      permissionMode: "default",
      model: DEFAULT_MODEL,
      provider: "claude",
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
    if (event.type === "output:text") lines.push(event.text);
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
    return readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Context file "${filePath}" could not be read: ${getErrorMessage(err)}`,
    );
  }
}

export function expandContext(task: ClaudeTask): ClaudeTask {
  if (!task.contextFiles || task.contextFiles.length === 0) return task;
  const header = task.contextFiles
    .map((fp) => `### ${fp}\n\`\`\`\n${readContextFile(fp)}\n\`\`\``)
    .join("\n\n");
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
  return fillTemplate(SELF_HEALING_PROMPT, {
    COMMAND: command,
    EXIT_CODE: String(exitCode),
    OUTPUT: output,
    ATTEMPT_HISTORY: attemptHistory,
  });
}

function buildJudgePrompt(
  stepName: string,
  instructions: string,
  output: string,
): string {
  return fillTemplate(JUDGE_EVALUATION_PROMPT, {
    STEP_NAME: stepName,
    STEP_INSTRUCTIONS: instructions,
    OUTPUT: output,
  });
}

/**
 * One line describing a quality-control event, for the retrospective's history
 * block. Judge feedback is the important part: when a step dies to judge
 * exhaustion the error says only "failed after N attempts", and the reasons the
 * judge rejected each attempt exist nowhere else.
 */
export function describeQualityEvent(
  event: StepJudgeEvent | StepHealingEvent,
): string {
  if (event.type === "step:judge") {
    const verdict = event.verdict.toUpperCase();
    const feedback = event.feedback ? ` — ${event.feedback}` : "";
    return `judge attempt ${event.attempt}/${event.maxAttempts}: ${verdict}${feedback}`;
  }
  const exit = event.exitCode !== undefined ? ` (exit ${event.exitCode})` : "";
  return `self-healing attempt ${event.attempt}/${event.maxAttempts}: ${event.phase}${exit}`;
}

function buildFixSummary(toolCalls: string[], claudeLines: string[]): string {
  if (toolCalls.length > 0) return toolCalls.join(", ");
  return claudeLines.join(" ").trim() || "No changes made";
}

function buildAttemptHistory(
  attempts: Array<{ fixSummary: string; exitCode: number; cmdOutput: string }>,
): string {
  if (attempts.length === 0) return "";
  const blocks = attempts.map(
    (a, i) =>
      `--- Attempt ${i + 1} ---\nFix applied: ${a.fixSummary}\nResult: Failed with exit code ${a.exitCode}\nOutput: ${a.cmdOutput}`,
  );
  return `PREVIOUS ATTEMPTS:\n${blocks.join("\n\n")}`;
}
