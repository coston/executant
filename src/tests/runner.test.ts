// ============================================================================
// RUNNER — runWorkflow options
// ============================================================================
// Tests for RunOptions: stepFilter by name, stepFilter by index, fromStep.
// Uses real Workflow objects with script steps to avoid Claude API calls.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Event, StepSkipEvent, StepStartEvent, Workflow } from '../types.js';
import { collectEvents, collectEventsUntilError, tmpYaml } from './helpers.js';
import { loadWorkflow } from '../load-workflow.js';
import { runWorkflow, shouldSkipStep } from '../runner.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function stepNames(events: Event[]): string[] {
  return events
    .filter((e): e is StepStartEvent => e.type === 'step:start')
    .map((e) => e.name);
}

function skippedNames(events: Event[]): string[] {
  return events
    .filter((e): e is StepSkipEvent => e.type === 'step:skip')
    .map((e) => e.name);
}

function makeWorkflow(steps: Array<{ name: string; command: string }>): Workflow {
  const yaml = `
goal: test
steps:
${steps.map((s) => `  - name: ${s.name}\n    command: ${s.command}`).join('\n')}
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

describe('shouldSkipStep', () => {
  test('returns false when no options are set', () => {
    assert.equal(shouldSkipStep(1, 'any', {}), false);
  });

  test('stepFilter: skips a step whose name does not match', () => {
    assert.equal(shouldSkipStep(2, 'build', { stepFilter: 'test' }), true);
  });

  test('stepFilter: does not skip a step whose name matches', () => {
    assert.equal(shouldSkipStep(2, 'test', { stepFilter: 'test' }), false);
  });

  test('stepFilter: matches by 1-based index string', () => {
    assert.equal(shouldSkipStep(3, 'build', { stepFilter: '3' }), false);
  });

  test('stepFilter: skips when index does not match and name does not match', () => {
    assert.equal(shouldSkipStep(2, 'build', { stepFilter: '3' }), true);
  });

  test('stepFilter: numeric string "0" never matches (1-based)', () => {
    assert.equal(shouldSkipStep(1, 'first', { stepFilter: '0' }), true);
  });

  test('fromStep: skips steps before the threshold', () => {
    assert.equal(shouldSkipStep(2, 'step', { fromStep: 3 }), true);
  });

  test('fromStep: does not skip the threshold step itself', () => {
    assert.equal(shouldSkipStep(3, 'step', { fromStep: 3 }), false);
  });

  test('fromStep: does not skip steps after the threshold', () => {
    assert.equal(shouldSkipStep(4, 'step', { fromStep: 3 }), false);
  });
});

// ----------------------------------------------------------------------------
// stepFilter — by name
// ----------------------------------------------------------------------------

describe('runWorkflow — stepFilter by name', () => {
  test('runs only the named step', async () => {
    const wf = makeWorkflow([
      { name: 'first', command: 'echo first' },
      { name: 'second', command: 'echo second' },
      { name: 'third', command: 'echo third' },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: 'second' });
    assert.deepEqual(stepNames(events), ['second']);
  });

  test('skips non-matching steps', async () => {
    const wf = makeWorkflow([
      { name: 'first', command: 'echo first' },
      { name: 'second', command: 'echo second' },
      { name: 'third', command: 'echo third' },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: 'second' });
    assert.deepEqual(skippedNames(events), ['first', 'third']);
  });

  test('no steps run when name does not match any step', async () => {
    const wf = makeWorkflow([
      { name: 'alpha', command: 'echo a' },
      { name: 'beta', command: 'echo b' },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: 'nonexistent' });
    assert.deepEqual(stepNames(events), []);
    assert.deepEqual(skippedNames(events), ['alpha', 'beta']);
  });
});

// ----------------------------------------------------------------------------
// stepFilter — by 1-based index
// ----------------------------------------------------------------------------

describe('runWorkflow — stepFilter by index', () => {
  test('runs only the step at the given 1-based index', async () => {
    const wf = makeWorkflow([
      { name: 'first', command: 'echo first' },
      { name: 'second', command: 'echo second' },
      { name: 'third', command: 'echo third' },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: '2' });
    assert.deepEqual(stepNames(events), ['second']);
    assert.deepEqual(skippedNames(events), ['first', 'third']);
  });

  test('index 1 runs the first step', async () => {
    const wf = makeWorkflow([
      { name: 'first', command: 'echo first' },
      { name: 'second', command: 'echo second' },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: '1' });
    assert.deepEqual(stepNames(events), ['first']);
  });

  test('index matching last step runs only that step', async () => {
    const wf = makeWorkflow([
      { name: 'a', command: 'echo a' },
      { name: 'b', command: 'echo b' },
      { name: 'c', command: 'echo c' },
    ]);
    const events = await collectWithOptions(wf, { stepFilter: '3' });
    assert.deepEqual(stepNames(events), ['c']);
  });
});

// ----------------------------------------------------------------------------
// fromStep
// ----------------------------------------------------------------------------

describe('runWorkflow — fromStep', () => {
  test('skips steps before fromStep', async () => {
    const wf = makeWorkflow([
      { name: 'first', command: 'echo first' },
      { name: 'second', command: 'echo second' },
      { name: 'third', command: 'echo third' },
    ]);
    const events = await collectWithOptions(wf, { fromStep: 2 });
    assert.deepEqual(stepNames(events), ['second', 'third']);
    assert.deepEqual(skippedNames(events), ['first']);
  });

  test('fromStep: 1 runs all steps', async () => {
    const wf = makeWorkflow([
      { name: 'a', command: 'echo a' },
      { name: 'b', command: 'echo b' },
    ]);
    const events = await collectWithOptions(wf, { fromStep: 1 });
    assert.deepEqual(stepNames(events), ['a', 'b']);
  });

  test('fromStep beyond last step skips everything', async () => {
    const wf = makeWorkflow([
      { name: 'only', command: 'echo hi' },
    ]);
    const events = await collectWithOptions(wf, { fromStep: 99 });
    assert.deepEqual(stepNames(events), []);
    assert.deepEqual(skippedNames(events), ['only']);
  });
});

// ----------------------------------------------------------------------------
// continueOnError
// ----------------------------------------------------------------------------

describe('runWorkflow — continueOnError', () => {
  test('workflow aborts on step failure by default', async () => {
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
    assert.ok(error, 'expected an error');
    assert.ok(
      events.every((e) => e.type !== 'step:start' || (e as StepStartEvent).name !== 'unreachable'),
      'unreachable step should not have started',
    );
  });

  test('continueOnError allows workflow to continue past a failed step', async () => {
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
    assert.deepEqual(stepNames(events), ['failing', 'after']);
  });
});

// ----------------------------------------------------------------------------
// log steps
// ----------------------------------------------------------------------------

describe('runWorkflow — log steps', () => {
  test('log step emits output:text with the message', async () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: marker
    type: log
    message: "Hello from log step"
`);
    const wf = loadWorkflow(file);
    const events = await collectEvents(wf);
    const textEvents = events.filter((e) => e.type === 'output:text');
    assert.ok(
      textEvents.some((e) => (e as { text: string }).text === 'Hello from log step'),
      'expected log message in output:text events',
    );
  });
});
