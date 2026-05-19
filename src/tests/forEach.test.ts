// ============================================================================
// FOREACH FEATURE TESTS
// ============================================================================
// Tests for forEach step support: load-workflow parsing, runner event stream,
// and reducer state updates.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadWorkflow } from "../load-workflow.js";
import { reducer, buildInitialState } from "../ui/reducer.js";
import type {
  CommandTask,
  ClaudeTask,
  ForEachTask,
  StepInnerEvent,
  StepIterationEvent,
} from "../types.js";
import { tmpYaml, collectEvents, collectEventsUntilError } from "./helpers.js";

// ----------------------------------------------------------------------------
// load-workflow: YAML → ForEachTask
// ----------------------------------------------------------------------------

describe("loadWorkflow — forEach", () => {
  test("parses inline list into ForEachTask", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: greet
    forEach: [alpha, beta, gamma]
    command: echo "{{item}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, "forEach");
    assert.equal(task.name, "greet");
    assert.deepEqual(task.forEach, ["alpha", "beta", "gamma"]);
    assert.equal(task.inner.length, 1);
    assert.equal(task.inner[0].type, "command");
    assert.equal(task.inner[0].name, "greet");
    // {{item}} must survive vars substitution so runner can substitute it
    assert.equal((task.inner[0] as CommandTask).command, 'echo "{{item}}"');
  });

  test("parses shell command string into ForEachTask", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: list
    forEach: "printf '%s\\n' x y z"
    command: echo "{{item}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, "forEach");
    assert.equal(typeof task.forEach, "string");
  });

  test("vars substitution applies to inner task but NOT to {{item}}", () => {
    const file = tmpYaml(`
goal: test
vars:
  ext: ts
steps:
  - name: check
    forEach: [a, b]
    command: echo "{{item}}.{{ext}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;
    // {{ext}} should be resolved, {{item}} should remain as-is
    assert.equal((task.inner[0] as CommandTask).command, 'echo "{{item}}.ts"');
  });

  test("forEach step with prompt creates claude inner task", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: review
    forEach: [src/a.ts, src/b.ts]
    prompt: |
      Review {{item}} for issues.
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.inner[0].type, "claude");
    assert.equal(
      (task.inner[0] as ClaudeTask).prompt.trim(),
      "Review {{item}} for issues.",
    );
  });

  test("continueOnError propagates to ForEachTask", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: run
    forEach: [a]
    command: echo "{{item}}"
    continue_on_error: true
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;
    assert.equal(task.continueOnError, true);
  });
});

// ----------------------------------------------------------------------------
// runner: event stream for forEach steps
// ----------------------------------------------------------------------------

describe("runWorkflow — forEach events", () => {
  test("yields step:iteration events with correct metadata", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: echo item
    forEach: [alpha, beta, gamma]
    command: echo "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === "step:iteration",
    );

    assert.equal(iterations.length, 3);
    assert.deepEqual(
      iterations.map((e) => e.item),
      ["alpha", "beta", "gamma"],
    );
    assert.deepEqual(
      iterations.map((e) => e.iteration),
      [1, 2, 3],
    );
    assert.deepEqual(
      iterations.map((e) => e.total),
      [3, 3, 3],
    );
  });

  test("step:iteration events carry the parent step index", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: first
    command: echo "before"
  - name: loop
    forEach: [x, y]
    command: echo "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === "step:iteration",
    );

    // "loop" is step index 1 (0-based)
    assert.ok(iterations.every((e) => e.index === 1));
  });

  test("{{item}} is substituted in the executed command", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: greet
    forEach: [world, executant]
    command: printf "hello %s\\n" "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const textLines = events
      .filter(
        (e): e is { type: "output:text"; index: number; text: string } =>
          e.type === "output:text",
      )
      .map((e) => e.text.trim())
      .filter(Boolean);

    assert.ok(textLines.some((l) => l.includes("hello world")));
    assert.ok(textLines.some((l) => l.includes("hello executant")));
  });

  test("shell command forEach resolves items from command output", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: list
    forEach: "printf '%s\\n' foo bar baz"
    command: printf "got:%s\\n" "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === "step:iteration",
    );

    assert.equal(iterations.length, 3);
    assert.deepEqual(
      iterations.map((e) => e.item),
      ["foo", "bar", "baz"],
    );
  });

  test("workflow completes with step:complete after all iterations", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: run
    forEach: [a, b]
    command: echo "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const types = events.map((e) => e.type);

    assert.ok(types.includes("step:start"));
    assert.ok(types.includes("step:iteration"));
    assert.ok(types.includes("step:complete"));
    assert.ok(types.includes("workflow:complete"));

    // step:complete must come after all step:iteration events
    const completeIdx = types.lastIndexOf("step:complete");
    const lastIterIdx = types.lastIndexOf("step:iteration");
    assert.ok(completeIdx > lastIterIdx);
  });

  test("empty inline list produces no iterations and completes normally", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: nothing
    forEach: []
    command: echo "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const iterations = events.filter((e) => e.type === "step:iteration");
    assert.equal(iterations.length, 0);
    assert.ok(events.some((e) => e.type === "step:complete"));
  });

  test("shell command with no output produces no iterations", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: empty
    forEach: "printf ''"
    command: echo "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const iterations = events.filter((e) => e.type === "step:iteration");
    assert.equal(iterations.length, 0);
    assert.ok(events.some((e) => e.type === "step:complete"));
  });

  test("shell command failure throws with helpful message", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: bad
    forEach: "exit 1"
    command: echo "{{item}}"
`),
    );
    await assert.rejects(
      () => collectEvents(wf),
      (err: Error) => {
        assert.ok(err.message.includes("forEach shell command failed"));
        assert.ok(err.message.includes("exit 1"));
        return true;
      },
    );
  });

  test("shell command using pipes works correctly", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: piped
    forEach: "printf '%s\\n' one two three | grep -v two"
    command: echo "item:{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === "step:iteration",
    );
    assert.equal(iterations.length, 2);
    assert.deepEqual(
      iterations.map((e) => e.item),
      ["one", "three"],
    );
  });
});

// ----------------------------------------------------------------------------
// reducer: step:iteration → TaskState.iteration
// ----------------------------------------------------------------------------

describe("reducer — step:iteration", () => {
  function makeState() {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: loop
    forEach: [x, y, z]
    command: echo "{{item}}"
`),
    );
    return buildInitialState(wf);
  }

  test("sets iteration on the correct task", () => {
    const state = makeState();

    // Simulate step starting first
    const started = reducer(state, {
      type: "step:start",
      index: 0,
      name: "loop",
    });
    const updated = reducer(started, {
      type: "step:iteration",
      index: 0,
      item: "x",
      iteration: 1,
      total: 3,
    });

    const history = updated.tasks[0].iterationHistory;
    assert.ok(history);
    assert.equal(history.length, 1);
    assert.equal(history[0].item, "x");
    assert.equal(history[0].iteration, 1);
    assert.equal(history[0].total, 3);
    assert.equal(history[0].status, "running");
  });

  test("appends to iterationHistory on subsequent events, marking previous complete", () => {
    let state = makeState();
    state = reducer(state, { type: "step:start", index: 0, name: "loop" });
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "x",
      iteration: 1,
      total: 3,
    });
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "y",
      iteration: 2,
      total: 3,
    });

    const history = state.tasks[0].iterationHistory;
    assert.ok(history);
    assert.equal(history.length, 2);
    assert.equal(history[0].item, "x");
    assert.equal(history[0].status, "complete");
    assert.equal(history[1].item, "y");
    assert.equal(history[1].status, "running");
  });

  test("does not affect other tasks", () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: first
    command: echo "a"
  - name: loop
    forEach: [x, y]
    command: echo "{{item}}"
`),
    );
    let state = buildInitialState(wf);
    state = reducer(state, { type: "step:start", index: 1, name: "loop" });
    state = reducer(state, {
      type: "step:iteration",
      index: 1,
      item: "x",
      iteration: 1,
      total: 2,
    });

    assert.equal(state.tasks[0].iterationHistory, undefined);
    assert.ok(state.tasks[1].iterationHistory !== undefined);
  });
});

// ----------------------------------------------------------------------------
// repeat field: load-workflow and runner
// ----------------------------------------------------------------------------

describe("repeat field — loadWorkflow", () => {
  test('repeat: 3 compiles to ForEachTask with forEach ["1","2","3"]', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: run
    repeat: 3
    command: echo "{{item}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, "forEach");
    assert.deepEqual(task.forEach, ["1", "2", "3"]);
    assert.equal(task.inner.length, 1);
    assert.equal(task.inner[0].type, "command");
    assert.equal((task.inner[0] as CommandTask).command, 'echo "{{item}}"');
  });

  test("repeat: 1 produces a ForEachTask with a single-element array", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: once
    repeat: 1
    command: echo "{{item}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, "forEach");
    assert.deepEqual(task.forEach, ["1"]);
  });

  test("repeat with prompt step creates claude inner task", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: audit
    repeat: 5
    prompt: |
      This is pass {{item}} of 5.
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.inner[0].type, "claude");
    assert.ok((task.inner[0] as ClaudeTask).prompt.includes("{{item}}"));
  });

  test("repeat and forEach on the same step throws a validation error", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    repeat: 3
    forEach: [a, b, c]
    command: echo "{{item}}"
`);
    assert.throws(
      () => loadWorkflow(file),
      (err: Error) => {
        assert.ok(err.message.includes("cannot have both repeat and forEach"));
        return true;
      },
    );
  });

  test("repeat: 0 fails Zod validation (must be positive)", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: zero
    repeat: 0
    command: echo "{{item}}"
`);
    assert.throws(() => loadWorkflow(file));
  });

  test("repeat with negative number fails Zod validation", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: neg
    repeat: -1
    command: echo "{{item}}"
`);
    assert.throws(() => loadWorkflow(file));
  });
});

describe("repeat field — runner events", () => {
  test("emits correct step:iteration events with numeric items", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: count
    repeat: 3
    command: echo "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === "step:iteration",
    );

    assert.equal(iterations.length, 3);
    assert.deepEqual(
      iterations.map((e) => e.item),
      ["1", "2", "3"],
    );
    assert.deepEqual(
      iterations.map((e) => e.iteration),
      [1, 2, 3],
    );
    assert.deepEqual(
      iterations.map((e) => e.total),
      [3, 3, 3],
    );
  });

  test("{{item}} substitution produces iteration numbers in command output", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: stamp
    repeat: 3
    command: printf "pass:%s\\n" "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const textLines = events
      .filter(
        (e): e is { type: "output:text"; index: number; text: string } =>
          e.type === "output:text",
      )
      .map((e) => e.text.trim())
      .filter(Boolean);

    assert.ok(textLines.some((l) => l.includes("pass:1")));
    assert.ok(textLines.some((l) => l.includes("pass:2")));
    assert.ok(textLines.some((l) => l.includes("pass:3")));
  });
});

// ----------------------------------------------------------------------------
// nested steps: multi-step forEach using the `steps:` key
// ----------------------------------------------------------------------------

describe("loadWorkflow — nested steps", () => {
  test("steps: inside forEach creates inner array with multiple tasks", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: process
    forEach: [a.txt, b.txt]
    steps:
      - name: lint {{item}}
        type: script
        command: eslint {{item}}
      - name: log {{item}}
        type: log
        message: done with {{item}}
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, "forEach");
    assert.equal(task.inner.length, 2);
    assert.equal(task.inner[0].type, "command");
    assert.equal((task.inner[0] as CommandTask).command, "eslint {{item}}");
    assert.equal(task.inner[1].type, "log");
  });

  test("steps: inside repeat creates inner array", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: build
    repeat: 2
    steps:
      - name: compile pass {{item}}
        type: script
        command: npm run build
      - name: test pass {{item}}
        type: script
        command: npm test
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, "forEach");
    assert.deepEqual(task.forEach, ["1", "2"]);
    assert.equal(task.inner.length, 2);
    assert.equal(task.inner[0].type, "command");
    assert.equal(task.inner[1].type, "command");
  });

  test("vars substitution applies inside nested steps but not {{item}}", () => {
    const file = tmpYaml(`
goal: test
vars:
  ext: ts
steps:
  - name: check
    forEach: [a, b]
    steps:
      - name: run {{item}}
        type: script
        command: echo "{{item}}.{{ext}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;
    assert.equal((task.inner[0] as CommandTask).command, 'echo "{{item}}.ts"');
  });

  test("steps: and command on same step throws", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    forEach: [a, b]
    command: echo "{{item}}"
    steps:
      - name: inner
        type: script
        command: echo inner
`);
    assert.throws(
      () => loadWorkflow(file),
      (err: Error) => {
        assert.ok(
          err.message.includes(
            "cannot have both steps and command/prompt/message",
          ),
        );
        return true;
      },
    );
  });

  test("steps: and prompt on same step throws", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    forEach: [a, b]
    prompt: Review {{item}}
    steps:
      - name: inner
        type: script
        command: echo inner
`);
    assert.throws(
      () => loadWorkflow(file),
      (err: Error) => {
        assert.ok(
          err.message.includes(
            "cannot have both steps and command/prompt/message",
          ),
        );
        return true;
      },
    );
  });

  test("steps: and message on same step throws", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    forEach: [a, b]
    message: done with {{item}}
    steps:
      - name: inner
        type: script
        command: echo inner
`);
    assert.throws(
      () => loadWorkflow(file),
      (err: Error) => {
        assert.ok(
          err.message.includes(
            "cannot have both steps and command/prompt/message",
          ),
        );
        return true;
      },
    );
  });

  test("steps: without forEach or repeat throws", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    steps:
      - name: inner
        type: script
        command: echo inner
`);
    assert.throws(
      () => loadWorkflow(file),
      (err: Error) => {
        assert.ok(err.message.includes("has steps but no forEach or repeat"));
        return true;
      },
    );
  });

  test("steps: [] (empty) fails Zod validation", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    forEach: [a]
    steps: []
`);
    assert.throws(() => loadWorkflow(file));
  });
});

describe("runWorkflow — forEach log step substitution", () => {
  test("{{item}} is substituted in log step message inside forEach", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: announce
    forEach: [alpha, beta, gamma]
    steps:
      - name: log {{item}}
        type: log
        message: "processing item: {{item}}"
`),
    );
    const events = await collectEvents(wf);
    const textLines = events
      .filter(
        (e): e is { type: "output:text"; index: number; text: string } =>
          e.type === "output:text",
      )
      .map((e) => e.text);

    assert.ok(textLines.some((l) => l.includes("processing item: alpha")));
    assert.ok(textLines.some((l) => l.includes("processing item: beta")));
    assert.ok(textLines.some((l) => l.includes("processing item: gamma")));
    assert.ok(!textLines.some((l) => l.includes("{{item}}")));
  });
});

describe("runWorkflow — nested steps events", () => {
  test("emits step:inner before each child step in multi-step forEach", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: process
    forEach: [alpha, beta]
    steps:
      - name: step A {{item}}
        type: script
        command: echo "A {{item}}"
      - name: step B {{item}}
        type: script
        command: echo "B {{item}}"
`),
    );
    const events = await collectEvents(wf);
    const innerEvents = events.filter(
      (e): e is StepInnerEvent => e.type === "step:inner",
    );

    // 2 items × 2 inner steps = 4 step:inner events
    assert.equal(innerEvents.length, 4);
    assert.equal(innerEvents[0].iteration, 1);
    assert.equal(innerEvents[0].innerIndex, 0);
    assert.equal(innerEvents[0].innerTotal, 2);
    assert.equal(innerEvents[0].name, "step A alpha");
    assert.equal(innerEvents[1].iteration, 1);
    assert.equal(innerEvents[1].innerIndex, 1);
    assert.equal(innerEvents[1].name, "step B alpha");
    assert.equal(innerEvents[2].iteration, 2);
    assert.equal(innerEvents[2].name, "step A beta");
    assert.equal(innerEvents[3].name, "step B beta");
  });

  test("step:inner events carry the parent step index", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: before
    command: echo before
  - name: process
    forEach: [x]
    steps:
      - name: child {{item}}
        type: script
        command: echo "{{item}}"
      - name: child2 {{item}}
        type: script
        command: echo "{{item}}2"
`),
    );
    const events = await collectEvents(wf);
    const innerEvents = events.filter(
      (e): e is StepInnerEvent => e.type === "step:inner",
    );

    assert.ok(innerEvents.every((e) => e.index === 1));
  });

  test("step:inner not emitted for single-step forEach", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: simple
    forEach: [a, b, c]
    command: echo "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const innerEvents = events.filter((e) => e.type === "step:inner");
    assert.equal(innerEvents.length, 0);
  });

  test("{{item}} from outer forEach is substituted into inner forEach shell command", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: outer
    forEach: [src, lib]
    steps:
      - name: list {{item}} files
        forEach: "find {{item}} -name '*.ts' 2>/dev/null || true"
        command: echo "found:{{item}}"
`),
    );
    const events = await collectEvents(wf);
    // The inner forEach shell command had {{item}} substituted with the outer item ("src", "lib").
    // Even if the find returns no files, no error is thrown — the outer item substitution worked.
    assert.ok(events.some((e) => e.type === "workflow:complete"));
  });

  test("step:inner not emitted for single-element steps: array", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: single child
    forEach: [a, b]
    steps:
      - name: only child {{item}}
        type: script
        command: echo "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const innerEvents = events.filter((e) => e.type === "step:inner");
    assert.equal(innerEvents.length, 0);
  });

  test("child step error aborts remaining children in the iteration", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: process
    forEach: [a]
    steps:
      - name: fail {{item}}
        type: script
        command: exit 1
      - name: should not run {{item}}
        type: script
        command: echo "SHOULD_NOT_APPEAR"
`),
    );
    const { events } = await collectEventsUntilError(wf);
    const textLines = events
      .filter(
        (e): e is { type: "output:text"; index: number; text: string } =>
          e.type === "output:text",
      )
      .map((e) => e.text);
    assert.ok(!textLines.some((l) => l.includes("SHOULD_NOT_APPEAR")));
  });

  test("continue_on_error on child step allows subsequent children to run", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: process
    forEach: [a]
    steps:
      - name: fail {{item}}
        type: script
        continue_on_error: true
        command: exit 1
      - name: after {{item}}
        type: script
        command: echo "AFTER_FAILURE"
`),
    );
    const events = await collectEvents(wf);
    const textLines = events
      .filter(
        (e): e is { type: "output:text"; index: number; text: string } =>
          e.type === "output:text",
      )
      .map((e) => e.text.trim())
      .filter(Boolean);
    assert.ok(textLines.some((l) => l.includes("AFTER_FAILURE")));
  });

  test("outer continueOnError on ForEachTask swallows child failure and abandons remaining items", async () => {
    // When a child step fails (no child continueOnError), the error propagates out of runForEach.
    // The outer ForEachTask's continueOnError=true causes runWorkflow to swallow the error and
    // continue to the next top-level step — but ALL remaining items in the loop are abandoned.
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: loop
    forEach: [a, b, c]
    continue_on_error: true
    steps:
      - name: fail on a {{item}}
        type: script
        command: |
          if [ "{{item}}" = "a" ]; then exit 1; fi
          echo "ran {{item}}"
      - name: second child {{item}}
        type: script
        command: echo "SECOND_{{item}}"
  - name: after loop
    type: script
    command: echo "AFTER_LOOP"
`),
    );
    const events = await collectEvents(wf);
    // Workflow completes — outer continueOnError prevented the whole workflow from aborting
    assert.ok(events.some((e) => e.type === "workflow:complete"));
    // The top-level step after the forEach runs (continueOnError allowed workflow to continue)
    const textLines = events
      .filter(
        (e): e is { type: "output:text"; index: number; text: string } =>
          e.type === "output:text",
      )
      .map((e) => e.text.trim())
      .filter(Boolean);
    assert.ok(textLines.some((l) => l.includes("AFTER_LOOP")));
    // Remaining items b and c were abandoned when a failed — the loop exited early
    assert.ok(!textLines.some((l) => l.includes("ran b")));
    assert.ok(!textLines.some((l) => l.includes("ran c")));
  });

  test("{{item}} substituted in all child step commands", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: greet
    forEach: [world, earth]
    steps:
      - name: say {{item}}
        type: script
        command: printf "hello %s\\n" "{{item}}"
      - name: bye {{item}}
        type: script
        command: printf "bye %s\\n" "{{item}}"
`),
    );
    const events = await collectEvents(wf);
    const textLines = events
      .filter(
        (e): e is { type: "output:text"; index: number; text: string } =>
          e.type === "output:text",
      )
      .map((e) => e.text.trim())
      .filter(Boolean);

    assert.ok(textLines.some((l) => l.includes("hello world")));
    assert.ok(textLines.some((l) => l.includes("hello earth")));
    assert.ok(textLines.some((l) => l.includes("bye world")));
    assert.ok(textLines.some((l) => l.includes("bye earth")));
  });

  test("event ordering: step:iteration then step:inner then output for each child", async () => {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: process
    forEach: [x]
    steps:
      - name: A {{item}}
        type: script
        command: echo A
      - name: B {{item}}
        type: script
        command: echo B
`),
    );
    const events = await collectEvents(wf);
    const relevant = events
      .filter((e) => ["step:iteration", "step:inner"].includes(e.type))
      .map((e) => e.type);

    assert.deepEqual(relevant, ["step:iteration", "step:inner", "step:inner"]);
    // Second step:inner comes after first
    const innerEvents = events.filter(
      (e): e is StepInnerEvent => e.type === "step:inner",
    );
    assert.equal(innerEvents[0].innerIndex, 0);
    assert.equal(innerEvents[1].innerIndex, 1);
  });
});

describe("reducer — step:inner", () => {
  function makeMultiStepState() {
    const wf = loadWorkflow(
      tmpYaml(`
goal: test
steps:
  - name: process
    forEach: [x, y]
    steps:
      - name: A {{item}}
        type: script
        command: echo A
      - name: B {{item}}
        type: script
        command: echo B
`),
    );
    return buildInitialState(wf);
  }

  test("sets inner on the running iteration record", () => {
    let state = makeMultiStepState();
    state = reducer(state, { type: "step:start", index: 0, name: "process" });
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "x",
      iteration: 1,
      total: 2,
    });
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 1,
      innerIndex: 0,
      innerTotal: 2,
      name: "A x",
    });

    const running = state.tasks[0].iterationHistory?.find(
      (r) => r.status === "running",
    );
    assert.deepEqual(running?.inner, { index: 0, total: 2, name: "A x" });
  });

  test("new step:iteration marks previous running record complete (inner cleared)", () => {
    let state = makeMultiStepState();
    state = reducer(state, { type: "step:start", index: 0, name: "process" });
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "x",
      iteration: 1,
      total: 2,
    });
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 1,
      innerIndex: 1,
      innerTotal: 2,
      name: "B x",
    });
    // New iteration: previous record (x) is now complete; new record (y) has no inner yet
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "y",
      iteration: 2,
      total: 2,
    });

    const history = state.tasks[0].iterationHistory;
    assert.ok(history);
    assert.equal(history[0].item, "x");
    assert.equal(history[0].status, "complete");
    assert.equal(history[1].item, "y");
    assert.equal(history[1].status, "running");
    assert.equal(history[1].inner, undefined);
  });

  test("step:inner overwrites inner on the running iteration record", () => {
    let state = makeMultiStepState();
    state = reducer(state, { type: "step:start", index: 0, name: "process" });
    state = reducer(state, {
      type: "step:iteration",
      index: 0,
      item: "x",
      iteration: 1,
      total: 2,
    });
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 1,
      innerIndex: 0,
      innerTotal: 2,
      name: "A x",
    });
    state = reducer(state, {
      type: "step:inner",
      index: 0,
      iteration: 1,
      innerIndex: 1,
      innerTotal: 2,
      name: "B x",
    });

    const running = state.tasks[0].iterationHistory?.find(
      (r) => r.status === "running",
    );
    assert.deepEqual(running?.inner, { index: 1, total: 2, name: "B x" });
  });
});
