// ============================================================================
// SELF-HEALING FEATURE TESTS
// ============================================================================
// Tests for multi-pass self-healing on command steps: load-workflow parsing,
// default-on behavior, runner retry loop, and event emission.
//
// Tests that trigger Claude use a mock claude binary in a temp dir prepended
// to PATH — the mock exits immediately with a success response.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWorkflow } from '../load-workflow.js';
import type { CommandTask, Event, LogEvent, Workflow } from '../types.js';
import { tmpYaml, collectEvents, collectEventsUntilError, installMockClaude } from './helpers.js';

function logEvents(events: Event[]): LogEvent[] {
  return events.filter((e): e is LogEvent => e.type === 'log');
}

// ----------------------------------------------------------------------------
// load-workflow: self_healing field parsing
// ----------------------------------------------------------------------------

describe('loadWorkflow — self_healing', () => {
  test('self_healing defaults to false for script steps (opt-in)', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: run_tests
    type: script
    command: npm test
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.type, 'command');
    assert.equal(task.selfHealing, false);
  });

  test('self_healing: false is explicit opt-out (same as default)', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: hard_gate
    type: script
    command: npm test
    self_healing: false
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.selfHealing, false);
  });

  test('self_healing: true opts in explicitly', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: run_tests
    type: script
    command: npm test
    self_healing: true
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.selfHealing, true);
  });

  test('parses max_healing_attempts', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: run_tests
    type: script
    command: npm test
    self_healing: true
    max_healing_attempts: 3
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.selfHealing, true);
    assert.equal(task.maxHealingAttempts, 3);
  });

  test('maxHealingAttempts defaults to undefined (runner uses 5)', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: run_tests
    type: script
    command: echo ok
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.maxHealingAttempts, undefined);
  });

  test('self_healing works with continue_on_error', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: run_tests
    type: script
    command: npm test
    self_healing: true
    continue_on_error: true
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.selfHealing, true);
    assert.equal(task.continueOnError, true);
  });

  test('self_healing in forEach inner task defaults to false (opt-in)', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: test_{{item}}
    forEach: [unit, integration]
    type: script
    command: npm test -- --suite={{item}}
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, 'forEach');
    const inner = (wf.tasks[0] as { inner: CommandTask }).inner;
    assert.equal(inner.selfHealing, false);
  });

  test('prompt steps are not affected by self_healing default', () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: analyze
    prompt: Do something.
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, 'claude');
    // Prompt steps don't have selfHealing
    assert.equal((wf.tasks[0] as unknown as Record<string, unknown>)['selfHealing'], undefined);
  });
});

// ----------------------------------------------------------------------------
// runner: self-healing with passing commands
// ----------------------------------------------------------------------------

describe('runWorkflow — self-healing (passing commands)', () => {
  test('command that succeeds on first try does not trigger healing', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: passing
    type: script
    command: echo "all good"
`));
    const events = await collectEvents(wf);
    const logs = logEvents(events);

    assert.ok(!logs.some((e) => e.text.includes('[self-healing]')));
    assert.ok(events.some((e) => e.type === 'step:complete'));
    assert.ok(events.some((e) => e.type === 'workflow:complete'));
  });

  test('self_healing: false fails immediately on error', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: failing
    type: script
    command: exit 1
    self_healing: false
`));
    await assert.rejects(
      () => collectEvents(wf),
      (err: Error) => {
        assert.ok(err.message.includes('failing'));
        return true;
      },
    );
  });
});

// ----------------------------------------------------------------------------
// runner: self-healing retry loop with mock claude
// ----------------------------------------------------------------------------

describe('runWorkflow — self-healing retry loop', () => {
  let originalPath: string;

  beforeEach(() => {
    const mock = installMockClaude();
    originalPath = mock.originalPath;
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
  });

  test('invokes Claude on failure and retries', async () => {
    const wf: Workflow = {
      goal: 'test',
      tasks: [
        {
          type: 'command',
          name: 'always_fails',
          command: 'exit 1',
          selfHealing: true,
          maxHealingAttempts: 2,
          continueOnError: true,
        },
      ],
    };

    const { events } = await collectEventsUntilError(wf);
    const logs = logEvents(events);

    assert.ok(
      logs.some((e) => e.text.includes('[self-healing]') && e.text.includes('Attempt 1/2')),
      `Expected attempt 1/2 log. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
    assert.ok(
      logs.some((e) => e.text.includes('Exhausted 2 attempts')),
      `Expected exhaustion log. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
  });

  test('succeeds when command passes on second attempt', async () => {
    const dir = join(tmpdir(), `executant-heal-counter-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const counterFile = join(dir, 'counter');
    writeFileSync(counterFile, '0', 'utf8');

    const cmd = `count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; test "$count" -gt 0`;

    const wf: Workflow = {
      goal: 'test',
      tasks: [
        {
          type: 'command',
          name: 'flaky_test',
          command: cmd,
          selfHealing: true,
          maxHealingAttempts: 3,
        },
      ],
    };

    const events = await collectEvents(wf);
    const logs = logEvents(events);

    assert.ok(
      logs.some((e) => e.text.includes('[self-healing]') && e.text.includes('Attempt 1/3')),
      `Expected attempt log. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
    assert.ok(
      logs.some((e) => e.text.includes('Command passed after 2 attempts')),
      `Expected success log. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
    assert.ok(events.some((e) => e.type === 'workflow:complete'));
  });

  test('respects maxHealingAttempts', async () => {
    const wf: Workflow = {
      goal: 'test',
      tasks: [
        {
          type: 'command',
          name: 'always_fails',
          command: 'exit 1',
          selfHealing: true,
          maxHealingAttempts: 3,
        },
      ],
    };

    const { events, error } = await collectEventsUntilError(wf);

    assert.ok(error, 'Expected an error after exhausting attempts');
    assert.ok(error!.message.includes('3 self-healing attempts'));

    const logs = logEvents(events);
    assert.ok(logs.some((e) => e.text.includes('Attempt 1/3')));
    assert.ok(logs.some((e) => e.text.includes('Attempt 2/3')));
    assert.ok(logs.some((e) => e.text.includes('Exhausted 3 attempts')));
  });

  test('continue_on_error lets workflow continue after exhaustion', async () => {
    const wf: Workflow = {
      goal: 'test',
      tasks: [
        {
          type: 'command',
          name: 'will_exhaust',
          command: 'exit 1',
          selfHealing: true,
          maxHealingAttempts: 1,
          continueOnError: true,
        },
        {
          type: 'command',
          name: 'after_heal',
          command: 'echo "still running"',
          selfHealing: false,
        },
      ],
    };

    const { events } = await collectEventsUntilError(wf);
    const logs = logEvents(events);

    assert.ok(
      logs.some((e) => e.text.includes('Exhausted')),
      `Expected exhaustion. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
    assert.ok(
      events.some((e) => e.type === 'step:error' && 'name' in e && e.name === 'will_exhaust'),
      'Expected step:error for will_exhaust',
    );
    assert.ok(events.some((e) => e.type === 'workflow:complete'));
  });

  test('maxHealingAttempts: 1 exhausts immediately', async () => {
    const wf: Workflow = {
      goal: 'test',
      tasks: [
        {
          type: 'command',
          name: 'one_shot',
          command: 'exit 1',
          selfHealing: true,
          maxHealingAttempts: 1,
          continueOnError: true,
        },
      ],
    };

    const { events } = await collectEventsUntilError(wf);
    const logs = logEvents(events);

    assert.ok(
      logs.some((e) => e.text.includes('Exhausted 1 attempts')),
      `Expected exhaustion. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
  });

  test('logs include the exit code', async () => {
    const wf: Workflow = {
      goal: 'test',
      tasks: [
        {
          type: 'command',
          name: 'exit42',
          command: 'exit 42',
          selfHealing: true,
          maxHealingAttempts: 2,
          continueOnError: true,
        },
      ],
    };

    const { events } = await collectEventsUntilError(wf);
    const logs = logEvents(events);

    assert.ok(
      logs.some((e) => e.text.includes('exit 42')),
      `Expected exit code 42 in logs. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
  });

  test('default maxAttempts is 5 when not specified', async () => {
    const wf: Workflow = {
      goal: 'test',
      tasks: [
        {
          type: 'command',
          name: 'default_max',
          command: 'exit 1',
          selfHealing: true,
        },
      ],
    };

    const { error } = await collectEventsUntilError(wf);
    assert.ok(error);
    assert.ok(
      error!.message.includes('5 self-healing attempts'),
      `Expected default 5 attempts in error. Got: ${error!.message}`,
    );
  });
});

// ----------------------------------------------------------------------------
// Fix summary: tool calls vs. text fallback
// ----------------------------------------------------------------------------

describe('self-healing fix summary in attempt history', () => {
  let originalPath: string;
  let promptLogFile: string;

  beforeEach(() => {
    const dir = join(tmpdir(), `executant-heal-fix-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    promptLogFile = join(dir, 'prompts.log');

    // Mock that:
    //   - on every invocation: writes its --print argument to promptLogFile
    //   - emits a tool_use block so the fix summary uses the tool call
    const mockScript = join(dir, 'claude');
    writeFileSync(mockScript, `#!/usr/bin/env bash
# $2 is the prompt (arg after --print)
printf '%s\\n---END---\\n' "$2" >> "${promptLogFile}"
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/target.ts"}}]}}\\n'
printf '{"type":"result","total_cost_usd":0.001}\\n'
exit 0
`, 'utf8');
    chmodSync(mockScript, 0o755);

    originalPath = process.env['PATH'] ?? '';
    process.env['PATH'] = `${dir}:${originalPath}`;
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
  });

  test('records tool calls as fix summary in subsequent attempt prompt', async () => {
    const dir = join(tmpdir(), `executant-heal-counter-fix-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const counterFile = join(dir, 'counter');
    writeFileSync(counterFile, '0', 'utf8');
    // Fail on attempts 0 and 1 (count < 2), pass on attempt 2
    const cmd = `count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; test "$count" -gt 1`;

    const wf: Workflow = {
      goal: 'test',
      tasks: [{ type: 'command', name: 'flaky', command: cmd, selfHealing: true, maxHealingAttempts: 4 }],
    };

    await collectEvents(wf);

    // The second Claude invocation (attempt 2's heal prompt) should contain the
    // tool call from attempt 1's Claude output as the "Fix applied" summary.
    const log = readFileSync(promptLogFile, 'utf8');
    const prompts = log.split('---END---\n').filter(Boolean);
    // prompts[0] = first heal prompt (no history), prompts[1] = second heal prompt (with history)
    assert.ok(prompts.length >= 2, `Expected at least 2 Claude invocations, got ${prompts.length}`);
    const secondPrompt = prompts[1];
    assert.ok(
      secondPrompt.includes('Fix applied: Edit(src/target.ts)'),
      `Expected tool-call fix summary. Prompt:\n${secondPrompt.slice(0, 500)}`,
    );
  });

  test('falls back to Claude text when no tools are called', async () => {
    const dir = join(tmpdir(), `executant-heal-counter-txt-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const counterFile = join(dir, 'counter');
    writeFileSync(counterFile, '0', 'utf8');

    // Install a text-only mock (no tool_use blocks)
    const mockDir = join(tmpdir(), `executant-text-mock-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    const textPromptLog = join(mockDir, 'prompts.log');
    const mockScript = join(mockDir, 'claude');
    writeFileSync(mockScript, `#!/usr/bin/env bash
printf '%s\\n---END---\\n' "$2" >> "${textPromptLog}"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"Diagnosed missing dependency"}]}}\\n'
printf '{"type":"result","total_cost_usd":0.001}\\n'
exit 0
`, 'utf8');
    chmodSync(mockScript, 0o755);
    process.env['PATH'] = `${mockDir}:${originalPath}`;

    const cmd = `count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; test "$count" -gt 1`;
    const wf: Workflow = {
      goal: 'test',
      tasks: [{ type: 'command', name: 'flaky2', command: cmd, selfHealing: true, maxHealingAttempts: 4 }],
    };

    await collectEvents(wf);

    const log = readFileSync(textPromptLog, 'utf8');
    const prompts = log.split('---END---\n').filter(Boolean);
    assert.ok(prompts.length >= 2, `Expected at least 2 Claude invocations, got ${prompts.length}`);
    const secondPrompt = prompts[1];
    assert.ok(
      secondPrompt.includes('Fix applied: Diagnosed missing dependency'),
      `Expected text fix summary. Prompt:\n${secondPrompt.slice(0, 500)}`,
    );
  });
});

// ----------------------------------------------------------------------------
// Prompt template: self-healing-fix.txt
// ----------------------------------------------------------------------------

describe('self-healing prompt template', () => {
  test('self-healing-fix.txt exists and has required placeholders', () => {
    const promptPath = join(
      import.meta.dirname ?? '.',
      '..',
      'prompts',
      'self-healing-fix.txt',
    );
    const content = readFileSync(promptPath, 'utf8');

    assert.ok(content.includes('{{COMMAND}}'), 'Missing {{COMMAND}} placeholder');
    assert.ok(content.includes('{{EXIT_CODE}}'), 'Missing {{EXIT_CODE}} placeholder');
    assert.ok(content.includes('{{OUTPUT}}'), 'Missing {{OUTPUT}} placeholder');
    assert.ok(content.includes('{{ATTEMPT_HISTORY}}'), 'Missing {{ATTEMPT_HISTORY}} placeholder');
  });

  test('prompt instructs not to repeat failed fixes', () => {
    const promptPath = join(
      import.meta.dirname ?? '.',
      '..',
      'prompts',
      'self-healing-fix.txt',
    );
    const content = readFileSync(promptPath, 'utf8');

    assert.ok(
      content.toLowerCase().includes('do not repeat'),
      'Prompt should instruct Claude not to repeat failed fixes',
    );
  });

  test('prompt mentions root cause analysis', () => {
    const promptPath = join(
      import.meta.dirname ?? '.',
      '..',
      'prompts',
      'self-healing-fix.txt',
    );
    const content = readFileSync(promptPath, 'utf8');

    assert.ok(
      content.toLowerCase().includes('root cause'),
      'Prompt should emphasize root cause analysis',
    );
  });
});

// ----------------------------------------------------------------------------
// Regression: loader + runner integration (use actual loadWorkflow, not manual Workflow)
// ----------------------------------------------------------------------------

describe('regression — loader + runner integration', () => {
  let originalPath: string;

  beforeEach(() => {
    const mock = installMockClaude();
    originalPath = mock.originalPath;
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
  });

  test('script step WITHOUT self_healing does NOT trigger healing on failure (loader sets selfHealing=false)', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: no_heal
    type: script
    command: exit 1
`));
    const task = wf.tasks[0] as CommandTask;
    assert.equal(task.selfHealing, false, 'loader must set selfHealing=false by default');

    const { events, error } = await collectEventsUntilError(wf);
    const logs = logEvents(events);

    assert.ok(error, 'Expected runner to throw on script failure');
    assert.ok(
      !logs.some((e) => e.text.includes('[self-healing]')),
      `Expected no self-healing logs. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
  });

  test('script step WITH self_healing: true triggers healing on failure (loader sets selfHealing=true)', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: heal_me
    type: script
    command: exit 1
    self_healing: true
    max_healing_attempts: 2
    continue_on_error: true
`));
    const task = wf.tasks[0] as CommandTask;
    assert.equal(task.selfHealing, true, 'loader must set selfHealing=true when specified');

    const { events } = await collectEventsUntilError(wf);
    const logs = logEvents(events);

    assert.ok(
      logs.some((e) => e.text.includes('[self-healing]')),
      `Expected self-healing logs to appear. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
  });

  test('P2-6: self_healing=true + continue_on_error omitted → runner throws after maxHealingAttempts exhausted', async () => {
    const wf = loadWorkflow(tmpYaml(`
goal: test
steps:
  - name: hard_stop
    type: script
    command: exit 1
    self_healing: true
    max_healing_attempts: 2
`));
    const task = wf.tasks[0] as CommandTask;
    assert.equal(task.selfHealing, true, 'loader must set selfHealing=true');
    assert.equal(task.continueOnError, false, 'continueOnError must default to false when omitted');

    const { events, error } = await collectEventsUntilError(wf);
    const logs = logEvents(events);

    assert.ok(error, 'Expected runner to throw after healing is exhausted');
    assert.ok(
      error!.message.includes('self-healing attempts'),
      `Expected exhaustion error message. Got: ${error!.message}`,
    );
    assert.ok(
      logs.some((e) => e.text.includes('Exhausted 2 attempts')),
      `Expected exhaustion log. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
    assert.ok(
      !events.some((e) => e.type === 'workflow:complete'),
      'workflow:complete must NOT be emitted when continueOnError is false',
    );
  });
});
