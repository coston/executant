// ============================================================================
// CLAUDE RUNNER — helper function tests
// ============================================================================
// Unit tests for the exported helper functions in tasks/claude.ts:
//   - isObject: type guard
//   - getArray: deep key traversal with fallback
//   - resolveClaudePath: throws when claude is not in PATH

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isObject, getArray, buildExitError, resolveClaudePath } from '../tasks/claude.js';

// ----------------------------------------------------------------------------
// isObject
// ----------------------------------------------------------------------------

describe('isObject', () => {
  test('returns true for a plain object', () => {
    assert.equal(isObject({ a: 1 }), true);
  });

  test('returns true for an empty object', () => {
    assert.equal(isObject({}), true);
  });

  test('returns false for null', () => {
    assert.equal(isObject(null), false);
  });

  test('returns false for an array', () => {
    assert.equal(isObject([1, 2, 3]), false);
  });

  test('returns false for a string', () => {
    assert.equal(isObject('hello'), false);
  });

  test('returns false for a number', () => {
    assert.equal(isObject(42), false);
  });

  test('returns false for undefined', () => {
    assert.equal(isObject(undefined), false);
  });
});

// ----------------------------------------------------------------------------
// getArray
// ----------------------------------------------------------------------------

describe('getArray', () => {
  test('returns the array at the given key path', () => {
    const obj = { message: { content: [1, 2, 3] } };
    assert.deepEqual(getArray(obj, 'message', 'content'), [1, 2, 3]);
  });

  test('returns empty array when intermediate key is missing', () => {
    const obj = { message: {} };
    assert.deepEqual(getArray(obj, 'message', 'content'), []);
  });

  test('returns empty array when root key is missing', () => {
    assert.deepEqual(getArray({}, 'message', 'content'), []);
  });

  test('returns empty array when value is not an array', () => {
    const obj = { content: 'not an array' };
    assert.deepEqual(getArray(obj, 'content'), []);
  });

  test('returns empty array when intermediate value is not an object', () => {
    const obj = { a: 'string' };
    assert.deepEqual(getArray(obj, 'a', 'b'), []);
  });

  test('returns the array when only one key is given', () => {
    const obj = { items: ['x', 'y'] };
    assert.deepEqual(getArray(obj, 'items'), ['x', 'y']);
  });

  test('returns empty array when intermediate value is null', () => {
    const obj = { a: null } as Record<string, unknown>;
    assert.deepEqual(getArray(obj, 'a', 'b'), []);
  });

  test('traverses three levels deep', () => {
    const obj = { a: { b: { c: [42] } } };
    assert.deepEqual(getArray(obj, 'a', 'b', 'c'), [42]);
  });

  test('returns empty array for empty keys list', () => {
    // No keys → result is the root object, which is not an array
    assert.deepEqual(getArray({ x: 1 }), []);
  });
});

// ----------------------------------------------------------------------------
// buildExitError
// ----------------------------------------------------------------------------

describe('buildExitError', () => {
  test('message contains exit code when no plain lines', () => {
    const err = buildExitError(1, []);
    assert.equal(err.message, 'claude exited with code 1');
  });

  test('appends single plain line to message', () => {
    const err = buildExitError(1, ["You've hit your limit · resets 11:30am"]);
    assert.equal(err.message, "claude exited with code 1\nYou've hit your limit · resets 11:30am");
  });

  test('appends multiple plain lines joined by newlines', () => {
    const err = buildExitError(2, ['line one', 'line two']);
    assert.equal(err.message, 'claude exited with code 2\nline one\nline two');
  });

  test('reflects non-1 exit codes', () => {
    const err = buildExitError(137, []);
    assert.ok(err.message.includes('code 137'));
  });
});

// ----------------------------------------------------------------------------
// resolveClaudePath — error path
// ----------------------------------------------------------------------------

describe('resolveClaudePath — PATH manipulation', () => {
  let originalPath: string;
  let mockDir: string;

  beforeEach(() => {
    originalPath = process.env['PATH'] ?? '';
    mockDir = join(tmpdir(), `claude-path-test-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
  });

  afterEach(() => {
    process.env['PATH'] = originalPath;
    rmSync(mockDir, { recursive: true, force: true });
  });

  test('returns the absolute path to the claude binary when found in PATH', () => {
    const mockBin = join(mockDir, 'claude');
    writeFileSync(mockBin, '#!/usr/bin/env bash\necho mock\n', 'utf8');
    chmodSync(mockBin, 0o755);
    process.env['PATH'] = `${mockDir}:${originalPath}`;

    const result = resolveClaudePath();
    assert.ok(result.includes('claude'), `Expected path to contain 'claude', got: ${result}`);
    assert.ok(result.startsWith('/'), `Expected absolute path, got: ${result}`);
  });

  test('throws with a helpful message when claude is not in PATH', () => {
    process.env['PATH'] = '/nonexistent-dir-12345';
    assert.throws(
      () => resolveClaudePath(),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected Error');
        assert.ok(err.message.includes('claude CLI not found'), `unexpected: ${err.message}`);
        return true;
      },
    );
  });
});
