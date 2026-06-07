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

export function resolveLogDir(workflowFilePath: string): string {
  const startDir = dirname(resolve(workflowFilePath));
  const executantLocal = findExecutantLocalDir(startDir);
  return executantLocal ? join(executantLocal, "logs") : join(startDir, "logs");
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
  if (logFile) appendFileSync(logFile, text + "\n");
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

export interface Logger {
  observe(event: Event): void;
}

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
  logger: Logger,
): AsyncGenerator<Event> {
  for await (const event of gen) {
    logger.observe(event);
    yield event;
  }
}
