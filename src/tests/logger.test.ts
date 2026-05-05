// ============================================================================
// LOGGER TESTS
// ============================================================================
// Tests for findExecutantLocalDir, Logger, and withLogger from src/logger.ts.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findExecutantLocalDir, Logger, withLogger } from '../logger.js';
import type { Event, Workflow } from '../types.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `executant-logger-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const FAKE_WORKFLOW: Workflow = { goal: 'test goal', tasks: [] };

async function* makeGen(events: Event[]): AsyncGenerator<Event> {
  for (const e of events) yield e;
}

function readLogFile(logDir: string): string {
  const logFiles = readdirSync(logDir).filter((f) => f.endsWith('.log'));
  assert.equal(logFiles.length, 1, 'expected exactly one log file');
  return readFileSync(join(logDir, logFiles[0]), 'utf8');
}

// ----------------------------------------------------------------------------
// findExecutantLocalDir
// ----------------------------------------------------------------------------

describe('findExecutantLocalDir', () => {
  let tmpRoot: string;

  beforeEach(() => { tmpRoot = makeTmpDir(); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  test('finds .claude/executant.local/ in the start directory', () => {
    const target = join(tmpRoot, '.claude', 'executant.local');
    mkdirSync(target, { recursive: true });
    const result = findExecutantLocalDir(tmpRoot);
    assert.equal(result, target);
  });

  test('finds .claude/executant.local/ by walking up one level', () => {
    const target = join(tmpRoot, '.claude', 'executant.local');
    mkdirSync(target, { recursive: true });
    const child = join(tmpRoot, 'child');
    mkdirSync(child);
    const result = findExecutantLocalDir(child);
    assert.equal(result, target);
  });

  test('returns null when not found anywhere up the tree', () => {
    const result = findExecutantLocalDir(tmpRoot);
    assert.equal(result, null);
  });
});

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

describe('Logger', () => {
  let logDir: string;
  let prevLogEnv: string | undefined;

  beforeEach(() => {
    logDir = makeTmpDir();
    prevLogEnv = process.env['EXECUTANT_LOG'];
    delete process.env['EXECUTANT_LOG'];
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    if (prevLogEnv === undefined) delete process.env['EXECUTANT_LOG'];
    else process.env['EXECUTANT_LOG'] = prevLogEnv;
  });

  test('workflow:start creates logDir and highlightsDir', () => {
    const logger = new Logger(logDir, 'my-task');
    logger.observe({ type: 'workflow:start', workflow: FAKE_WORKFLOW });
    assert.ok(existsSync(logDir));
    assert.ok(existsSync(join(logDir, 'highlights')));
  });

  test('workflow:start creates log file with header', () => {
    const logger = new Logger(logDir, 'my-task');
    logger.observe({ type: 'workflow:start', workflow: FAKE_WORKFLOW });
    const content = readLogFile(logDir);
    assert.ok(content.includes('# Execution Log'));
    assert.ok(content.includes('my-task'));
  });

  test('step:start appends step header to log', () => {
    const logger = new Logger(logDir, 'test-task');
    logger.observe({ type: 'workflow:start', workflow: FAKE_WORKFLOW });
    logger.observe({ type: 'step:start', index: 0, name: 'my-step' });
    const content = readLogFile(logDir);
    assert.ok(content.includes('Step 1: my-step'));
  });

  test('output:text is appended to log file', () => {
    const logger = new Logger(logDir, 'test-task');
    logger.observe({ type: 'workflow:start', workflow: FAKE_WORKFLOW });
    logger.observe({ type: 'step:start', index: 0, name: 'step-a' });
    logger.observe({ type: 'output:text', index: 0, text: 'hello world' });
    const content = readLogFile(logDir);
    assert.ok(content.includes('hello world'));
  });

  test('output:tool is appended with tool summary', () => {
    const logger = new Logger(logDir, 'test-task');
    logger.observe({ type: 'workflow:start', workflow: FAKE_WORKFLOW });
    logger.observe({ type: 'step:start', index: 0, name: 'step-b' });
    logger.observe({ type: 'output:tool', index: 0, tool: 'Read', input: { file_path: '/foo/bar.ts' } });
    const content = readLogFile(logDir);
    assert.ok(content.includes('[Read]'));
    assert.ok(content.includes('/foo/bar.ts'));
  });

  test('EXECUTANT_LOG=0 makes observe a no-op — log file never created', () => {
    process.env['EXECUTANT_LOG'] = '0';
    const logger = new Logger(logDir, 'test-task');
    logger.observe({ type: 'workflow:start', workflow: FAKE_WORKFLOW });
    const logFiles = readdirSync(logDir).filter((f) => f.endsWith('.log'));
    assert.equal(logFiles.length, 0);
  });

  test('observe swallows errors and does not throw', () => {
    const logger = new Logger(logDir, 'test-task');
    // Skip workflow:start so logFile is not set — appendLog silently returns
    assert.doesNotThrow(() =>
      logger.observe({ type: 'output:text', index: -1, text: 'ignored' }),
    );
  });
});

// ----------------------------------------------------------------------------
// withLogger
// ----------------------------------------------------------------------------

describe('withLogger', () => {
  let logDir: string;

  beforeEach(() => { logDir = makeTmpDir(); });
  afterEach(() => { rmSync(logDir, { recursive: true, force: true }); });

  test('passes all events through unchanged', async () => {
    const events: Event[] = [
      { type: 'workflow:start', workflow: FAKE_WORKFLOW },
      { type: 'log', level: 'info', text: 'hello' },
    ];
    const logger = new Logger(logDir, 'passthrough-test');
    const collected: Event[] = [];
    for await (const e of withLogger(makeGen(events), logger)) collected.push(e);
    assert.deepEqual(collected, events);
  });

  test('calls observe once per event', async () => {
    const events: Event[] = [
      { type: 'workflow:start', workflow: FAKE_WORKFLOW },
      { type: 'log', level: 'info', text: 'a' },
      { type: 'log', level: 'warn', text: 'b' },
    ];
    const observedEvents: Event[] = [];
    const mockLogger = { observe: (e: Event) => observedEvents.push(e) } as unknown as Logger;
    for await (const _ of withLogger(makeGen(events), mockLogger)) { /* drain */ }
    assert.equal(observedEvents.length, 3);
    assert.deepEqual(observedEvents, events);
  });
});

// ----------------------------------------------------------------------------
// Highlight pipeline (via withLogger)
// ----------------------------------------------------------------------------

describe('Logger highlight pipeline (via withLogger)', () => {
  let logDir: string;
  let prevLogEnv: string | undefined;

  beforeEach(() => {
    logDir = makeTmpDir();
    prevLogEnv = process.env['EXECUTANT_LOG'];
    delete process.env['EXECUTANT_LOG'];
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    if (prevLogEnv === undefined) delete process.env['EXECUTANT_LOG'];
    else process.env['EXECUTANT_LOG'] = prevLogEnv;
  });

  async function drainWithLogger(events: Event[], taskName: string): Promise<string> {
    const logger = new Logger(logDir, taskName);
    for await (const _ of withLogger(makeGen(events), logger)) { /* drain */ }
    return join(logDir, 'highlights');
  }

  function highlightFiles(highlightsDir: string): string[] {
    return readdirSync(highlightsDir).filter((f) => f.endsWith('.md'));
  }

  test('[judge] PASS log event produces *_judge_PASS.md highlight', async () => {
    const events: Event[] = [
      { type: 'workflow:start', workflow: FAKE_WORKFLOW },
      { type: 'step:start', index: 0, name: 'evaluate' },
      { type: 'log', level: 'info', text: '[judge] PASS: output meets all criteria' },
      { type: 'step:complete', index: 0, name: 'evaluate', durationMs: 100 },
      { type: 'workflow:complete', workflow: FAKE_WORKFLOW, durationMs: 200 },
    ];
    const highlightsDir = await drainWithLogger(events, 'judge-pass-task');

    const files = highlightFiles(highlightsDir);
    const passFile = files.find((f) => f.endsWith('_judge_PASS.md'));
    assert.ok(passFile, `Expected *_judge_PASS.md, got: ${files.join(', ')}`);

    const content = readFileSync(join(highlightsDir, passFile), 'utf8');
    assert.ok(content.includes('# Judge Verdict: PASS'), 'File must include PASS heading');
    assert.ok(content.includes('[judge] PASS'), 'File must echo the original log text');
  });

  test('[judge] FAIL log event produces *_judge_FAIL.md highlight', async () => {
    const events: Event[] = [
      { type: 'workflow:start', workflow: FAKE_WORKFLOW },
      { type: 'step:start', index: 0, name: 'evaluate' },
      { type: 'log', level: 'warn', text: '[judge] FAIL: missing test coverage' },
      { type: 'step:complete', index: 0, name: 'evaluate', durationMs: 100 },
      { type: 'workflow:complete', workflow: FAKE_WORKFLOW, durationMs: 200 },
    ];
    const highlightsDir = await drainWithLogger(events, 'judge-fail-task');

    const files = highlightFiles(highlightsDir);
    const failFile = files.find((f) => f.endsWith('_judge_FAIL.md'));
    assert.ok(failFile, `Expected *_judge_FAIL.md, got: ${files.join(', ')}`);

    const content = readFileSync(join(highlightsDir, failFile), 'utf8');
    assert.ok(content.includes('# Judge Verdict: FAIL'), 'File must include FAIL heading');
    assert.ok(content.includes('[judge] FAIL'), 'File must echo the original log text');
  });

  test('self-healing failure marker produces *_self_healing.md highlight', async () => {
    const events: Event[] = [
      { type: 'workflow:start', workflow: FAKE_WORKFLOW },
      { type: 'step:start', index: 0, name: 'build' },
      { type: 'output:text', index: 0, text: 'Error: cannot find module "foo"' },
      { type: 'log', level: 'warn', text: '[self-healing] Attempt 1/3 failed (exit 1)' },
      { type: 'log', level: 'info', text: '[self-healing] Re-running after fix' },
      { type: 'step:complete', index: 0, name: 'build', durationMs: 500 },
      { type: 'workflow:complete', workflow: FAKE_WORKFLOW, durationMs: 600 },
    ];
    const highlightsDir = await drainWithLogger(events, 'self-healing-task');

    const files = highlightFiles(highlightsDir);
    const healFile = files.find((f) => f.endsWith('_self_healing.md'));
    assert.ok(healFile, `Expected *_self_healing.md, got: ${files.join(', ')}`);

    const content = readFileSync(join(highlightsDir, healFile), 'utf8');
    assert.ok(content.includes('# Self-Healing Activation'), 'File must include activation heading');
    assert.ok(content.includes('Exit Code'), 'File must record the exit code');
    assert.ok(content.includes('Resolution Applied'), 'Re-running marker must append resolution section');
  });

  test('step with 3+ tool calls produces *_complex_sequence.md highlight', async () => {
    const events: Event[] = [
      { type: 'workflow:start', workflow: FAKE_WORKFLOW },
      { type: 'step:start', index: 0, name: 'implement' },
      { type: 'output:tool', index: 0, tool: 'Read',  input: { file_path: '/src/a.ts' } },
      { type: 'output:tool', index: 0, tool: 'Edit',  input: { file_path: '/src/b.ts' } },
      { type: 'output:tool', index: 0, tool: 'Write', input: { file_path: '/src/c.ts' } },
      { type: 'step:complete', index: 0, name: 'implement', durationMs: 300 },
      { type: 'workflow:complete', workflow: FAKE_WORKFLOW, durationMs: 400 },
    ];
    const highlightsDir = await drainWithLogger(events, 'complex-task');

    const files = highlightFiles(highlightsDir);
    const complexFile = files.find((f) => f.endsWith('_complex_sequence.md'));
    assert.ok(complexFile, `Expected *_complex_sequence.md, got: ${files.join(', ')}`);

    const content = readFileSync(join(highlightsDir, complexFile), 'utf8');
    assert.ok(content.includes('# Complex Tool Sequence'), 'File must include complex sequence heading');
    assert.ok(content.includes('Total tools used: 3'), 'File must record total tool count');
    // Only tool calls from the 3rd onwards are appended (Write is the 3rd call here)
    assert.ok(content.includes('Write'), 'File must list the 3rd+ tool call');
  });

  test('highlights/README.md index is created and lists task highlights after workflow:complete', async () => {
    const events: Event[] = [
      { type: 'workflow:start', workflow: FAKE_WORKFLOW },
      { type: 'step:start', index: 0, name: 'step-a' },
      { type: 'log', level: 'info', text: '[judge] PASS: looks good' },
      { type: 'step:complete', index: 0, name: 'step-a', durationMs: 50 },
      { type: 'workflow:complete', workflow: FAKE_WORKFLOW, durationMs: 100 },
    ];
    const highlightsDir = await drainWithLogger(events, 'index-task');

    const indexPath = join(highlightsDir, 'README.md');
    assert.ok(existsSync(indexPath), 'highlights/README.md must be created');

    const content = readFileSync(indexPath, 'utf8');
    assert.ok(content.includes('# Execution Highlights'), 'Index must start with standard heading');
    assert.ok(
      content.includes('judge_PASS.md'),
      `Index must link to the judge_PASS highlight. Content:\n${content}`,
    );
  });
});
