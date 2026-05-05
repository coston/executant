// ============================================================================
// JUDGE FEATURE TESTS
// ============================================================================
// Tests for evaluateWithJudge: JSON parsing, pass/fail verdict, fence handling,
// and invalid-output error propagation.
//
// Integration tests for runClaudeWithJudge (via runWorkflow with llmAsJudge:true):
// retry on failure, feedback injection into the retry prompt, and exhaustion
// after MAX_JUDGE_RETRIES.
//
// Uses a mock claude binary installed into a temp dir prepended to PATH.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateWithJudge } from '../runner.js';
import type { ClaudeTask, Event, LogEvent, Workflow } from '../types.js';
import { collectEvents, collectEventsUntilError } from './helpers.js';

// Creates a mock claude binary that emits one stream-json text event with the
// given response text, then exits 0. Uses a sidecar response file to avoid
// shell quoting issues with embedded JSON.
function installJudgeMock(responseText: string): void {
  const mockDir = join(tmpdir(), `executant-judge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(mockDir, { recursive: true });

  const responseFile = join(mockDir, 'response.ndjson');
  const assistantLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: responseText }] },
  });
  const resultLine = JSON.stringify({ type: 'result', total_cost_usd: 0.001 });
  writeFileSync(responseFile, `${assistantLine}\n${resultLine}\n`, 'utf8');

  const mockScript = join(mockDir, 'claude');
  writeFileSync(mockScript, `#!/usr/bin/env bash\ncat "${responseFile}"\nexit 0\n`, 'utf8');
  chmodSync(mockScript, 0o755);

  process.env['PATH'] = `${mockDir}:${process.env['PATH'] ?? ''}`;
}

describe('evaluateWithJudge', () => {
  let originalPath: string;

  beforeEach(() => {
    originalPath = process.env['PATH'] ?? '';
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
  });

  test('PASS verdict returns pass:true and empty feedback', async () => {
    installJudgeMock('{"pass":true,"reasoning":"Output is complete and correct","feedback":""}');
    const result = await evaluateWithJudge('my-step', 'Do X', 'Done X');
    assert.deepEqual(result, { pass: true, feedback: '' });
  });

  test('FAIL verdict returns pass:false with feedback', async () => {
    installJudgeMock('{"pass":false,"reasoning":"Output is incomplete","feedback":"needs more detail"}');
    const result = await evaluateWithJudge('my-step', 'Do X', 'Partial X');
    assert.deepEqual(result, { pass: false, feedback: 'needs more detail' });
  });

  test('JSON wrapped in code fences is still parsed correctly', async () => {
    installJudgeMock('```json\n{"pass":true,"reasoning":"Looks good","feedback":""}\n```');
    const result = await evaluateWithJudge('my-step', 'Do X', 'Done');
    assert.equal(result.pass, true);
    assert.equal(result.feedback, '');
  });

  test('JSON wrapped in plain fences is still parsed correctly', async () => {
    installJudgeMock('```\n{"pass":false,"reasoning":"Bad","feedback":"fix it"}\n```');
    const result = await evaluateWithJudge('my-step', 'Do X', 'Bad output');
    assert.equal(result.pass, false);
    assert.equal(result.feedback, 'fix it');
  });

  test('completely unparseable response throws (--json-schema prevents this in production)', async () => {
    installJudgeMock("I'll verify the output and provide my evaluation.");
    await assert.rejects(
      () => evaluateWithJudge('my-step', 'Do X', 'output'),
      /SyntaxError|JSON/i,
    );
  });
});

// ============================================================================
// Integration helpers for runClaudeWithJudge
// ============================================================================

// Mirrors the constant in runner.ts — kept in sync manually so the exhaustion
// test knows exactly how many call-pairs to pre-populate.
const MAX_JUDGE_RETRIES = 5;

function logEvents(events: Event[]): LogEvent[] {
  return events.filter((e): e is LogEvent => e.type === 'log');
}

/**
 * Installs a sequenced mock claude binary into a temp dir prepended to PATH.
 * Each invocation reads/increments a shared counter and serves the
 * corresponding pre-written NDJSON response. The prompt arg ($2) is saved to
 * promptsDir/<call_index>.txt so tests can assert on injected content.
 */
function installSequencedMock(responses: string[]): { promptsDir: string } {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mockDir = join(tmpdir(), `executant-judge-int-${id}`);
  const responsesDir = join(mockDir, 'responses');
  const promptsDir = join(mockDir, 'prompts');
  const counterFile = join(mockDir, 'counter');

  mkdirSync(responsesDir, { recursive: true });
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(counterFile, '0', 'utf8');

  for (const [i, text] of responses.entries()) {
    const ndjson =
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) +
      '\n' +
      JSON.stringify({ type: 'result', total_cost_usd: 0.001 }) +
      '\n';
    writeFileSync(join(responsesDir, `${i}.ndjson`), ndjson, 'utf8');
  }

  const mockScript = join(mockDir, 'claude');
  writeFileSync(
    mockScript,
    `#!/usr/bin/env bash
count=$(cat "${counterFile}")
echo $((count + 1)) > "${counterFile}"
printf '%s' "$2" > "${promptsDir}/$count.txt"
cat "${responsesDir}/$count.ndjson"
exit 0
`,
    'utf8',
  );
  chmodSync(mockScript, 0o755);

  process.env['PATH'] = `${mockDir}:${process.env['PATH'] ?? ''}`;

  return { promptsDir };
}

function judgeResponse(pass: boolean, feedback: string): string {
  return JSON.stringify({
    pass,
    reasoning: pass ? 'Output meets all criteria' : 'Output does not meet criteria',
    feedback,
  });
}

function judgeWorkflow(stepName: string): Workflow {
  return {
    goal: 'judge integration test',
    tasks: [
      {
        type: 'claude' as const,
        name: stepName,
        prompt: 'Write a comprehensive report.',
        llmAsJudge: true,
      } satisfies ClaudeTask,
    ],
  };
}

// ============================================================================
// runClaudeWithJudge integration tests
// ============================================================================

describe('runClaudeWithJudge — integration', () => {
  let originalPath: string;

  beforeEach(() => {
    originalPath = process.env['PATH'] ?? '';
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
  });

  test('passing verdict on first attempt skips retries', async () => {
    installSequencedMock([
      'main step output',
      judgeResponse(true, ''),
    ]);

    const events = await collectEvents(judgeWorkflow('report'));
    const logs = logEvents(events);

    assert.ok(logs.some((e) => e.text === '[judge] PASS'), 'Expected PASS log');
    assert.ok(!logs.some((e) => e.text.includes('[judge] FAIL')), 'Expected no FAIL log');
    assert.ok(!logs.some((e) => e.text.includes('Retrying')), 'Expected no retry log');
    assert.ok(events.some((e) => e.type === 'workflow:complete'));
  });

  test('failing verdict retries and injects judge feedback into the next prompt', async () => {
    const feedbackText = 'add specific metrics and deadlines';

    const { promptsDir } = installSequencedMock([
      'first attempt output',             // main step, attempt 0 → call index 0
      judgeResponse(false, feedbackText),  // judge, attempt 0      → call index 1
      'improved output',                  // main step, attempt 1 → call index 2
      judgeResponse(true, ''),            // judge, attempt 1      → call index 3
    ]);

    const events = await collectEvents(judgeWorkflow('report'));
    const logs = logEvents(events);

    assert.ok(
      logs.some((e) => e.text.includes('[judge] FAIL') && e.text.includes(feedbackText)),
      `Expected FAIL log containing feedback. Got: ${logs.map((e) => e.text).join(' | ')}`,
    );
    assert.ok(
      logs.some((e) => e.text.includes('[judge] Retrying')),
      'Expected retry log',
    );
    assert.ok(logs.some((e) => e.text === '[judge] PASS'), 'Expected eventual PASS log');
    assert.ok(events.some((e) => e.type === 'workflow:complete'));

    // Feedback must appear in the retry prompt sent to Claude on attempt 1 (call index 2).
    const retryPrompt = readFileSync(join(promptsDir, '2.txt'), 'utf8');
    assert.ok(
      retryPrompt.includes(feedbackText),
      `Expected feedback "${feedbackText}" injected into retry prompt. Got: ${retryPrompt.slice(0, 200)}`,
    );
  });

  test('gives up with a clear error after MAX_JUDGE_RETRIES failures', async () => {
    const responses: string[] = [];
    for (let i = 0; i < MAX_JUDGE_RETRIES; i++) {
      responses.push('main step output');
      responses.push(judgeResponse(false, 'still not good enough'));
    }

    installSequencedMock(responses);

    const { events, error } = await collectEventsUntilError(judgeWorkflow('critical-step'));

    assert.ok(error, 'Expected an error to be thrown');
    assert.ok(
      error!.message.includes('critical-step'),
      `Expected step name in error. Got: ${error!.message}`,
    );
    assert.ok(
      error!.message.includes(`${MAX_JUDGE_RETRIES} attempts`),
      `Expected attempt count in error. Got: ${error!.message}`,
    );

    const logs = logEvents(events);
    assert.equal(
      logs.filter((e) => e.text.includes('[judge] FAIL')).length,
      MAX_JUDGE_RETRIES,
      `Expected ${MAX_JUDGE_RETRIES} FAIL logs`,
    );
    assert.ok(!logs.some((e) => e.text === '[judge] PASS'), 'Expected no PASS log');
  });
});
