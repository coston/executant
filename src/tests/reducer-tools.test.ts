// ============================================================================
// REDUCER — output:tool formatting
// ============================================================================
// Tests that tool calls are formatted into human-readable TUI log lines via the
// reducer's output:tool handler.  formatToolCall is private, so we drive it
// through the public reducer.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadWorkflow } from "../load-workflow.js";
import { reducer, buildInitialState } from "../ui/reducer.js";
import type { ExecutionState } from "../types.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function tmpYaml(content: string): string {
  const dir = join(tmpdir(), `executant-reducer-tools-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`,
  );
  writeFileSync(file, content, "utf8");
  return file;
}

/** Create a minimal running state with one step in progress. */
function runningState(): ExecutionState {
  const wf = loadWorkflow(
    tmpYaml(`
goal: test
steps:
  - name: step1
    command: echo hi
`),
  );
  let state = buildInitialState(wf);
  state = reducer(state, { type: "step:start", index: 0, name: "step1" });
  return state;
}

/** Dispatch an output:tool event and return the last appended line. */
function formatViaReducer(
  state: ExecutionState,
  tool: string,
  input: Record<string, unknown>,
): string {
  const next = reducer(state, { type: "output:tool", index: 0, tool, input });
  const lines = next.tasks[0].lines;
  return lines[lines.length - 1] ?? "";
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("reducer — output:tool formatting", () => {
  const savedDebug = process.env["EXECUTANT_DEBUG"];
  afterEach(() => {
    if (savedDebug === undefined) delete process.env["EXECUTANT_DEBUG"];
    else process.env["EXECUTANT_DEBUG"] = savedDebug;
  });

  test("Read tool shows file path", () => {
    const line = formatViaReducer(runningState(), "Read", {
      file_path: "/src/index.ts",
    });
    assert.equal(line, "[Read] /src/index.ts");
  });

  test("Edit tool shows file path", () => {
    const line = formatViaReducer(runningState(), "Edit", {
      file_path: "/src/app.ts",
    });
    assert.equal(line, "[Edit] /src/app.ts");
  });

  test("Write tool shows file path", () => {
    const line = formatViaReducer(runningState(), "Write", {
      file_path: "/tmp/out.txt",
    });
    assert.equal(line, "[Write] /tmp/out.txt");
  });

  test("Bash tool shows description and command as separate lines", () => {
    const state = runningState();
    const next = reducer(state, {
      type: "output:tool",
      index: 0,
      tool: "Bash",
      input: { description: "Run tests", command: "npm test" },
    });
    const lines = next.tasks[0].lines;
    assert.ok(
      lines.some((l) => l.includes("[Bash] Run tests")),
      `description not found: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) => l.includes("$ npm test")),
      `command not found: ${JSON.stringify(lines)}`,
    );
  });

  test("Glob tool shows pattern", () => {
    const line = formatViaReducer(runningState(), "Glob", {
      pattern: "**/*.ts",
    });
    assert.equal(line, "[Glob] **/*.ts");
  });

  test("Grep tool shows pattern", () => {
    const line = formatViaReducer(runningState(), "Grep", { pattern: "TODO" });
    assert.equal(line, "[Grep] TODO");
  });

  test("Agent tool shows subagent_type and description", () => {
    const line = formatViaReducer(runningState(), "Agent", {
      subagent_type: "Explore",
      description: "Search codebase",
      prompt: "Find all the things...",
    });
    assert.equal(line, "[Agent:Explore] Search codebase");
  });

  test("Agent tool without subagent_type shows ?", () => {
    const line = formatViaReducer(runningState(), "Agent", {
      description: "Do something",
      prompt: "Long prompt text...",
    });
    assert.equal(line, "[Agent:?] Do something");
  });

  test("Agent tool does not leak prompt JSON", () => {
    const line = formatViaReducer(runningState(), "Agent", {
      subagent_type: "Explore",
      description: "Search codebase",
      prompt: "Find all the things with lots of detail...",
    });
    assert.ok(
      !line.includes("Find all the things"),
      `prompt should not appear in output: ${line}`,
    );
    assert.ok(!line.includes("{"), `no JSON in output: ${line}`);
  });

  test("unknown tools are suppressed in normal mode", () => {
    delete process.env["EXECUTANT_DEBUG"];
    const state = runningState();
    const next = reducer(state, {
      type: "output:tool",
      index: 0,
      tool: "SomeNewTool",
      input: { foo: "bar" },
    });
    // No new line should be appended (formatToolCall returns '')
    assert.equal(next.tasks[0].lines.length, state.tasks[0].lines.length);
  });

  test("unknown tools show JSON in debug mode", () => {
    process.env["EXECUTANT_DEBUG"] = "1";
    const line = formatViaReducer(runningState(), "SomeNewTool", {
      foo: "bar",
    });
    assert.ok(
      line.includes("[SomeNewTool]"),
      `expected tool name, got: ${line}`,
    );
    assert.ok(line.includes('"foo"'), `expected JSON, got: ${line}`);
  });

  test("TodoWrite shows in-progress tasks", () => {
    const line = formatViaReducer(runningState(), "TodoWrite", {
      todos: [
        { status: "completed", content: "done task" },
        { status: "in_progress", content: "working on this" },
      ],
    });
    assert.ok(line.includes("[Task]"), `expected [Task], got: ${line}`);
    assert.ok(
      line.includes("working on this"),
      `expected task content, got: ${line}`,
    );
  });

  test("TodoWrite with no in-progress tasks produces no output", () => {
    const state = runningState();
    const next = reducer(state, {
      type: "output:tool",
      index: 0,
      tool: "TodoWrite",
      input: { todos: [{ status: "completed", content: "done" }] },
    });
    assert.equal(next.tasks[0].lines.length, state.tasks[0].lines.length);
  });

  test("Write tool tracks written files", () => {
    const state = runningState();
    const next = reducer(state, {
      type: "output:tool",
      index: 0,
      tool: "Write",
      input: { file_path: "/tmp/new-file.ts" },
    });
    assert.ok(next.writtenFiles.includes("/tmp/new-file.ts"));
  });
});

// ----------------------------------------------------------------------------
// Core state transitions
// ----------------------------------------------------------------------------

describe("reducer — core state transitions", () => {
  function buildState(): ExecutionState {
    return buildInitialState(
      loadWorkflow(
        tmpYaml(`
goal: test
steps:
  - name: step-a
    command: echo a
  - name: step-b
    command: echo b
`),
      ),
    );
  }

  test("buildInitialState sets all tasks to pending", () => {
    const state = buildState();
    assert.ok(
      state.tasks.every((t) => t.status === "pending"),
      "all tasks should be pending",
    );
  });

  test("buildInitialState initialises writtenFiles as empty array", () => {
    const state = buildState();
    assert.deepEqual(state.writtenFiles, []);
  });

  test("workflow:start updates startTime", () => {
    const state = buildState();
    const before = Date.now();
    const next = reducer(state, {
      type: "workflow:start",
      workflow: state.workflow,
    });
    assert.ok(next.startTime >= before, "startTime should be updated");
  });

  test("workflow:complete sets endTime", () => {
    const state = buildState();
    const before = Date.now();
    const next = reducer(state, {
      type: "workflow:complete",
      workflow: state.workflow,
      durationMs: 100,
    });
    assert.ok((next.endTime ?? 0) >= before, "endTime should be set");
  });

  test("step:start marks the task as running and sets startTime", () => {
    const state = buildState();
    const next = reducer(state, {
      type: "step:start",
      index: 0,
      name: "step-a",
    });
    assert.equal(next.tasks[0].status, "running");
    assert.ok(next.tasks[0].startTime !== undefined, "startTime should be set");
  });

  test("step:complete marks task complete and advances currentIndex", () => {
    let state = buildState();
    state = reducer(state, { type: "step:start", index: 0, name: "step-a" });
    state = reducer(state, {
      type: "step:complete",
      index: 0,
      name: "step-a",
      durationMs: 10,
    });
    assert.equal(state.tasks[0].status, "complete");
    assert.equal(state.currentIndex, 1);
  });

  test("step:error marks task errored and advances currentIndex", () => {
    let state = buildState();
    state = reducer(state, { type: "step:start", index: 0, name: "step-a" });
    state = reducer(state, {
      type: "step:error",
      index: 0,
      name: "step-a",
      error: new Error("boom"),
    });
    assert.equal(state.tasks[0].status, "error");
    assert.equal(state.currentIndex, 1);
  });

  test("step:skip marks task skipped and advances currentIndex", () => {
    let state = buildState();
    state = reducer(state, { type: "step:skip", index: 0, name: "step-a" });
    assert.equal(state.tasks[0].status, "skipped");
    assert.equal(state.currentIndex, 1);
  });

  test("output:cost leaves state unchanged", () => {
    const state = buildState();
    const next = reducer(state, { type: "output:cost", usd: 0.05 });
    assert.deepEqual(next, state);
  });

  test("output:text with index beyond tasks.length is a no-op", () => {
    const state = buildState();
    const next = reducer(state, {
      type: "output:text",
      index: 999,
      text: "oob",
    });
    assert.deepEqual(next, state);
  });

  test("log event appends line to currentIndex task", () => {
    let state = buildState();
    state = reducer(state, { type: "step:start", index: 0, name: "step-a" });
    state = reducer(state, { type: "log", level: "info", text: "starting up" });
    assert.ok(
      state.tasks[0].lines.some((l) => l.includes("[info] starting up")),
    );
  });

  test("log event uses [warn] prefix for warn level", () => {
    let state = buildState();
    state = reducer(state, { type: "step:start", index: 0, name: "step-a" });
    state = reducer(state, {
      type: "log",
      level: "warn",
      text: "something degraded",
    });
    assert.ok(state.tasks[0].lines.some((l) => l.startsWith("[warn]")));
  });

  test("lines accumulate up to the cap (< 300 lines)", () => {
    let state = buildState();
    state = reducer(state, { type: "step:start", index: 0, name: "step-a" });
    for (let i = 0; i < 250; i++) {
      state = reducer(state, {
        type: "output:text",
        index: 0,
        text: `line ${i}`,
      });
    }
    assert.equal(state.tasks[0].lines.length, 250);
    assert.equal(state.tasks[0].lines.at(-1), "line 249");
  });

  test("lines are capped at 300 and the most recent are kept", () => {
    let state = buildState();
    state = reducer(state, { type: "step:start", index: 0, name: "step-a" });
    for (let i = 0; i < 350; i++) {
      state = reducer(state, {
        type: "output:text",
        index: 0,
        text: `line ${i}`,
      });
    }
    const lines = state.tasks[0].lines;
    assert.equal(lines.length, 300);
    assert.equal(lines.at(-1), "line 349");
    assert.equal(lines[0], "line 50");
  });
});
