// ============================================================================
// UTILS — unit tests
// ============================================================================
// Tests for src/lib/utils.ts: stripPromptHeader, loadPrompt, slugify,
// extractJsonObject, formatTimestamp.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  stripPromptHeader,
  loadPrompt,
  slugify,
  extractJsonObject,
  formatTimestamp,
} from '../lib/utils.js';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

// ----------------------------------------------------------------------------
// stripPromptHeader
// ----------------------------------------------------------------------------

describe('stripPromptHeader', () => {
  test('strips a single # comment line', () => {
    const input = '# header\n\ncontent';
    assert.equal(stripPromptHeader(input), 'content');
  });

  test('strips multiple consecutive # comment lines', () => {
    const input = '# line1\n# line2\n# line3\n\ncontent here';
    assert.equal(stripPromptHeader(input), 'content here');
  });

  test('strips the separating blank line after the comment block', () => {
    const input = '# ===========\n# Purpose: x\n# ===========\n\nActual prompt content.';
    assert.equal(stripPromptHeader(input), 'Actual prompt content.');
  });

  test('strips a realistic prompt file header', () => {
    const input = [
      '# ============================================================================',
      '# JUDGE EVALUATION',
      '# ============================================================================',
      '# Purpose: Evaluate whether a workflow step output is complete.',
      '# Used by: src/runner.ts',
      '# ============================================================================',
      '',
      'You are a quality evaluation judge.',
    ].join('\n');
    assert.equal(stripPromptHeader(input), 'You are a quality evaluation judge.');
  });

  test('leaves content unchanged when there is no # header', () => {
    const input = 'No header here\njust content';
    assert.equal(stripPromptHeader(input), 'No header here\njust content');
  });

  test('handles content that starts with # mid-file (only strips leading block)', () => {
    const input = '# header\n\n## Section\n# not stripped';
    assert.equal(stripPromptHeader(input), '## Section\n# not stripped');
  });

  test('trims leading/trailing whitespace from result', () => {
    const input = '# header\n\n  content with surrounding space  ';
    assert.equal(stripPromptHeader(input), 'content with surrounding space');
  });

  test('handles empty string without throwing', () => {
    assert.equal(stripPromptHeader(''), '');
  });

  test('handles only a comment block with no content', () => {
    assert.equal(stripPromptHeader('# header\n'), '');
  });
});

// ----------------------------------------------------------------------------
// loadPrompt — integration: verify all prompt files load cleanly
// ----------------------------------------------------------------------------

describe('loadPrompt', () => {
  const promptFiles = readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => f.replace('.txt', ''));

  test('loads all prompt files without throwing', () => {
    for (const name of promptFiles) {
      assert.doesNotThrow(() => loadPrompt(name), `loadPrompt('${name}') threw`);
    }
  });

  test('no loaded prompt starts with a # character', () => {
    for (const name of promptFiles) {
      const content = loadPrompt(name);
      assert.ok(
        !content.startsWith('#'),
        `loadPrompt('${name}') still starts with '#': ${content.slice(0, 60)}`,
      );
    }
  });

  test('no loaded prompt has leading whitespace', () => {
    for (const name of promptFiles) {
      const content = loadPrompt(name);
      assert.equal(
        content,
        content.trimStart(),
        `loadPrompt('${name}') has leading whitespace`,
      );
    }
  });

  test('all loaded prompts are non-empty', () => {
    for (const name of promptFiles) {
      const content = loadPrompt(name);
      assert.ok(content.length > 0, `loadPrompt('${name}') returned empty string`);
    }
  });

  test('throws on non-existent prompt file', () => {
    assert.throws(() => loadPrompt('does-not-exist'), /ENOENT/);
  });
});

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
    assert.equal(slugify('a'.repeat(30)).length, 20);
  });

  test('respects custom maxLen', () => {
    assert.equal(slugify('hello world', 5).length, 5);
  });
});

// ----------------------------------------------------------------------------
// extractJsonObject
// ----------------------------------------------------------------------------

describe('extractJsonObject', () => {
  test('extracts JSON from markdown code fence', () => {
    const input = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
    assert.equal(extractJsonObject(input), '{"key": "value"}');
  });

  test('extracts JSON from plain text with surrounding prose', () => {
    const input = 'Result: {"foo": 1} end';
    assert.equal(extractJsonObject(input), '{"foo": 1}');
  });

  test('returns trimmed text when no JSON found', () => {
    assert.equal(extractJsonObject('  no json here  '), 'no json here');
  });

  test('handles nested objects', () => {
    const input = '{"outer": {"inner": 1}}';
    assert.equal(extractJsonObject(input), '{"outer": {"inner": 1}}');
  });
});

// ----------------------------------------------------------------------------
// formatTimestamp
// ----------------------------------------------------------------------------

describe('formatTimestamp', () => {
  test('formats date to YYYYMMDD-HHMMSS', () => {
    const d = new Date(2026, 0, 5, 9, 3, 7); // Jan 5 2026, 09:03:07
    assert.equal(formatTimestamp(d), '20260105-090307');
  });

  test('pads single-digit month, day, hour, minute, second', () => {
    const d = new Date(2026, 0, 1, 1, 1, 1);
    assert.equal(formatTimestamp(d), '20260101-010101');
  });
});
