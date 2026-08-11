// ============================================================================
// EXECUTION LOGGER
// ============================================================================
//
// Subscribes to the runner's event stream and writes a full timestamped
// execution log (.log file) to .claude/executant.local/logs/.
//
// Logging is ENABLED by default. Disable with EXECUTANT_LOG=0.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Event } from "./types.js";
import {
  slugify,
  formatTimestamp,
  getErrorMessage,
  getToolArg,
} from "./lib/utils.js";

// ============================================================================
// Log directory resolution
// ============================================================================

export function findExecutantLocalDir(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".claude", "executant.local");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Same resolution, but starting from a directory (used for remote workflows). */
export function resolveLogDirFrom(startDir: string): string {
  const dir = resolve(startDir);
  const executantLocal = findExecutantLocalDir(dir);
  return executantLocal ? join(executantLocal, "logs") : join(dir, "logs");
}

// ============================================================================
// State machine
// ============================================================================

/** Fixed values determined at logger creation — never change across events. */
interface LogContext {
  readonly logDir: string;
  readonly ts: string;
  readonly slug: string;
}

/** Mutable snapshot replaced (not mutated) on each event. */
interface LogState {
  readonly logFile: string;
  readonly stepIndex: number;
  readonly stepName: string;
  readonly stepStartMs: number;
}

const INIT_STATE: LogState = {
  logFile: "",
  stepIndex: -1,
  stepName: "",
  stepStartMs: 0,
};

// ============================================================================
// Pure handlers — each performs its side-effects and returns the new state
// ============================================================================

function appendLog(logFile: string, text: string): void {
  if (!logFile) return;
  try {
    appendFileSync(logFile, text + "\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // The log dir lives inside the workspace and can be removed mid-run by a
    // workflow step (e.g. `git clean`). Recreate it and retry once so a transient
    // deletion self-heals instead of turning every subsequent write into an
    // ENOENT flood. Append mode recreates the file itself.
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, text + "\n");
  }
}

function onWorkflowStart(ctx: LogContext, s: LogState): LogState {
  mkdirSync(ctx.logDir, { recursive: true });
  const logFile = join(ctx.logDir, `${ctx.ts}_${ctx.slug}.log`);
  writeFileSync(
    logFile,
    `# Execution Log\nTask: ${ctx.slug}\nStarted: ${new Date().toISOString()}\n${"━".repeat(51)}\n\n`,
  );
  return { ...s, logFile };
}

function onStepStart(
  ctx: LogContext,
  s: LogState,
  index: number,
  name: string,
): LogState {
  const next: LogState = {
    ...INIT_STATE,
    logFile: s.logFile,
    stepIndex: index,
    stepName: name,
    stepStartMs: Date.now(),
  };
  appendLog(
    next.logFile,
    `\n${"━".repeat(51)}\nStep ${index + 1}: ${name}\nStarted: ${new Date().toISOString()}\n${"━".repeat(51)}\n`,
  );
  return next;
}

function onStepComplete(s: LogState): LogState {
  appendLog(
    s.logFile,
    `\nStep completed in ${((Date.now() - s.stepStartMs) / 1000).toFixed(1)}s\n`,
  );
  return s;
}

function onStepError(s: LogState, error: Error): LogState {
  appendLog(s.logFile, `\nStep failed: ${error.message}\n`);
  return s;
}

function onTool(
  s: LogState,
  tool: string,
  input: Record<string, unknown>,
): LogState {
  appendLog(s.logFile, `   [${tool}] ${getToolArg(tool, input)}`);
  return s;
}

function onLogMessage(s: LogState, level: string, text: string): LogState {
  appendLog(s.logFile, `[${level}] ${text}`);
  return s;
}

function onWorkflowComplete(ctx: LogContext, s: LogState): LogState {
  appendLog(
    s.logFile,
    `\n${"━".repeat(51)}\nTask Complete: ${ctx.slug}\nFinished: ${new Date().toISOString()}\n${"━".repeat(51)}\n`,
  );
  return s;
}

// ============================================================================
// Reducer — routes each event to its handler
// ============================================================================

function reduce(ctx: LogContext, s: LogState, event: Event): LogState {
  switch (event.type) {
    case "workflow:start":
      return onWorkflowStart(ctx, s);
    case "step:start":
      return onStepStart(ctx, s, event.index, event.name);
    case "step:complete":
      return onStepComplete(s);
    case "step:error":
      return onStepError(s, event.error);
    case "step:iteration":
      appendLog(
        s.logFile,
        `\n── iteration ${event.iteration}/${event.total}: ${event.item}`,
      );
      return s;
    case "step:inner":
      appendLog(
        s.logFile,
        `   ↳ [${event.innerIndex + 1}/${event.innerTotal}] ${event.name}`,
      );
      return s;
    case "output:text":
      appendLog(s.logFile, event.text);
      return s;
    case "output:tool":
      return onTool(s, event.tool, event.input);
    case "step:retrospective": {
      // The post-mortem is the most useful thing in the file for whoever reads
      // it after the fact — write it out in full, not just as a log line.
      const r = event.retrospective;
      const suggestions = r.suggestions.map(
        (x) =>
          `  · [${x.severity}] ${x.step ? `${x.step}: ` : ""}${x.issue}\n    → ${x.change}`,
      );
      appendLog(
        s.logFile,
        [
          `\n── retrospective: ${r.step}`,
          r.summary,
          `root cause: ${r.rootCause}`,
          ...r.evidence.map((e) => `  · ${e}`),
          ...suggestions,
          r.workflowFixable
            ? `suggested refine: ${r.refineInstruction}`
            : "no workflow change would have prevented this",
        ].join("\n"),
      );
      return s;
    }
    case "log":
      return onLogMessage(s, event.level, event.text);
    case "workflow:complete":
    case "workflow:cancelled":
      return onWorkflowComplete(ctx, s);
    default:
      return s;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Anything that synchronously observes the event stream — the file logger and
 * the telemetry exporter share this shape so withLogger can tee to either.
 */
export interface Observer {
  observe(event: Event): void;
}

/** The file logger is just one Observer. */
export type Logger = Observer;

export function createLogger(logDir: string, taskName: string): Logger {
  const ctx: LogContext = {
    logDir,
    ts: formatTimestamp(new Date()),
    slug: slugify(taskName, 40) || "task",
  };
  const enabled = process.env["EXECUTANT_LOG"] !== "0";
  let state = INIT_STATE;

  return {
    observe(event: Event): void {
      if (!enabled) return;
      try {
        state = reduce(ctx, state, event);
      } catch (err) {
        console.warn(`[logger] error: ${getErrorMessage(err)}`);
      }
    },
  };
}

// ============================================================================
// Event stream tee
// ============================================================================

export async function* withLogger(
  gen: AsyncGenerator<Event>,
  observer: Observer,
): AsyncGenerator<Event> {
  for await (const event of gen) {
    observer.observe(event);
    yield event;
  }
}
