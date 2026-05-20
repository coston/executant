// ============================================================================
// REDUCER — output:text normalization
// ============================================================================
// Verifies that multi-line text, ANSI escape codes, and carriage returns are
// properly normalized before being stored in the task lines array. This prevents
// raw escape codes from leaking into <Text> elements and corrupting Ink's
// cursor-position tracking (which manifests as text "spraying" above the TUI).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadWorkflow } from "../load-workflow.js";
import { reducer, buildInitialState, normalizeLines } from "../ui/reducer.js";
import type { ExecutionState } from "../types.js";
import { tmpYaml } from "./helpers.js";

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

function dispatchText(state: ExecutionState, text: string): string[] {
  return reducer(state, { type: "output:text", index: 0, text }).tasks[0].lines;
}

// ----------------------------------------------------------------------------
// normalizeLines unit tests
// ----------------------------------------------------------------------------

describe("normalizeLines", () => {
  test("splits on newlines", () => {
    assert.deepEqual(normalizeLines("a\nb\nc"), ["a", "b", "c"]);
  });

  test("strips ANSI color codes", () => {
    assert.deepEqual(normalizeLines("\x1B[32mgreen\x1B[0m"), ["green"]);
  });

  test("strips ANSI cursor-movement sequences", () => {
    assert.deepEqual(normalizeLines("\x1B[2Khello"), ["hello"]);
    assert.deepEqual(normalizeLines("\x1B[1Aup"), ["up"]);
  });

  test("strips ANSI OSC sequences", () => {
    assert.deepEqual(normalizeLines("\x1B]0;title\x07text"), ["text"]);
  });

  test("strips carriage returns", () => {
    assert.deepEqual(normalizeLines("progress\roverwrite"), [
      "progressoverwrite",
    ]);
  });

  test("handles mixed content", () => {
    const input = "\x1B[32m✓\x1B[0m compiled\r\nwarning: unused var";
    assert.deepEqual(normalizeLines(input), [
      "✓ compiled",
      "warning: unused var",
    ]);
  });

  test("preserves empty strings from blank lines", () => {
    const result = normalizeLines("a\n\nb");
    assert.equal(result.length, 3);
    assert.equal(result[1], "");
  });
});

// ----------------------------------------------------------------------------
// Reducer integration tests — output:text
// ----------------------------------------------------------------------------

describe("reducer output:text normalization", () => {
  test("splits multi-line text into multiple entries", () => {
    const state = runningState();
    const lines = dispatchText(state, "first\nsecond\nthird");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "first");
    assert.equal(lines[1], "second");
    assert.equal(lines[2], "third");
  });

  test("strips ANSI codes before storing", () => {
    const state = runningState();
    const lines = dispatchText(state, "\x1B[32mgreen text\x1B[0m");
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "green text");
  });

  test("strips carriage returns before storing", () => {
    const state = runningState();
    const lines = dispatchText(state, "loading...\rloaded");
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "loading...loaded");
  });

  test("handles multi-line ANSI output", () => {
    const state = runningState();
    const lines = dispatchText(state, "\x1B[1mBold\x1B[0m\nplain");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "Bold");
    assert.equal(lines[1], "plain");
  });
});

// ----------------------------------------------------------------------------
// Reducer integration tests — lines cap
// ----------------------------------------------------------------------------

describe("reducer lines cap", () => {
  test("caps at MAX_LOG_LINES (300) and keeps the most recent", () => {
    let state = runningState();
    for (let i = 0; i < 350; i++) {
      state = reducer(state, {
        type: "output:text",
        index: 0,
        text: `line ${i}`,
      });
    }
    const lines = state.tasks[0].lines;
    assert.ok(lines.length <= 300, `expected ≤300 lines, got ${lines.length}`);
    // Most recent lines are preserved
    assert.ok(
      lines[lines.length - 1].startsWith("line 34"),
      "last line should be line 349",
    );
  });

  test("does not cap when under the limit", () => {
    let state = runningState();
    for (let i = 0; i < 50; i++) {
      state = reducer(state, {
        type: "output:text",
        index: 0,
        text: `line ${i}`,
      });
    }
    assert.equal(state.tasks[0].lines.length, 50);
  });
});
