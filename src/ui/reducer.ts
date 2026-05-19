// ============================================================================
// UI STATE REDUCER
// ============================================================================
// The Ink UI holds a single ExecutionState managed by useReducer. Every Event
// from the workflow runner is dispatched into this reducer — keeping all state
// transitions in one predictable, testable place.

import type { Event, ExecutionState, TaskState, Workflow } from "../types.js";
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
      return { ...state, endTime: Date.now() };

    case "step:start":
      return updateTask(state, event.index, {
        status: "running",
        startTime: Date.now(),
      });

    case "step:complete": {
      const prev = state.tasks[event.index]?.iterationHistory;
      const iterationHistory = prev?.length
        ? prev.map((r) =>
            r.status === "running"
              ? { ...r, status: "complete" as const, endTime: Date.now() }
              : r,
          )
        : undefined;
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
      const prev = state.tasks[event.index]?.iterationHistory;
      const iterationHistory = prev?.length
        ? prev.map((r) =>
            r.status === "running"
              ? { ...r, status: "error" as const, endTime: Date.now() }
              : r,
          )
        : undefined;
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
      const prev = (state.tasks[event.index]?.iterationHistory ?? []).map(
        (r) =>
          r.status === "running"
            ? { ...r, status: "complete" as const, endTime: Date.now() }
            : r,
      );
      return updateTask(state, event.index, {
        iterationHistory: [
          ...prev,
          {
            item: event.item,
            iteration: event.iteration,
            total: event.total,
            status: "running" as const,
            startTime: Date.now(),
          },
        ],
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
      return appendLine(state, idx, event.text);
    }

    case "output:tool": {
      const idx = event.index;
      if (idx >= state.tasks.length) return state;
      const formatted = formatToolCall(event.tool, event.input);
      const next = formatted ? appendLine(state, idx, formatted) : state;
      if (
        event.tool === "Write" &&
        typeof event.input["file_path"] === "string"
      ) {
        return {
          ...next,
          writtenFiles: [...next.writtenFiles, event.input["file_path"]],
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
      return appendLine(state, idx, `[${event.level}] ${event.text}`);
    }

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

function appendLine(
  state: ExecutionState,
  index: number,
  line: string,
): ExecutionState {
  const tasks = state.tasks.map((t, i) => {
    if (i !== index) return t;
    const lines = [...t.lines, line];
    return { ...t, lines };
  });
  return { ...state, tasks };
}

/** Formats a tool call as a human-readable line for the log pane. */
