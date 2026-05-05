// ============================================================================
// STREAM UTILITY TESTS
// ============================================================================
// Tests for mergeStreamsToLines and waitForExit from src/tasks/stream.ts.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { mergeStreamsToLines, waitForExit } from '../tasks/stream.js';

// ----------------------------------------------------------------------------
// mergeStreamsToLines
// ----------------------------------------------------------------------------

describe('mergeStreamsToLines', () => {
  test('yields lines from a single stream', async () => {
    const stream = Readable.from(['hello\nworld\n']);
    const lines: string[] = [];
    for await (const line of mergeStreamsToLines(stream)) lines.push(line);
    assert.deepEqual(lines, ['hello', 'world']);
  });

  test('handles partial line without trailing newline', async () => {
    const stream = Readable.from(['abc']);
    const lines: string[] = [];
    for await (const line of mergeStreamsToLines(stream)) lines.push(line);
    assert.deepEqual(lines, ['abc']);
  });

  test('empty stream yields nothing', async () => {
    const stream = Readable.from([]);
    const lines: string[] = [];
    for await (const line of mergeStreamsToLines(stream)) lines.push(line);
    assert.deepEqual(lines, []);
  });

  test('splits multi-line chunk correctly', async () => {
    const stream = Readable.from(['line1\nline2\nline3\n']);
    const lines: string[] = [];
    for await (const line of mergeStreamsToLines(stream)) lines.push(line);
    assert.deepEqual(lines, ['line1', 'line2', 'line3']);
  });

  test('handles chunks split across newlines', async () => {
    // Two chunks that together form three lines
    const stream = Readable.from(['line1\nli', 'ne2\nline3\n']);
    const lines: string[] = [];
    for await (const line of mergeStreamsToLines(stream)) lines.push(line);
    assert.deepEqual(lines, ['line1', 'line2', 'line3']);
  });

  test('collects all lines from two streams', async () => {
    const s1 = Readable.from(['a\nb\n']);
    const s2 = Readable.from(['c\nd\n']);
    const lines: string[] = [];
    for await (const line of mergeStreamsToLines(s1, s2)) lines.push(line);
    assert.equal(lines.length, 4);
    assert.ok(lines.includes('a'));
    assert.ok(lines.includes('b'));
    assert.ok(lines.includes('c'));
    assert.ok(lines.includes('d'));
  });

  test('propagates stream errors', async () => {
    const stream = new Readable({ read() {} });
    const gen = mergeStreamsToLines(stream);
    const emitError = new Error('read failure');
    setImmediate(() => stream.emit('error', emitError));
    await assert.rejects(
      async () => { for await (const _ of gen) { /* drain */ } },
      (err: Error) => { assert.equal(err.message, 'read failure'); return true; },
    );
  });
});

// ----------------------------------------------------------------------------
// waitForExit
// ----------------------------------------------------------------------------

describe('waitForExit', () => {
  test('resolves 0 for a successful process', async () => {
    const proc = spawn('true', []);
    const code = await waitForExit(proc);
    assert.equal(code, 0);
  });

  test('resolves the exit code for a failing process', async () => {
    const proc = spawn('bash', ['-c', 'exit 42']);
    const code = await waitForExit(proc);
    assert.equal(code, 42);
  });
});
