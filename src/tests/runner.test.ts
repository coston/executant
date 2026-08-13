// ============================================================================
// RUNNER — runWorkflow options
// ============================================================================
// Tests for RunOptions: stepFilter by name, stepFilter by index, fromStep.
// Uses real Workflow objects with script steps to avoid Claude API calls.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type {
  Event,
  FromStepTarget,
  OutputTextEvent,
  StepErrorEvent,
  StepInnerEvent,
  StepIterationEvent,
  StepRetrospectiveEvent,
  StepSkipEvent,
  StepStartEvent,
  Workflow,
  WorkflowCancelledEvent,
  WorkflowCompleteEvent,
} from "../types.js";
import {
  collectEvents,
  collectEventsUntilError,
  installSequencedMock,
  tmpDir,
  tmpYaml,
} from "./helpers.js";
import { loadWorkflow } from "../load-workflow.js";
import { resolveWorkflow } from "../resolve-workflow.js";
import { runWorkflow, shouldSkipStep } from "../runner.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function stepNames(events: Event[]): string[] {
  return events
    .filter((e): e is StepStartEvent => e.type === "step:start")
    .map((e) => e.name);
}

function skippedNames(events: Event[]): string[] {
  return events
    .filter((e): e is StepSkipEvent => e.type === "step:skip")
    .map((e) => e.name);
}

function makeWorkflow(
  steps: Array<{ name: string; command: string }>,
): Workflow {
  const yaml = `
goal: test
steps:
${steps.map((s) => `  - name: ${s.name}\n    command: ${s.command}`).join("\n")}
`;
  return loadWorkflow(tmpYaml(yaml));
}

async function collectWithOptions(
  workflow: Workflow,
  options: Parameters<typeof runWorkflow>[1],
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const e of runWorkflow(workflow, options)) events.push(e);
  return events;
}

// ----------------------------------------------------------------------------
// shouldSkipStep — unit tests
// ----------------------------------------------------------------------------

describe("shouldSkipStep", () => {
  test("returns false when no options are set", () => {
    assert.equal(shouldSkipStep(1, "any", {}), false);
  });

  test("stepFilter: skips a step whose name does not match", () => {
    assert.equal(shouldSkipStep(2, "build", { stepFilter: "test" }), true);
  });

  test("stepFilter: does not skip a step whose name matches", () => {
    assert.equal(shouldSkipStep(2, "test", { stepFilter: "test" }), false);
  });

  test("stepFilter: matches by 1-based index string", () => {
    assert.equal(shouldSkipStep(3, "build", { stepFilter: "3" }), false);
  });

  test("stepFilter: skips when index does not match and name does not match", () => {
    assert.equal(shouldSkipStep(2, "build", { stepFilter: "3" }), true);
  });

  test('stepFilter: numeric string "0" never matches (1-based)', () => {
    assert.equal(shouldSkipStep(1, "first", { stepFilter: "0" }), true);
  });

  test("fromStep: skips steps before the threshold", () => {
    assert.equal(shouldSkipStep(2, "step", { fromStep: [3] }), true);
  });

  test("fromStep: does not skip the threshold step itself", () => {
    assert.equal(shouldSkipStep(3, "step", { fromStep: [3] }), false);
  });

  test("fromStep: does not skip steps after the threshold", () => {
    assert.equal(shouldSkipStep(4, "step", { fromStep: [3] }), false);
  });

  test("fromStep: dot-notation [3,2] still skips top-level steps before 3", () => {
    assert.equal(shouldSkipStep(2, "step", { fromStep: [3, 2] }), true);
    assert.equal(shouldSkipStep(3, "step", { fromStep: [3, 2] }), false);
    assert.equal(shouldSkipStep(4, "step", { fromStep: [3, 2] }), false);
  });

  test("toStep: does not skip steps at or before the threshold", () => {
    assert.equal(shouldSkipStep(2, "step", { toStep: 3 }), false);
    assert.equal(shouldSkipStep(3, "step", { toStep: 3 }), false);
  });

  test("toStep: skips steps after the threshold", () => {
    assert.equal(shouldSkipStep(4, "step", { toStep: 3 }), true);
  });

  test("fromStep + toStep: skips outside the inclusive range", () => {
    const options = { fromStep: [11] as FromStepTarget, toStep: 14 };
    assert.equal(shouldSkipStep(10, "step", options), true);
    assert.equal(shouldSkipStep(11, "step", options), false);
    assert.equal(shouldSkipStep(14, "step", options), false);
    assert.equal(shouldSkipStep(15, "step", options), true);
  });
});

// ----------------------------------------------------------------------------
// stepFilter — by name
// ----------------------------------------------------------------------------

describe("runWorkflow — stepFilter by name", () => {
  test("runs only the named step", async () => {
    const wf = makeWorkflow([
      { name: "first", command: "echo first" },
      { name: "second", command: "echo second" },
      { name: "third", command: "echo third" },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: "second" });
    assert.deepEqual(stepNames(events), ["second"]);
  });

  test("skips non-matching steps", async () => {
    const wf = makeWorkflow([
      { name: "first", command: "echo first" },
      { name: "second", command: "echo second" },
      { name: "third", command: "echo third" },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: "second" });
    assert.deepEqual(skippedNames(events), ["first", "third"]);
  });

  test("no steps run when name does not match any step", async () => {
    const wf = makeWorkflow([
      { name: "alpha", command: "echo a" },
      { name: "beta", command: "echo b" },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: "nonexistent" });
    assert.deepEqual(stepNames(events), []);
    assert.deepEqual(skippedNames(events), ["alpha", "beta"]);
  });
});

// ----------------------------------------------------------------------------
// stepFilter — by 1-based index
// ----------------------------------------------------------------------------

describe("runWorkflow — stepFilter by index", () => {
  test("runs only the step at the given 1-based index", async () => {
    const wf = makeWorkflow([
      { name: "first", command: "echo first" },
      { name: "second", command: "echo second" },
      { name: "third", command: "echo third" },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: "2" });
    assert.deepEqual(stepNames(events), ["second"]);
    assert.deepEqual(skippedNames(events), ["first", "third"]);
  });

  test("index 1 runs the first step", async () => {
    const wf = makeWorkflow([
      { name: "first", command: "echo first" },
      { name: "second", command: "echo second" },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: "1" });
    assert.deepEqual(stepNames(events), ["first"]);
  });

  test("index matching last step runs only that step", async () => {
    const wf = makeWorkflow([
      { name: "a", command: "echo a" },
      { name: "b", command: "echo b" },
      { name: "c", command: "echo c" },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: "3" });
    assert.deepEqual(stepNames(events), ["c"]);
  });
});

// ----------------------------------------------------------------------------
// fromStep
// ----------------------------------------------------------------------------

describe("runWorkflow — fromStep", () => {
  test("skips steps before fromStep", async () => {
    const wf = makeWorkflow([
      { name: "first", command: "echo first" },
      { name: "second", command: "echo second" },
      { name: "third", command: "echo third" },
    ]);
    const events = await collectWithOptions(wf, { fromStep: [2] });
    assert.deepEqual(stepNames(events), ["second", "third"]);
    assert.deepEqual(skippedNames(events), ["first"]);
  });

  test("fromStep: 1 runs all steps", async () => {
    const wf = makeWorkflow([
      { name: "a", command: "echo a" },
      { name: "b", command: "echo b" },
    ]);
    const events = await collectWithOptions(wf, { fromStep: [1] });
    assert.deepEqual(stepNames(events), ["a", "b"]);
  });

  test("fromStep beyond last step skips everything", async () => {
    const wf = makeWorkflow([{ name: "only", command: "echo hi" }]);
    const events = await collectWithOptions(wf, { fromStep: [99] });
    assert.deepEqual(stepNames(events), []);
    assert.deepEqual(skippedNames(events), ["only"]);
  });
});

// ----------------------------------------------------------------------------
// toStep
// ----------------------------------------------------------------------------

describe("runWorkflow — toStep", () => {
  test("skips steps after toStep", async () => {
    const wf = makeWorkflow([
      { name: "first", command: "echo first" },
      { name: "second", command: "echo second" },
      { name: "third", command: "echo third" },
    ]);
    const events = await collectWithOptions(wf, { toStep: 2 });
    assert.deepEqual(stepNames(events), ["first", "second"]);
    assert.deepEqual(skippedNames(events), ["third"]);
  });

  test("toStep matching the last step runs all steps", async () => {
    const wf = makeWorkflow([
      { name: "a", command: "echo a" },
      { name: "b", command: "echo b" },
    ]);
    const events = await collectWithOptions(wf, { toStep: 2 });
    assert.deepEqual(stepNames(events), ["a", "b"]);
    assert.deepEqual(skippedNames(events), []);
  });

  test("fromStep + toStep together run only the inclusive range", async () => {
    const wf = makeWorkflow([
      { name: "a", command: "echo a" },
      { name: "b", command: "echo b" },
      { name: "c", command: "echo c" },
      { name: "d", command: "echo d" },
      { name: "e", command: "echo e" },
    ]);
    const events = await collectWithOptions(wf, {
      fromStep: [2],
      toStep: 4,
    });
    assert.deepEqual(stepNames(events), ["b", "c", "d"]);
    assert.deepEqual(skippedNames(events), ["a", "e"]);
  });
});

// ----------------------------------------------------------------------------
// continueOnError
// ----------------------------------------------------------------------------

describe("runWorkflow — continueOnError", () => {
  test("workflow aborts on step failure by default", async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: failing
    command: exit 1
    self_healing: false
  - name: unreachable
    command: echo hi
`);
    const wf = loadWorkflow(file);
    const { events, error } = await collectEventsUntilError(wf);
    assert.ok(error, "expected an error");
    assert.ok(
      events.every(
        (e) =>
          e.type !== "step:start" ||
          (e as StepStartEvent).name !== "unreachable",
      ),
      "unreachable step should not have started",
    );
  });

  test("continueOnError allows workflow to continue past a failed step", async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: failing
    command: exit 1
    continue_on_error: true
    self_healing: false
  - name: after
    command: echo after
`);
    const wf = loadWorkflow(file);
    const events = await collectEvents(wf);
    assert.deepEqual(stepNames(events), ["failing", "after"]);
  });
});

// ----------------------------------------------------------------------------
// log steps
// ----------------------------------------------------------------------------

describe("runWorkflow — log steps", () => {
  test("log step emits output:text with the message", async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: marker
    type: log
    message: "Hello from log step"
`);
    const wf = loadWorkflow(file);
    const events = await collectEvents(wf);
    const textEvents = events.filter((e) => e.type === "output:text");
    assert.ok(
      textEvents.some(
        (e) => (e as { text: string }).text === "Hello from log step",
      ),
      "expected log message in output:text events",
    );
  });
});

// ----------------------------------------------------------------------------
// lastOutput on step:error and workflow:complete
// ----------------------------------------------------------------------------

describe("runWorkflow — lastOutput", () => {
  test("step:error includes lastOutput with command output", async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: failing
    command: echo "before failure" && exit 1
    self_healing: false
`);
    const wf = loadWorkflow(file);
    const { events } = await collectEventsUntilError(wf);
    const errorEvent = events.find(
      (e): e is StepErrorEvent => e.type === "step:error",
    );
    assert.ok(errorEvent, "expected step:error event");
    assert.ok(
      errorEvent.lastOutput !== undefined,
      "expected lastOutput to be set",
    );
    assert.ok(
      errorEvent.lastOutput!.includes("before failure"),
      `expected "before failure" in lastOutput, got: ${errorEvent.lastOutput}`,
    );
  });

  test("workflow:complete includes lastOutput from final step", async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: produce
    command: echo "final output line"
`);
    const wf = loadWorkflow(file);
    const events = await collectEvents(wf);
    const completeEvent = events.find(
      (e): e is WorkflowCompleteEvent => e.type === "workflow:complete",
    );
    assert.ok(completeEvent, "expected workflow:complete event");
    assert.ok(
      completeEvent.lastOutput !== undefined,
      "expected lastOutput to be set",
    );
    assert.ok(
      completeEvent.lastOutput!.includes("final output line"),
      `expected "final output line" in lastOutput, got: ${completeEvent.lastOutput}`,
    );
  });

  test("workflow:complete lastOutput is undefined when final step has no output", async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: silent
    command: "exit 0"
`);
    const wf = loadWorkflow(file);
    const events = await collectEvents(wf);
    const completeEvent = events.find(
      (e): e is WorkflowCompleteEvent => e.type === "workflow:complete",
    );
    assert.ok(completeEvent, "expected workflow:complete event");
    assert.equal(completeEvent.lastOutput, undefined);
  });

  test("workflow:complete lastOutput reflects failing continueOnError step, not previous success", async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: success
    command: echo "success-output"
  - name: failing
    command: echo "failure-output" && exit 1
    continue_on_error: true
    self_healing: false
`);
    const wf = loadWorkflow(file);
    const events = await collectEvents(wf);
    const completeEvent = events.find(
      (e): e is WorkflowCompleteEvent => e.type === "workflow:complete",
    );
    assert.ok(completeEvent, "expected workflow:complete event");
    assert.ok(
      completeEvent.lastOutput?.includes("failure-output"),
      `expected lastOutput to reflect the failing step, got: ${completeEvent.lastOutput}`,
    );
    assert.ok(
      !completeEvent.lastOutput?.includes("success-output"),
      "lastOutput should not contain output from the prior successful step",
    );
  });

  test("lines ring-buffer caps at LAST_OUTPUT_MAX_LINES without unbounded growth", async () => {
    // Emit 150 lines; lastOutput should contain only the last 100.
    const commands = Array.from(
      { length: 150 },
      (_, i) => `echo "line${i + 1}"`,
    ).join(" && ");
    const file = tmpYaml(`
goal: test
steps:
  - name: verbose
    command: ${commands}
`);
    const wf = loadWorkflow(file);
    const events = await collectEvents(wf);
    const completeEvent = events.find(
      (e): e is WorkflowCompleteEvent => e.type === "workflow:complete",
    );
    assert.ok(completeEvent, "expected workflow:complete event");
    const lines = completeEvent.lastOutput?.split("\n") ?? [];
    assert.ok(
      lines.length <= 100,
      `expected at most 100 lines, got ${lines.length}`,
    );
    // Lines 51-150 are retained; lines 1-50 are dropped.
    assert.ok(
      lines.some((l) => l === "line150"),
      "line150 must be present",
    );
    assert.ok(
      !lines.some((l) => l === "line1"),
      "line1 must have been dropped",
    );
  });
});

// ----------------------------------------------------------------------------
// File-based cancellation
// ----------------------------------------------------------------------------

describe("runWorkflow — cancellation", () => {
  // Each test gets its own workDir so the cancel file never lands in process.cwd().
  // Test files run concurrently on CI; a shared process.cwd() cancel file would
  // be picked up by unrelated runWorkflow calls in other test files.
  let workDir: string;
  let cancelFile: string;

  beforeEach(() => {
    workDir = tmpDir();
    cancelFile = join(workDir, ".executant-cancel");
  });

  afterEach(() => {
    try {
      rmSync(cancelFile);
    } catch {
      /* already gone */
    }
  });

  test("emits workflow:cancelled and stops when .executant-cancel exists", async () => {
    writeFileSync(cancelFile, "");
    const file = tmpYaml(`
goal: test
steps:
  - name: step-one
    command: echo one
  - name: step-two
    command: echo two
`);
    const wf = loadWorkflow(file);
    const events: Event[] = [];
    for await (const e of runWorkflow(wf, { workDir })) events.push(e);

    const cancelled = events.find(
      (e): e is WorkflowCancelledEvent => e.type === "workflow:cancelled",
    );
    assert.ok(cancelled, "expected workflow:cancelled event");
    assert.ok(
      events.every((e) => e.type !== "step:start"),
      "no steps should have started before cancellation",
    );
  });

  test("deletes .executant-cancel file after cancelling", async () => {
    writeFileSync(cancelFile, "");
    const file = tmpYaml(`
goal: test
steps:
  - name: step
    command: echo hi
`);
    const wf = loadWorkflow(file);
    for await (const _e of runWorkflow(wf, { workDir })) {
      /* consume */
    }
    assert.equal(
      existsSync(cancelFile),
      false,
      ".executant-cancel should be deleted",
    );
  });

  test("does not emit workflow:cancelled when cancel file is absent", async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: step
    command: echo hi
`);
    const wf = loadWorkflow(file);
    const events: Event[] = [];
    for await (const e of runWorkflow(wf, { workDir })) events.push(e);
    const cancelled = events.find((e) => e.type === "workflow:cancelled");
    assert.equal(cancelled, undefined, "should not cancel when file absent");
  });
});

// ----------------------------------------------------------------------------
// Nested workflow steps
// ----------------------------------------------------------------------------

function writeYaml(dir: string, name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

async function loadNested(parentPath: string): Promise<Workflow> {
  return resolveWorkflow(loadWorkflow(parentPath));
}

describe("runWorkflow — nested workflow steps", () => {
  test("one step:start/step:complete for the parent, not per child step", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: build\n    command: echo build\n  - name: push\n    command: echo push\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
    );

    const wf = await loadNested(parentPath);
    const events = await collectEvents(wf);
    assert.deepEqual(stepNames(events), ["deploy"]);
    assert.equal(events.filter((e) => e.type === "step:complete").length, 1);
  });

  test("child step boundaries surface as output:text under the parent's index", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: build\n    command: echo build\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
    );

    const wf = await loadNested(parentPath);
    const events = await collectEvents(wf);
    const text = events
      .filter((e): e is OutputTextEvent => e.type === "output:text")
      .filter((e) => e.index === 0)
      .map((e) => e.text);
    assert.ok(text.some((t) => t.includes("build")));
  });

  test("child steps surface as iteration rows under the parent step", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: build\n    command: echo build\n  - name: push\n    command: echo push\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
    );

    const wf = await loadNested(parentPath);
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === "step:iteration",
    );
    assert.deepEqual(
      iterations.map((e) => [e.item, e.iteration, e.total, e.index]),
      [
        ["build", 1, 2, 0],
        ["push", 2, 2, 0],
      ],
    );
  });

  test("a forEach inside the child folds into the child step's row, not new rows", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: fan-out\n    forEach:\n      - a\n      - b\n    command: echo {{item}}\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
    );

    const wf = await loadNested(parentPath);
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === "step:iteration",
    );
    assert.deepEqual(
      iterations.map((e) => e.item),
      ["fan-out"],
    );
    const inner = events.filter(
      (e): e is StepInnerEvent => e.type === "step:inner",
    );
    assert.deepEqual(
      inner.map((e) => [e.name, e.innerIndex, e.innerTotal, e.index]),
      [
        ["a", 0, 2, 0],
        ["b", 1, 2, 0],
      ],
    );
  });

  test("child failure propagates as the parent step's error", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: fail-here\n    command: exit 1\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
    );

    const wf = await loadNested(parentPath);
    const { events, error } = await collectEventsUntilError(wf);
    assert.ok(error);
    const errorEvent = events.find(
      (e): e is StepErrorEvent => e.type === "step:error",
    );
    assert.equal(errorEvent?.name, "deploy");
    assert.ok(errorEvent?.lastOutput?.includes("fail-here"));
  });

  test("continue_on_error on the workflow step lets the outer run continue", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: fail-here\n    command: exit 1\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n    continue_on_error: true\n  - name: after\n    command: echo after\n",
    );

    const wf = await loadNested(parentPath);
    const events = await collectEvents(wf);
    assert.deepEqual(stepNames(events), ["deploy", "after"]);
    assert.ok(events.some((e) => e.type === "workflow:complete"));
  });

  test("exactly one retrospective fires when a nested step fails", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: fail-here\n    command: exit 1\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
    );
    const wf = await loadNested(parentPath);

    const { promptsDir } = installSequencedMock([
      JSON.stringify({
        summary: "The child step failed.",
        rootCause: "exit 1",
        workflowFixable: false,
      }),
    ]);

    const events: Event[] = [];
    try {
      for await (const e of runWorkflow(wf, { retrospective: true }))
        events.push(e);
    } catch {
      /* expected */
    }

    const retros = events.filter(
      (e): e is StepRetrospectiveEvent => e.type === "step:retrospective",
    );
    assert.equal(retros.length, 1);
    assert.equal(retros[0].retrospective.step, "deploy");
    // Only one Claude invocation total — if the child's own runWorkflow()
    // also generated a retrospective, this would be 2.
    assert.equal(readdirSync(promptsDir).length, 1);
  });

  test("--from-step targeting into a workflow step throws a clear error", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: build\n    command: echo build\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
    );

    const wf = await loadNested(parentPath);
    await assert.rejects(
      () => collectWithOptions(wf, { fromStep: [1, 1] }),
      /resuming into a nested workflow step is not supported/,
    );
  });

  test("cancelling while inside a nested workflow step stops the whole run, using the parent's workDir", async () => {
    const dir = tmpDir();
    const workDir = tmpDir(); // deliberately distinct from process.cwd()
    const cancelFile = join(workDir, ".executant-cancel");
    // No cancel file exists yet when the run starts — the parent enters the
    // nested workflow normally. The child's own first step drops the cancel
    // file as a side effect (simulating an operator cancelling mid-run); the
    // child's own loop must notice it before its second step, and that must
    // propagate all the way up to stop the parent's remaining steps too.
    writeYaml(
      dir,
      "child.yaml",
      `goal: child\nsteps:\n  - name: arm-cancel\n    command: printf '' > "${cancelFile}"\n  - name: push\n    command: echo push\n`,
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n  - name: after\n    command: echo after\n",
    );

    const wf = await loadNested(parentPath);
    const events = await collectWithOptions(wf, { workDir });

    // If workDir weren't threaded into the nested runWorkflow() call, the
    // child's own cancel check would fall back to process.cwd() instead of
    // this workDir, never see the file arm-cancel just wrote, and both
    // "push" and the parent's "after" step would run normally.
    const cancelled = events.filter((e) => e.type === "workflow:cancelled");
    assert.equal(cancelled.length, 1);
    assert.deepEqual(stepNames(events), ["deploy"]);
    assert.ok(
      events.every((e) => e.type !== "output:text" || !e.text.includes("push")),
      "the child's second step should never have started",
    );
  });
});
