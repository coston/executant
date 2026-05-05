// ============================================================================
// planReducer — unit tests
// ============================================================================
// Tests the pure reducer and initial state builder exported from PlanApp.tsx.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planReducer, buildInitial } from '../ui/PlanApp.js';
import type { PlanEvent } from '../ui/PlanApp.js';

function initial(description = 'test task') {
  return buildInitial(description);
}

// ----------------------------------------------------------------------------
// buildInitial
// ----------------------------------------------------------------------------

describe('buildInitial', () => {
  test('sets description', () => {
    const s = initial('add feature');
    assert.equal(s.description, 'add feature');
  });

  test('starts with empty lines', () => {
    assert.deepEqual(initial().lines, []);
  });

  test('status is running', () => {
    assert.equal(initial().status, 'running');
  });

  test('attempt starts at 1', () => {
    assert.equal(initial().attempt, 1);
  });

  test('stage starts at 0', () => {
    assert.equal(initial().stage, 0);
  });

  test('stageName starts empty', () => {
    assert.equal(initial().stageName, '');
  });

  test('stageNames starts empty', () => {
    assert.deepEqual(initial().stageNames, []);
  });

  test('startTime is set', () => {
    const before = Date.now();
    const s = initial();
    assert.ok(s.startTime >= before);
  });
});

// ----------------------------------------------------------------------------
// plan:start
// ----------------------------------------------------------------------------

describe('planReducer — plan:start', () => {
  test('updates description', () => {
    const s = planReducer(initial('old'), { type: 'plan:start', description: 'new desc' });
    assert.equal(s.description, 'new desc');
  });

  test('resets startTime', () => {
    const before = buildInitial('x');
    const s = planReducer({ ...before, startTime: 0 }, { type: 'plan:start', description: 'x' });
    assert.ok(s.startTime > 0);
  });
});

// ----------------------------------------------------------------------------
// plan:stages
// ----------------------------------------------------------------------------

describe('planReducer — plan:stages', () => {
  test('pre-populates stageNames and totalStages', () => {
    const names = ['Research & Planning', 'Decompose to Steps', 'Validate'];
    const s = planReducer(initial(), { type: 'plan:stages', names });
    assert.deepEqual(s.stageNames, names);
    assert.equal(s.totalStages, 3);
  });
});

// ----------------------------------------------------------------------------
// plan:stage
// ----------------------------------------------------------------------------

describe('planReducer — plan:stage', () => {
  test('sets stage and stageName', () => {
    const s = planReducer(initial(), { type: 'plan:stage', stage: 1, total: 3, name: 'Research & Planning' });
    assert.equal(s.stage, 1);
    assert.equal(s.stageName, 'Research & Planning');
  });

  test('sets status to running', () => {
    const retrying = { ...initial(), status: 'retrying' as const };
    const s = planReducer(retrying, { type: 'plan:stage', stage: 2, total: 3, name: 'Decompose to Steps' });
    assert.equal(s.status, 'running');
  });

  test('appends [N/3] Name line to lines', () => {
    const s = planReducer(initial(), { type: 'plan:stage', stage: 2, total: 3, name: 'Decompose to Steps' });
    assert.equal(s.lines.at(-1), '[2/3] Decompose to Steps');
  });

  test('re-entry after judge rejection overwrites stage/name and appends new line', () => {
    let s = planReducer(initial(), { type: 'plan:stage', stage: 3, total: 3, name: 'Validate' });
    s = planReducer(s, { type: 'plan:stage', stage: 2, total: 3, name: 'Decompose to Steps' });
    assert.equal(s.stage, 2);
    assert.equal(s.stageName, 'Decompose to Steps');
    assert.equal(s.lines.at(-1), '[2/3] Decompose to Steps');
    assert.equal(s.lines.length, 2);
  });
});

// ----------------------------------------------------------------------------
// plan:tool
// ----------------------------------------------------------------------------

describe('planReducer — plan:tool', () => {
  test('appends formatted line for a known tool (Read)', () => {
    const s = planReducer(initial(), {
      type: 'plan:tool',
      tool: 'Read',
      input: { file_path: '/src/foo.ts' },
    });
    assert.equal(s.lines.length, 1);
    assert.ok(s.lines[0]!.includes('foo.ts'), `Expected line to include file name, got: "${s.lines[0]}"`);
  });

  test('does not append a line for an unknown/suppressed tool', () => {
    // formatToolCall returns null for unrecognised tools
    const s = planReducer(initial(), {
      type: 'plan:tool',
      tool: 'UnknownTool',
      input: {},
    });
    assert.equal(s.lines.length, 0);
  });
});

// ----------------------------------------------------------------------------
// plan:text
// ----------------------------------------------------------------------------

describe('planReducer — plan:text', () => {
  test('does not change state (text collected separately for JSON parsing)', () => {
    const before = initial();
    const after = planReducer(before, { type: 'plan:text', text: 'some output' });
    assert.deepEqual(after, before);
  });
});

// ----------------------------------------------------------------------------
// plan:retry
// ----------------------------------------------------------------------------

describe('planReducer — plan:retry', () => {
  test('sets status to retrying', () => {
    const s = planReducer(initial(), { type: 'plan:retry', attempt: 2, maxAttempts: 3, reason: 'no output' });
    assert.equal(s.status, 'retrying');
  });

  test('updates attempt and maxAttempts', () => {
    const s = planReducer(initial(), { type: 'plan:retry', attempt: 2, maxAttempts: 3, reason: 'x' });
    assert.equal(s.attempt, 2);
    assert.equal(s.maxAttempts, 3);
  });

  test('appends retry line to lines', () => {
    const s = planReducer(initial(), { type: 'plan:retry', attempt: 2, maxAttempts: 3, reason: 'schema error' });
    assert.ok(s.lines.at(-1)!.includes('2/3'), `Expected retry line, got: "${s.lines.at(-1)}"`);
  });
});

// ----------------------------------------------------------------------------
// plan:complete
// ----------------------------------------------------------------------------

describe('planReducer — plan:complete', () => {
  test('sets status to complete', () => {
    const s = planReducer(initial(), { type: 'plan:complete', taskFile: '/tmp/task.yaml', preview: 'goal: x' });
    assert.equal(s.status, 'complete');
  });

  test('stores taskFile', () => {
    const s = planReducer(initial(), { type: 'plan:complete', taskFile: '/tmp/task.yaml', preview: '' });
    assert.equal(s.taskFile, '/tmp/task.yaml');
  });

  test('stores preview', () => {
    const s = planReducer(initial(), { type: 'plan:complete', taskFile: '/tmp/t.yaml', preview: 'goal: test' });
    assert.equal(s.preview, 'goal: test');
  });
});

// ----------------------------------------------------------------------------
// plan:error
// ----------------------------------------------------------------------------

describe('planReducer — plan:error', () => {
  test('sets status to error', () => {
    const s = planReducer(initial(), { type: 'plan:error', message: 'something went wrong' });
    assert.equal(s.status, 'error');
  });

  test('stores errorMessage', () => {
    const s = planReducer(initial(), { type: 'plan:error', message: 'claude failed' });
    assert.equal(s.errorMessage, 'claude failed');
  });
});

// ----------------------------------------------------------------------------
// plan:warn
// ----------------------------------------------------------------------------

describe('planReducer — plan:warn', () => {
  test('appends [warn] line to lines', () => {
    const s = planReducer(initial(), { type: 'plan:warn', message: 'judge skipped' });
    assert.equal(s.lines.at(-1), '[warn] judge skipped');
  });

  test('does not change status', () => {
    const s = planReducer(initial(), { type: 'plan:warn', message: 'something' });
    assert.equal(s.status, 'running');
  });
});

// ----------------------------------------------------------------------------
// lines cap
// ----------------------------------------------------------------------------

describe('planReducer — lines accumulate without limit', () => {
  test('accumulates all lines without truncation', () => {
    let s = initial();
    for (let i = 1; i <= 201; i++) {
      const event: PlanEvent = { type: 'plan:stage', stage: (i % 3) + 1, total: 3, name: `Stage ${i}` };
      s = planReducer(s, event);
    }
    assert.equal(s.lines.length, 201);
    assert.ok(s.lines.at(-1)!.includes('Stage 201'));
  });
});
