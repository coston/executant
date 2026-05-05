// ============================================================================
// PLAN SUBCOMMAND — unit tests
// ============================================================================
// Tests pure helper functions in src/plan.ts and src/lib/utils.ts.
// parsePlanArgs is tested via argument-parsing error paths,
// intercepting process.exit so the test process doesn't actually quit.
// streamPlan is tested end-to-end via mock claude binaries installed into PATH.

import assert from 'node:assert/strict';
import { describe, test, mock, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findProjectRoot, findGitRoot, parsePlanArgs, streamPlan } from '../plan.js';
import type { PlanArgs } from '../plan.js';
import { slugify, extractJsonObject as extractJson } from '../lib/utils.js';
import type { PlanEvent } from '../ui/PlanApp.js';

// ----------------------------------------------------------------------------
// slugify
// ----------------------------------------------------------------------------

describe('slugify', () => {
  test('lowercases and replaces spaces with hyphens', () => {
    assert.equal(slugify('Add User Auth'), 'add-user-auth');
  });

  test('collapses multiple non-alphanumeric chars into one hyphen', () => {
    assert.equal(slugify('foo  --  bar'), 'foo-bar');
  });

  test('strips leading and trailing hyphens', () => {
    assert.equal(slugify('  hello world  '), 'hello-world');
  });

  test('truncates to maxLen (default 20)', () => {
    const long = 'a'.repeat(30);
    assert.equal(slugify(long).length, 20);
  });

  test('does not end in a hyphen after truncation', () => {
    // "abcde-fghij-klmno-p" — truncating at 20 should not leave a trailing dash
    const result = slugify('abcde fghij klmno pqrstu');
    assert.ok(!result.endsWith('-'), `Slug ends with hyphen: "${result}"`);
  });

  test('accepts custom maxLen', () => {
    assert.equal(slugify('hello world', 5).length, 5);
  });

  test('handles special characters', () => {
    assert.equal(slugify('fix: bug#42 (critical)'), 'fix-bug-42-critical');
  });

  test('returns empty string for whitespace-only input', () => {
    assert.equal(slugify('   '), '');
  });
});

// ----------------------------------------------------------------------------
// extractJson
// ----------------------------------------------------------------------------

describe('extractJson', () => {
  test('extracts JSON from ```json fences', () => {
    const input = '```json\n{"goal": "test", "steps": []}\n```';
    assert.equal(extractJson(input), '{"goal": "test", "steps": []}');
  });

  test('extracts JSON from ``` fences without language tag', () => {
    const input = '```\n{"goal": "test"}\n```';
    assert.equal(extractJson(input), '{"goal": "test"}');
  });

  test('returns plain JSON unchanged', () => {
    const input = '{"goal": "test", "steps": []}';
    assert.equal(extractJson(input), '{"goal": "test", "steps": []}');
  });

  test('extracts JSON from preamble prose', () => {
    const input = 'Here is the plan:\n\n{"goal": "test", "steps": []}';
    assert.equal(extractJson(input), '{"goal": "test", "steps": []}');
  });

  test('extracts JSON with trailing prose', () => {
    const input = '{"goal": "test", "steps": []}\n\nThis is a summary.';
    assert.equal(extractJson(input), '{"goal": "test", "steps": []}');
  });

  test('extracts JSON with both preamble and trailing text', () => {
    const input = 'The plan:\n{"goal": "test", "steps": [{"name": "a"}]}\nDone!';
    assert.equal(extractJson(input), '{"goal": "test", "steps": [{"name": "a"}]}');
  });

  test('handles nested braces correctly', () => {
    const input = '{"goal": "test", "vars": {"a": "b"}, "steps": []}';
    assert.equal(extractJson(input), '{"goal": "test", "vars": {"a": "b"}, "steps": []}');
  });

  test('prefers fenced content over brace matching', () => {
    const input = 'bad { stuff }\n```json\n{"goal": "right"}\n```';
    assert.equal(extractJson(input), '{"goal": "right"}');
  });

  test('returns trimmed input when no JSON found', () => {
    const input = '  no json here  ';
    assert.equal(extractJson(input), 'no json here');
  });
});

// ----------------------------------------------------------------------------
// findProjectRoot
// ----------------------------------------------------------------------------

describe('findProjectRoot', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `executant-plan-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('finds tasks dir in the start directory itself', () => {
    const tasksDir = join(tmpRoot, '.claude', 'executant.local', 'tasks');
    mkdirSync(tasksDir, { recursive: true });

    const result = findProjectRoot(tmpRoot);
    assert.equal(result, tasksDir);
  });

  test('finds tasks dir by walking up one level', () => {
    const tasksDir = join(tmpRoot, '.claude', 'executant.local', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const subDir = join(tmpRoot, 'src', 'components');
    mkdirSync(subDir, { recursive: true });

    const result = findProjectRoot(subDir);
    assert.equal(result, tasksDir);
  });

  test('finds tasks dir by walking up multiple levels', () => {
    const tasksDir = join(tmpRoot, '.claude', 'executant.local', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const deepDir = join(tmpRoot, 'a', 'b', 'c', 'd');
    mkdirSync(deepDir, { recursive: true });

    const result = findProjectRoot(deepDir);
    assert.equal(result, tasksDir);
  });

  test('returns null when no tasks dir exists in tree', () => {
    // tmpRoot has no .claude/executant.local/tasks
    const result = findProjectRoot(tmpRoot);
    assert.equal(result, null);
  });

  test('returns null from a deeply nested dir with no project root', () => {
    const deepDir = join(tmpRoot, 'a', 'b', 'c');
    mkdirSync(deepDir, { recursive: true });

    const result = findProjectRoot(deepDir);
    assert.equal(result, null);
  });

  test('returns the closest ancestor (nearest wins)', () => {
    // Project root at tmpRoot
    const outerTasks = join(tmpRoot, '.claude', 'executant.local', 'tasks');
    mkdirSync(outerTasks, { recursive: true });

    // Nested project at tmpRoot/subproject
    const subProject = join(tmpRoot, 'subproject');
    const innerTasks = join(subProject, '.claude', 'executant.local', 'tasks');
    mkdirSync(innerTasks, { recursive: true });

    // Search from subproject/src — should find inner, not outer
    const srcDir = join(subProject, 'src');
    mkdirSync(srcDir, { recursive: true });

    const result = findProjectRoot(srcDir);
    assert.equal(result, innerTasks);
  });
});

// ----------------------------------------------------------------------------
// parsePlanArgs — argument validation (no claude calls, process.exit intercepted)
// ----------------------------------------------------------------------------

describe('parsePlanArgs — argument errors', () => {
  let exitCode: number | undefined;
  let stderrLines: string[];
  let originalExit: typeof process.exit;
  let _originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    exitCode = undefined;
    stderrLines = [];
    originalExit = process.exit;
    _originalStderrWrite = process.stderr.write.bind(process.stderr);

    // Capture stderr
    mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

    // Intercept process.exit — capture code and throw so the function unwinds
    (process as NodeJS.Process).exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${exitCode})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    mock.restoreAll();
  });

  function stderr(): string {
    return stderrLines.join('');
  }

  test('exits 1 with usage message when no args and stdin is a TTY', () => {
    // Simulate TTY stdin (no piped input)
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    assert.throws(() => parsePlanArgs([]), /process\.exit\(1\)/);
    assert.equal(exitCode, 1);
    assert.ok(stderr().includes('No task description provided'));

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });

  test('exits 0 and prints help for --help', () => {
    assert.throws(() => parsePlanArgs(['--help']), /process\.exit\(0\)/);
    assert.equal(exitCode, 0);
  });

  test('exits 0 and prints help for -h', () => {
    assert.throws(() => parsePlanArgs(['-h']), /process\.exit\(0\)/);
    assert.equal(exitCode, 0);
  });

  test('exits 1 when -f given without a path', () => {
    assert.throws(() => parsePlanArgs(['-f']), /process\.exit\(1\)/);
    assert.equal(exitCode, 1);
    assert.ok(stderr().includes('-f/--file requires a file path'));
  });

  test('exits 1 when --file given without a path', () => {
    assert.throws(() => parsePlanArgs(['--file']), /process\.exit\(1\)/);
    assert.equal(exitCode, 1);
  });

  test('exits 1 when -f file does not exist', () => {
    assert.throws(() => parsePlanArgs(['-f', '/nonexistent/path/file.txt']), /process\.exit\(1\)/);
    assert.equal(exitCode, 1);
    assert.ok(stderr().includes('File not found'));
  });

  test('exits 1 when --file file does not exist', () => {
    assert.throws(() => parsePlanArgs(['--file', '/no/such/file.yaml']), /process\.exit\(1\)/);
    assert.equal(exitCode, 1);
  });

});

// ----------------------------------------------------------------------------
// findGitRoot
// ----------------------------------------------------------------------------

describe('findGitRoot', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `executant-git-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('finds .git in the start directory itself', () => {
    mkdirSync(join(tmpRoot, '.git'));
    assert.equal(findGitRoot(tmpRoot), tmpRoot);
  });

  test('finds .git by walking up', () => {
    mkdirSync(join(tmpRoot, '.git'));
    const sub = join(tmpRoot, 'src', 'components');
    mkdirSync(sub, { recursive: true });
    assert.equal(findGitRoot(sub), tmpRoot);
  });

  test('returns null when no .git found', () => {
    assert.equal(findGitRoot(tmpRoot), null);
  });
});

// ----------------------------------------------------------------------------
// parsePlanArgs — auto-creates tasks dir when missing
// ----------------------------------------------------------------------------

describe('parsePlanArgs — auto-creates tasks directory', () => {
  let tmpRoot: string;
  let origCwd: string;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpRoot = join(tmpdir(), `executant-autocreate-${process.pid}-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    originalExit = process.exit;
    (process as NodeJS.Process).exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    mock.restoreAll();
    if (process.cwd() !== origCwd) process.chdir(origCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('creates .claude/executant.local/tasks at git root when no tasks dir exists', () => {
    mkdirSync(join(tmpRoot, '.git'));
    process.chdir(tmpRoot);
    parsePlanArgs(['do something useful']);
    const expectedDir = join(tmpRoot, '.claude', 'executant.local', 'tasks');
    assert.ok(existsSync(expectedDir), `Expected ${expectedDir} to be created`);
  });

  test('creates tasks dir at cwd when no git root found', () => {
    process.chdir(tmpRoot);
    parsePlanArgs(['do something useful']);
    const expectedDir = join(tmpRoot, '.claude', 'executant.local', 'tasks');
    assert.ok(existsSync(expectedDir), `Expected ${expectedDir} to be created`);
  });
});

// ----------------------------------------------------------------------------
// streamPlan — end-to-end tests via mock claude binary
// ----------------------------------------------------------------------------
//
// Each test installs a fake `claude` script into a temp dir prepended to PATH.
// The mock serves pre-written NDJSON responses (indexed by invocation count) and
// may include `structured_output` to simulate valid schema-conformant output.
//
// Three-pass pipeline order per successful run:
//   Invocation 0: Pass 1 research (text only, no structured_output)
//   Invocation 1: Pass 2 decompose (structured_output with workflow JSON)
//   Invocation 2: Pass 3 judge (text only, JSON string like {"pass":true,"feedback":""})

type MockResponse = { structured?: unknown; text?: string; exitCode?: number };

function installPlanMock(responses: MockResponse[]): { counterFile: string; originalPath: string } {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mockDir = join(tmpdir(), `executant-plan-mock-${id}`);
  const responsesDir = join(mockDir, 'responses');
  const counterFile = join(mockDir, 'counter');

  mkdirSync(responsesDir, { recursive: true });
  writeFileSync(counterFile, '0', 'utf8');

  for (const [i, resp] of responses.entries()) {
    const lines: string[] = [];
    if (resp.text) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: resp.text }] },
      }));
    }
    const result: Record<string, unknown> = { type: 'result', total_cost_usd: 0.001 };
    if (resp.structured !== undefined) result['structured_output'] = resp.structured;
    lines.push(JSON.stringify(result));
    writeFileSync(join(responsesDir, `${i}.ndjson`), lines.join('\n') + '\n', 'utf8');
    // Write exit code sidecar (defaults to 0)
    writeFileSync(join(responsesDir, `${i}.exit`), String(resp.exitCode ?? 0), 'utf8');
  }

  const fallback = join(responsesDir, 'fallback.ndjson');
  writeFileSync(fallback, JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n', 'utf8');

  const mockScript = join(mockDir, 'claude');
  writeFileSync(
    mockScript,
    `#!/usr/bin/env bash
count=$(cat "${counterFile}")
echo $((count + 1)) > "${counterFile}"
f="${responsesDir}/$count.ndjson"
exitf="${responsesDir}/$count.exit"
[ -f "$f" ] && cat "$f" || cat "${fallback}"
exitcode=0
[ -f "$exitf" ] && exitcode=$(cat "$exitf")
exit $exitcode
`,
    'utf8',
  );
  chmodSync(mockScript, 0o755);

  const originalPath = process.env['PATH'] ?? '';
  process.env['PATH'] = `${mockDir}:${originalPath}`;
  return { counterFile, originalPath };
}

const VALID_WORKFLOW = {
  goal: 'Add user authentication',
  steps: [{ name: 'implement', prompt: 'Implement user authentication with JWT.' }],
};

const VALID_WORKFLOW_NO_TESTS = {
  goal: 'Add user authentication',
  steps: [{ name: 'implement', prompt: 'Implement user authentication with JWT — no verification.' }],
};

const JUDGE_PASS = JSON.stringify({ pass: true, feedback: '' });
const JUDGE_FAIL_NO_TESTS = JSON.stringify({ pass: false, feedback: 'Missing lint, test, and build verification steps.' });

describe('streamPlan', () => {
  let tmpRoot: string;
  let savedPath: string;

  beforeEach(() => {
    savedPath = process.env['PATH'] ?? '';
    tmpRoot = join(tmpdir(), `executant-streamplan-${process.pid}-${Date.now()}`);
    mkdirSync(join(tmpRoot, 'todo'), { recursive: true });
  });

  afterEach(() => {
    process.env['PATH'] = savedPath;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makePlanArgs(slug = 'test-task'): PlanArgs {
    return {
      description: `add ${slug.replace(/-/g, ' ')}`,
      taskFile: join(tmpRoot, 'todo', `20260503-000000-${slug}.yaml`),
      todoDir: join(tmpRoot, 'todo'),
    };
  }

  async function collectPlanEvents(args: PlanArgs): Promise<PlanEvent[]> {
    const events: PlanEvent[] = [];
    for await (const e of streamPlan(args)) events.push(e);
    return events;
  }

  // Helper to extract typed events
  function stageEvents(events: PlanEvent[]) {
    return events.filter((e): e is Extract<PlanEvent, { type: 'plan:stage' }> => e.type === 'plan:stage');
  }

  test('success: writes YAML with expected goal and steps (3 invocations: research, decompose, judge)', async () => {
    const { counterFile } = installPlanMock([
      { text: '## Research\nFound relevant files.' },  // Pass 1: research
      { structured: VALID_WORKFLOW, text: 'Decomposing…' }, // Pass 2: decompose
      { text: JUDGE_PASS },                              // Pass 3: judge
    ]);

    const args = makePlanArgs('user-auth');
    const events = await collectPlanEvents(args);

    assert.equal(readFileSync(counterFile, 'utf8').trim(), '3', 'Expected exactly 3 Claude invocations');

    const complete = events.find((e) => e.type === 'plan:complete') as
      Extract<PlanEvent, { type: 'plan:complete' }> | undefined;
    assert.ok(complete, 'Expected plan:complete event');
    assert.equal(complete!.taskFile, args.taskFile);

    assert.ok(existsSync(args.taskFile), 'Expected YAML file to be written');
    const yaml = readFileSync(args.taskFile, 'utf8');
    assert.ok(yaml.includes('goal: Add user authentication'), 'YAML missing goal');
    assert.ok(yaml.includes('name: implement'), 'YAML missing step name');
    assert.ok(yaml.includes('prompt:'), 'YAML missing prompt');

    assert.ok(!events.some((e) => e.type === 'plan:error'), 'Expected no plan:error event');
    assert.ok(!events.some((e) => e.type === 'plan:retry'), 'Expected no plan:retry event');
  });

  test('stage events emitted in correct order: research → decompose → validate', async () => {
    installPlanMock([
      { text: '## Research\nContext found.' },
      { structured: VALID_WORKFLOW },
      { text: JUDGE_PASS },
    ]);

    const args = makePlanArgs('stage-order');
    const events = await collectPlanEvents(args);

    const stages = stageEvents(events);
    assert.equal(stages.length, 3, 'Expected exactly 3 plan:stage events');
    assert.equal(stages[0]!.stage, 1);
    assert.equal(stages[0]!.name, 'Research & Planning');
    assert.equal(stages[1]!.stage, 2);
    assert.equal(stages[1]!.name, 'Decompose to Steps');
    assert.equal(stages[2]!.stage, 3);
    assert.equal(stages[2]!.name, 'Validate');
  });

  test('judge rejects on first attempt, Pass 2 retried with feedback', async () => {
    const { counterFile } = installPlanMock([
      { text: '## Research' },                                // Pass 1
      { structured: VALID_WORKFLOW_NO_TESTS },                // Pass 2 attempt 1 (missing tests)
      { text: JUDGE_FAIL_NO_TESTS },                          // Pass 3: judge rejects
      { structured: VALID_WORKFLOW },                         // Pass 2 attempt 2 (with tests)
      { text: JUDGE_PASS },                                   // Pass 3: judge accepts
    ]);

    const args = makePlanArgs('judge-retry');
    const events = await collectPlanEvents(args);

    assert.equal(readFileSync(counterFile, 'utf8').trim(), '5', 'Expected exactly 5 invocations');

    assert.ok(existsSync(args.taskFile), 'Expected YAML file written after judge-retry');
    assert.ok(events.some((e) => e.type === 'plan:retry'), 'Expected plan:retry event');
    assert.ok(events.some((e) => e.type === 'plan:complete'), 'Expected plan:complete event');
    assert.ok(!events.some((e) => e.type === 'plan:error'), 'Expected no plan:error event');

    // Stage 2 should appear twice (initial + after judge rejection)
    const stage2Events = stageEvents(events).filter((e) => e.stage === 2);
    assert.equal(stage2Events.length, 2, 'Expected stage 2 to appear twice (initial + retry)');
  });

  test('Pass 1 failure yields plan:error immediately — no decompose or judge invocation', async () => {
    const { counterFile } = installPlanMock([
      { text: 'error output', exitCode: 1 },  // Pass 1 fails
    ]);

    const args = makePlanArgs('research-fail');
    const events = await collectPlanEvents(args);

    assert.equal(readFileSync(counterFile, 'utf8').trim(), '1', 'Expected exactly 1 Claude invocation');

    const errorEvent = events.find((e) => e.type === 'plan:error') as
      Extract<PlanEvent, { type: 'plan:error' }> | undefined;
    assert.ok(errorEvent, 'Expected plan:error event');
    assert.ok(errorEvent!.message.length > 0, 'Error message must be non-empty');

    assert.ok(!existsSync(args.taskFile), 'Expected no YAML file after Pass 1 failure');
    assert.ok(!events.some((e) => e.type === 'plan:complete'), 'Expected no plan:complete event');

    // No stage 2 should have been emitted after research failed
    const stage2 = stageEvents(events).find((e) => e.stage === 2);
    assert.ok(!stage2, 'Expected no stage 2 event after Pass 1 failure');
  });

  test('Pass 2 retry: invalid decompose response on attempt 1, success on attempt 2', async () => {
    const { counterFile } = installPlanMock([
      { text: '## Research' },          // Pass 1: research
      { text: 'Not JSON output…' },     // Pass 2 attempt 1: no structured_output → retry
      { structured: VALID_WORKFLOW },   // Pass 2 attempt 2: valid
      { text: JUDGE_PASS },             // Pass 3: judge
    ]);

    const args = makePlanArgs('decompose-retry');
    const events = await collectPlanEvents(args);

    assert.equal(readFileSync(counterFile, 'utf8').trim(), '4', 'Expected exactly 4 Claude invocations');

    assert.ok(existsSync(args.taskFile), 'Expected YAML file to be written after decompose retry');

    const retryEvent = events.find((e) => e.type === 'plan:retry') as
      Extract<PlanEvent, { type: 'plan:retry' }> | undefined;
    assert.ok(retryEvent, 'Expected plan:retry event to be emitted');
    assert.equal(retryEvent!.attempt, 2);
    assert.equal(retryEvent!.maxAttempts, 3);

    assert.ok(events.some((e) => e.type === 'plan:complete'), 'Expected plan:complete event');
    assert.ok(!events.some((e) => e.type === 'plan:error'), 'Expected no plan:error event');
  });

  test('judge rejects on all attempts: YAML still written on final attempt (non-blocking)', async () => {
    const { counterFile } = installPlanMock([
      { text: '## Research' },                  // Pass 1
      { structured: VALID_WORKFLOW_NO_TESTS },   // Pass 2, attempt 1
      { text: JUDGE_FAIL_NO_TESTS },             // Pass 3, attempt 1 — rejects
      { structured: VALID_WORKFLOW_NO_TESTS },   // Pass 2, attempt 2
      { text: JUDGE_FAIL_NO_TESTS },             // Pass 3, attempt 2 — rejects
      { structured: VALID_WORKFLOW_NO_TESTS },   // Pass 2, attempt 3 (final)
      { text: JUDGE_FAIL_NO_TESTS },             // Pass 3, final — rejects but falls through
    ]);

    const args = makePlanArgs('judge-final-override');
    const events = await collectPlanEvents(args);

    assert.equal(readFileSync(counterFile, 'utf8').trim(), '7', 'Expected exactly 7 Claude invocations');

    assert.ok(events.some((e) => e.type === 'plan:complete'), 'Expected plan:complete — judge is non-blocking');
    assert.ok(existsSync(args.taskFile), 'Expected YAML written despite judge rejections');
    assert.ok(!events.some((e) => e.type === 'plan:error'), 'Expected no plan:error event');

    const retryEvents = events.filter((e) => e.type === 'plan:retry');
    assert.equal(retryEvents.length, 2, 'Expected 2 plan:retry events (attempts 2 and 3)');

    const warnEvent = events.find(
      (e): e is Extract<PlanEvent, { type: 'plan:warn' }> => e.type === 'plan:warn',
    );
    assert.ok(warnEvent, 'Expected a plan:warn event about judge rejection');
    assert.ok(warnEvent!.message.length > 0, 'Warn message must be non-empty');
  });

  test('three consecutive decompose failures: yields plan:error and writes no file', async () => {
    const { counterFile } = installPlanMock([
      { text: '## Research' },   // Pass 1
      { text: 'attempt 1' },     // Pass 2 attempt 1: no structured_output
      { text: 'attempt 2' },     // Pass 2 attempt 2: no structured_output
      { text: 'attempt 3' },     // Pass 2 attempt 3: no structured_output
    ]);

    const args = makePlanArgs('fail-task');
    const events = await collectPlanEvents(args);

    assert.equal(readFileSync(counterFile, 'utf8').trim(), '4', 'Expected exactly 4 Claude invocations');

    const errorEvent = events.find((e) => e.type === 'plan:error') as
      Extract<PlanEvent, { type: 'plan:error' }> | undefined;
    assert.ok(errorEvent, 'Expected plan:error event');
    assert.ok(errorEvent!.message.length > 0, 'Error message must be non-empty');

    assert.ok(!existsSync(args.taskFile), 'Expected no YAML file after 3 decompose failures');
    assert.ok(!events.some((e) => e.type === 'plan:complete'), 'Expected no plan:complete event');

    const retryEvents = events.filter((e) => e.type === 'plan:retry');
    assert.equal(retryEvents.length, 2, 'Expected 2 plan:retry events (attempts 2 and 3)');
  });
});
