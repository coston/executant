// ============================================================================
// FOREACH FEATURE TESTS
// ============================================================================
// Tests for forEach step support: load-workflow parsing, runner event stream,
// and reducer state updates.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorkflow } from '../load-workflow.js';
import { reducer, buildInitialState } from '../ui/reducer.js';
import type { ForEachTask, StepIterationEvent } from '../types.js';
import { tmpYaml, collectEvents } from './helpers.js';

// ----------------------------------------------------------------------------
// load-workflow: YAML → ForEachTask
// ----------------------------------------------------------------------------

describe('loadWorkflow — forEach', () => {
  test('parses inline list into ForEachTask', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: greet
    forEach: [alpha, beta, gamma]
    command: echo "{{item}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, 'forEach');
    assert.equal(task.name, 'greet');
    assert.deepEqual(task.forEach, ['alpha', 'beta', 'gamma']);
    assert.equal(task.inner.type, 'command');
    assert.equal(task.inner.name, 'greet');
    // {{item}} must survive vars substitution so runner can substitute it
    assert.equal((task.inner as { command: string }).command, 'echo "{{item}}"');
  });

  test('parses shell command string into ForEachTask', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: list
    forEach: "printf '%s\\n' x y z"
    command: echo "{{item}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, 'forEach');
    assert.equal(typeof task.forEach, 'string');
  });

  test('vars substitution applies to inner task but NOT to {{item}}', () => {
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
    assert.equal((task.inner as { command: string }).command, 'echo "{{item}}.ts"');
  });

  test('forEach step with prompt creates claude inner task', () => {
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

    assert.equal(task.inner.type, 'claude');
    assert.equal((task.inner as { prompt: string }).prompt.trim(), 'Review {{item}} for issues.');
  });

  test('continueOnError propagates to ForEachTask', () => {
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

describe('runWorkflow — forEach events', () => {
  test('yields step:iteration events with correct metadata', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: echo item
    forEach: [alpha, beta, gamma]
    command: echo "{{item}}"
`));
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === 'step:iteration',
    );

    assert.equal(iterations.length, 3);
    assert.deepEqual(iterations.map((e) => e.item), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(iterations.map((e) => e.iteration), [1, 2, 3]);
    assert.deepEqual(iterations.map((e) => e.total), [3, 3, 3]);
  });

  test('step:iteration events carry the parent step index', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: first
    command: echo "before"
  - name: loop
    forEach: [x, y]
    command: echo "{{item}}"
`));
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === 'step:iteration',
    );

    // "loop" is step index 1 (0-based)
    assert.ok(iterations.every((e) => e.index === 1));
  });

  test('{{item}} is substituted in the executed command', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: greet
    forEach: [world, executant]
    command: printf "hello %s\\n" "{{item}}"
`));
    const events = await collectEvents(wf);
    const textLines = events
      .filter((e): e is { type: 'output:text'; index: number; text: string } => e.type === 'output:text')
      .map((e) => e.text.trim())
      .filter(Boolean);

    assert.ok(textLines.some((l) => l.includes('hello world')));
    assert.ok(textLines.some((l) => l.includes('hello executant')));
  });

  test('shell command forEach resolves items from command output', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: list
    forEach: "printf '%s\\n' foo bar baz"
    command: printf "got:%s\\n" "{{item}}"
`));
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === 'step:iteration',
    );

    assert.equal(iterations.length, 3);
    assert.deepEqual(iterations.map((e) => e.item), ['foo', 'bar', 'baz']);
  });

  test('workflow completes with step:complete after all iterations', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: run
    forEach: [a, b]
    command: echo "{{item}}"
`));
    const events = await collectEvents(wf);
    const types = events.map((e) => e.type);

    assert.ok(types.includes('step:start'));
    assert.ok(types.includes('step:iteration'));
    assert.ok(types.includes('step:complete'));
    assert.ok(types.includes('workflow:complete'));

    // step:complete must come after all step:iteration events
    const completeIdx = types.lastIndexOf('step:complete');
    const lastIterIdx = types.lastIndexOf('step:iteration');
    assert.ok(completeIdx > lastIterIdx);
  });

  test('empty inline list produces no iterations and completes normally', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: nothing
    forEach: []
    command: echo "{{item}}"
`));
    const events = await collectEvents(wf);
    const iterations = events.filter((e) => e.type === 'step:iteration');
    assert.equal(iterations.length, 0);
    assert.ok(events.some((e) => e.type === 'step:complete'));
  });

  test('shell command with no output produces no iterations', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: empty
    forEach: "printf ''"
    command: echo "{{item}}"
`));
    const events = await collectEvents(wf);
    const iterations = events.filter((e) => e.type === 'step:iteration');
    assert.equal(iterations.length, 0);
    assert.ok(events.some((e) => e.type === 'step:complete'));
  });

  test('shell command failure throws with helpful message', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: bad
    forEach: "exit 1"
    command: echo "{{item}}"
`));
    await assert.rejects(
      () => collectEvents(wf),
      (err: Error) => {
        assert.ok(err.message.includes('forEach shell command failed'));
        assert.ok(err.message.includes('exit 1'));
        return true;
      },
    );
  });

  test('shell command using pipes works correctly', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: piped
    forEach: "printf '%s\\n' one two three | grep -v two"
    command: echo "item:{{item}}"
`));
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === 'step:iteration',
    );
    assert.equal(iterations.length, 2);
    assert.deepEqual(iterations.map((e) => e.item), ['one', 'three']);
  });
});

// ----------------------------------------------------------------------------
// reducer: step:iteration → TaskState.iteration
// ----------------------------------------------------------------------------

describe('reducer — step:iteration', () => {
  function makeState() {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: loop
    forEach: [x, y, z]
    command: echo "{{item}}"
`));
    return buildInitialState(wf);
  }

  test('sets iteration on the correct task', () => {
    const state = makeState();

    // Simulate step starting first
    const started = reducer(state, { type: 'step:start', index: 0, name: 'loop' });
    const updated = reducer(started, {
      type: 'step:iteration',
      index: 0,
      item: 'x',
      iteration: 1,
      total: 3,
    });

    assert.deepEqual(updated.tasks[0].iteration, { current: 1, total: 3, item: 'x' });
  });

  test('overwrites iteration on subsequent events', () => {
    let state = makeState();
    state = reducer(state, { type: 'step:start', index: 0, name: 'loop' });
    state = reducer(state, {
      type: 'step:iteration', index: 0, item: 'x', iteration: 1, total: 3,
    });
    state = reducer(state, {
      type: 'step:iteration', index: 0, item: 'y', iteration: 2, total: 3,
    });

    assert.deepEqual(state.tasks[0].iteration, { current: 2, total: 3, item: 'y' });
  });

  test('does not affect other tasks', () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: first
    command: echo "a"
  - name: loop
    forEach: [x, y]
    command: echo "{{item}}"
`));
    let state = buildInitialState(wf);
    state = reducer(state, { type: 'step:start', index: 1, name: 'loop' });
    state = reducer(state, {
      type: 'step:iteration', index: 1, item: 'x', iteration: 1, total: 2,
    });

    assert.equal(state.tasks[0].iteration, undefined);
    assert.ok(state.tasks[1].iteration !== undefined);
  });
});

// ----------------------------------------------------------------------------
// repeat field: load-workflow and runner
// ----------------------------------------------------------------------------

describe('repeat field — loadWorkflow', () => {
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

    assert.equal(task.type, 'forEach');
    assert.deepEqual(task.forEach, ['1', '2', '3']);
    assert.equal(task.inner.type, 'command');
    assert.equal((task.inner as { command: string }).command, 'echo "{{item}}"');
  });

  test('repeat: 1 produces a ForEachTask with a single-element array', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: once
    repeat: 1
    command: echo "{{item}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ForEachTask;

    assert.equal(task.type, 'forEach');
    assert.deepEqual(task.forEach, ['1']);
  });

  test('repeat with prompt step creates claude inner task', () => {
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

    assert.equal(task.inner.type, 'claude');
    assert.ok((task.inner as { prompt: string }).prompt.includes('{{item}}'));
  });

  test('repeat and forEach on the same step throws a validation error', () => {
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
        assert.ok(err.message.includes('cannot have both repeat and forEach'));
        return true;
      },
    );
  });

  test('repeat: 0 fails Zod validation (must be positive)', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: zero
    repeat: 0
    command: echo "{{item}}"
`);
    assert.throws(() => loadWorkflow(file));
  });

  test('repeat with negative number fails Zod validation', () => {
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

describe('repeat field — runner events', () => {
  test('emits correct step:iteration events with numeric items', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: count
    repeat: 3
    command: echo "{{item}}"
`));
    const events = await collectEvents(wf);
    const iterations = events.filter(
      (e): e is StepIterationEvent => e.type === 'step:iteration',
    );

    assert.equal(iterations.length, 3);
    assert.deepEqual(iterations.map((e) => e.item), ['1', '2', '3']);
    assert.deepEqual(iterations.map((e) => e.iteration), [1, 2, 3]);
    assert.deepEqual(iterations.map((e) => e.total), [3, 3, 3]);
  });

  test('{{item}} substitution produces iteration numbers in command output', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: stamp
    repeat: 3
    command: printf "pass:%s\\n" "{{item}}"
`));
    const events = await collectEvents(wf);
    const textLines = events
      .filter((e): e is { type: 'output:text'; index: number; text: string } => e.type === 'output:text')
      .map((e) => e.text.trim())
      .filter(Boolean);

    assert.ok(textLines.some((l) => l.includes('pass:1')));
    assert.ok(textLines.some((l) => l.includes('pass:2')));
    assert.ok(textLines.some((l) => l.includes('pass:3')));
  });
});
