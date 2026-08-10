// ============================================================================
// UI STATE REDUCER
// ============================================================================
// The Ink UI holds a single ExecutionState managed by useReducer. Every Event
// from the workflow runner is dispatched into this reducer — keeping all state
// transitions in one predictable, testable place.

import type {
  Event,
  ExecutionState,
  IterationRecord,
  TaskState,
  Workflow,
} from "../types.js";
import { stripAnsi } from "../lib/utils.js";
import { formatToolCall } from "./formatTool.js";

export function buildInitialState(workflow: Workflow): ExecutionState {
  return {
    workflow,
    tasks: workflow.tasks.map((task) => ({
      task,
      status: "pending",
      lines: [],
    })),
    currentIndex: 0,
    startTime: Date.now(),
    writtenFiles: [],
  };
}

export function reducer(state: ExecutionState, event: Event): ExecutionState {
  switch (event.type) {
    case "workflow:start":
      return { ...state, startTime: Date.now() };

    case "workflow:complete":
    case "workflow:cancelled":
      return { ...state, endTime: Date.now() };

    case "step:start":
      return updateTask(state, event.index, {
        status: "running",
        startTime: Date.now(),
      });

    case "step:complete": {
      const iterationHistory = finalizeIterations(
        state.tasks[event.index]?.iterationHistory,
        "complete",
      );
      return {
        ...updateTask(state, event.index, {
          status: "complete",
          endTime: Date.now(),
          ...(iterationHistory ? { iterationHistory } : {}),
        }),
        currentIndex: event.index + 1,
      };
    }

    case "step:error": {
      // Advance currentIndex even on error so subsequent output events land on
      // the correct task. continueOnError steps resume at the next step rather
      // than replaying output into the failed one.
      const iterationHistory = finalizeIterations(
        state.tasks[event.index]?.iterationHistory,
        "error",
      );
      return {
        ...updateTask(state, event.index, {
          status: "error",
          endTime: Date.now(),
          error: event.error,
          ...(iterationHistory ? { iterationHistory } : {}),
        }),
        currentIndex: event.index + 1,
      };
    }

    case "step:skip":
      return {
        ...updateTask(state, event.index, { status: "skipped" }),
        currentIndex: event.index + 1,
      };

    case "step:iteration": {
      const prev =
        finalizeIterations(
          state.tasks[event.index]?.iterationHistory,
          "complete",
        ) ?? [];
      // Cap stored history: a forEach over thousands of items would otherwise
      // grow this array without bound (the UI only ever shows the last few).
      // The running record is always the last element, so trimming the front
      // never drops the one that step:inner / finalizeIterations mutate.
      const combined = [
        ...prev,
        {
          item: event.item,
          iteration: event.iteration,
          total: event.total,
          status: "running" as const,
          startTime: Date.now(),
        },
      ];
      return updateTask(state, event.index, {
        iterationHistory:
          combined.length > MAX_ITERATION_HISTORY
            ? combined.slice(-MAX_ITERATION_HISTORY)
            : combined,
      });
    }

    case "step:inner": {
      const iterationHistory = (
        state.tasks[event.index]?.iterationHistory ?? []
      ).map((r) =>
        r.status === "running"
          ? {
              ...r,
              inner: {
                index: event.innerIndex,
                total: event.innerTotal,
                name: event.name,
              },
            }
          : r,
      );
      return updateTask(state, event.index, { iterationHistory });
    }

    case "output:text": {
      const idx = event.index;
      if (idx >= state.tasks.length) return state;
      return appendLines(state, idx, event.text);
    }

    case "output:tool": {
      const idx = event.index;
      if (idx >= state.tasks.length) return state;
      const formatted = formatToolCall(event.tool, event.input);
      const next = formatted ? appendLines(state, idx, formatted) : state;
      if (
        event.tool === "Write" &&
        typeof event.input["file_path"] === "string"
      ) {
        const path = event.input["file_path"];
        // Dedupe (agents rewrite the same file many times) and cap so a run that
        // writes a huge number of distinct files can't grow this array forever.
        if (next.writtenFiles.includes(path)) return next;
        const writtenFiles = [...next.writtenFiles, path];
        return {
          ...next,
          writtenFiles:
            writtenFiles.length > MAX_WRITTEN_FILES
              ? writtenFiles.slice(-MAX_WRITTEN_FILES)
              : writtenFiles,
        };
      }
      return next;
    }

    case "output:cost":
      return state; // cost events are intentionally not shown in the TUI

    case "output:structured":
      return state; // structured output is consumed by callers, not shown in the TUI

    case "log": {
      const idx = state.currentIndex;
      if (idx >= state.tasks.length) return state;
      return appendLines(state, idx, `[${event.level}] ${event.text}`);
    }

    case "step:interjection": {
      const idx = event.index;
      if (idx >= state.tasks.length) return state;
      return appendLines(state, idx, `[interjection] ${event.message}`);
    }

    case "step:retrospective":
      return { ...state, retrospective: event.retrospective };

    case "step:healing":
    case "step:judge":
      // Structured telemetry events — the accompanying free-text log events
      // already render this progress in the TUI, so don't double-render.
      return state;

    default: {
      // Compile-time exhaustiveness check: TypeScript will error here if a new
      // Event variant is added to types.ts without a corresponding case above.
      const _: never = event;
      void _; // suppress unused-variable warning at runtime
      return state;
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Hard cap on stored lines per task. Prevents unbounded growth for long-running
// steps with verbose output (e.g. npm install).
const MAX_LOG_LINES = 300;

// Hard cap on iteration records kept per forEach task. The UI only renders the
// last MAX_VISIBLE_ITERATIONS (8); the rest are history. A few hundred is plenty
// to keep the "N earlier" count meaningful while bounding memory on long loops.
const MAX_ITERATION_HISTORY = 500;

// Hard cap on the deduped list of written file paths shown after completion.
const MAX_WRITTEN_FILES = 500;

/**
 * Strips ANSI escape codes and splits on newlines so every stored entry is
 * exactly one terminal row. This prevents multi-line <Text> content from
 * causing Ink to miscount its rendered height, which manifests as text
 * "spraying" above the UI area on re-renders.
 */
export function normalizeLines(text: string): string[] {
  return stripAnsi(text).split("\n");
}

function finalizeIterations(
  prev: IterationRecord[] | undefined,
  status: "complete" | "error",
): IterationRecord[] | undefined {
  if (!prev?.length) return undefined;
  return prev.map((r) =>
    r.status === "running" ? { ...r, status, endTime: Date.now() } : r,
  );
}

function updateTask(
  state: ExecutionState,
  index: number,
  patch: Partial<TaskState>,
): ExecutionState {
  const tasks = state.tasks.map((t, i) =>
    i === index ? { ...t, ...patch } : t,
  );
  return { ...state, tasks };
}

function appendLines(
  state: ExecutionState,
  index: number,
  text: string,
): ExecutionState {
  const newLines = normalizeLines(text);
  const tasks = state.tasks.map((t, i) => {
    if (i !== index) return t;
    const combined = [...t.lines, ...newLines];
    const lines =
      combined.length > MAX_LOG_LINES
        ? combined.slice(-MAX_LOG_LINES)
        : combined;
    return { ...t, lines };
  });
  return { ...state, tasks };
}
