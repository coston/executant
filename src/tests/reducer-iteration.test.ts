// ============================================================================
// REDUCER — forEach iteration history
// ============================================================================
// Tests that step:iteration and step:inner events build an IterationRecord
// history in TaskState, and that step:complete / step:error finalize it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadWorkflow } from "../load-workflow.js";
import { reducer, buildInitialState } from "../ui/reducer.js";
import type { ExecutionState } from "../types.js";
import { tmpYaml } from "./helpers.js";

function forEachState(): ExecutionState {
  const wf = loadWorkflow(
    tmpYaml(`
goal: test forEach
steps:
  - name: process files
    forEach:
      - a.ts
      - b.ts
      - c.ts
    steps:
      - name: lint
        command: echo lint
      - name: test
        command: echo test
`),
  );
  let state = buildInitialState(wf);
  state = reducer(state, {
    type: "step:start",
    index: 0,
    name: "process files",
  });
  return state;
}

describe("reducer — iteration history", () => {
  test("step:iteration creates first IterationRecord", () => {
    let state = forEachState();
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "a.ts",
      iteration: 1,
      total: 3,
    });
    const history = state.tasks[0].iterationHistory;
    assert.ok(history);
    assert.equal(history.length, 1);
    assert.equal(history[0].item, "a.ts");
    assert.equal(history[0].iteration, 1);
    assert.equal(history[0].total, 3);
    assert.equal(history[0].status, "running");
    assert.ok(history[0].startTime > 0);
    assert.equal(history[0].endTime, undefined);
  });

  test("second step:iteration marks first as complete and appends new record", () => {
    let state = forEachState();
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "a.ts",
      iteration: 1,
      total: 3,
    });
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "b.ts",
      iteration: 2,
      total: 3,
    });
    const history = state.tasks[0].iterationHistory;
    assert.ok(history);
    assert.equal(history.length, 2);
    assert.equal(history[0].item, "a.ts");
    assert.equal(history[0].status, "complete");
    assert.ok(history[0].endTime !== undefined);
    assert.equal(history[1].item, "b.ts");
    assert.equal(history[1].status, "running");
    assert.equal(history[1].endTime, undefined);
  });

  test("step:inner updates the running iteration's inner field", () => {
    let state = forEachState();
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "a.ts",
      iteration: 1,
      total: 3,
    });
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 1,
      innerIndex: 0,
      innerTotal: 2,
      name: "lint",
    });
    const running = state.tasks[0].iterationHistory?.find(
      (r) => r.status === "running",
    );
    assert.ok(running?.inner);
    assert.equal(running.inner.index, 0);
    assert.equal(running.inner.total, 2);
    assert.equal(running.inner.name, "lint");
  });

  test("step:inner updating to second child step updates inner field", () => {
    let state = forEachState();
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "a.ts",
      iteration: 1,
      total: 3,
    });
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 1,
      innerIndex: 0,
      innerTotal: 2,
      name: "lint",
    });
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 1,
      innerIndex: 1,
      innerTotal: 2,
      name: "test",
    });
    const running = state.tasks[0].iterationHistory?.find(
      (r) => r.status === "running",
    );
    assert.ok(running?.inner);
    assert.equal(running.inner.index, 1);
    assert.equal(running.inner.name, "test");
  });

  test("step:complete finalizes last running iteration and advances currentIndex", () => {
    let state = forEachState();
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "a.ts",
      iteration: 1,
      total: 3,
    });
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "b.ts",
      iteration: 2,
      total: 3,
    });
    state = reducer(state, {
      type: "step:complete",
      index: 0,
      name: "process files",
      durationMs: 1000,
    });
    const history = state.tasks[0].iterationHistory;
    assert.ok(history);
    assert.ok(history.every((r) => r.status === "complete"));
    assert.ok(history.every((r) => r.endTime !== undefined));
    assert.equal(state.tasks[0].status, "complete");
    assert.equal(state.currentIndex, 1);
  });

  test("step:error marks last running iteration as error", () => {
    let state = forEachState();
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "a.ts",
      iteration: 1,
      total: 3,
    });
    state = reducer(state, {
      type: "step:error",
      index: 0,
      name: "process files",
      error: new Error("lint failed"),
    });
    const history = state.tasks[0].iterationHistory;
    assert.ok(history);
    assert.equal(history[0].status, "error");
    assert.ok(history[0].endTime !== undefined);
    assert.equal(state.tasks[0].status, "error");
  });

  test("tasks without forEach have no iterationHistory", () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: simple
steps:
  - name: build
    command: npm run build
`),
    );
    let state = buildInitialState(wf);
    state = reducer(state, { type: "step:start", index: 0, name: "build" });
    state = reducer(state, {
      type: "step:complete",
      index: 0,
      name: "build",
      durationMs: 500,
    });
    assert.equal(state.tasks[0].iterationHistory, undefined);
  });

  test("new iteration's inner starts as undefined", () => {
    let state = forEachState();
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "a.ts",
      iteration: 1,
      total: 3,
    });
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 1,
      innerIndex: 0,
      innerTotal: 2,
      name: "lint",
    });
    // Start next iteration — the new record should have no inner
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "b.ts",
      iteration: 2,
      total: 3,
    });
    const running = state.tasks[0].iterationHistory?.find(
      (r) => r.status === "running",
    );
    assert.equal(running?.item, "b.ts");
    assert.equal(running?.inner, undefined);
  });

  test("step:complete on non-forEach task leaves iterationHistory undefined", () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: simple
steps:
  - name: build
    command: npm run build
`),
    );
    let state = buildInitialState(wf);
    state = reducer(state, { type: "step:start", index: 0, name: "build" });
    state = reducer(state, {
      type: "step:complete",
      index: 0,
      name: "build",
      durationMs: 500,
    });
    assert.equal(state.tasks[0].iterationHistory, undefined);
  });

  test("iterationHistory is capped so a huge forEach can't grow it forever", () => {
    let state = forEachState();
    for (let i = 0; i < 600; i++) {
      state = reducer(state, {
        type: "step:iteration",
        index: 0,
        item: `item-${i}.ts`,
        iteration: i + 1,
        total: 600,
      });
    }
    const history = state.tasks[0].iterationHistory;
    assert.ok(history);
    // Cap is 500; the running (last) record is always retained.
    assert.equal(history.length, 500);
    assert.equal(history.at(-1)?.item, "item-599.ts");
    assert.equal(history.at(-1)?.status, "running");
  });

  test("step:inner and step:complete still work after the cap trims old records", () => {
    let state = forEachState();
    for (let i = 0; i < 600; i++) {
      state = reducer(state, {
        type: "step:iteration",
        index: 0,
        item: `item-${i}.ts`,
        iteration: i + 1,
        total: 600,
      });
    }
    // step:inner must still find and update the running (last) record.
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 600,
      innerIndex: 0,
      innerTotal: 2,
      name: "lint",
    });
    const running = state.tasks[0].iterationHistory?.find(
      (r) => r.status === "running",
    );
    assert.equal(running?.inner?.name, "lint");
    // step:complete finalizes every retained record.
    state = reducer(state, {
      type: "step:complete",
      index: 0,
      name: "process files",
      durationMs: 1000,
    });
    assert.ok(
      state.tasks[0].iterationHistory?.every((r) => r.status === "complete"),
    );
  });

  test("all three iterations tracked in full workflow", () => {
    let state = forEachState();
    // Simulate all 3 iterations
    for (let i = 0; i < 3; i++) {
      const items = ["a.ts", "b.ts", "c.ts"];
      state = reducer(state, {
        type: "step:iteration",
        index: 0,
        item: items[i],
        iteration: i + 1,
        total: 3,
      });
    }
    state = reducer(state, {
      type: "step:complete",
      index: 0,
      name: "process files",
      durationMs: 3000,
    });
    const history = state.tasks[0].iterationHistory;
    assert.ok(history);
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((r) => r.item),
      ["a.ts", "b.ts", "c.ts"],
    );
    assert.ok(history.every((r) => r.status === "complete"));
  });
});
