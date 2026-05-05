// ============================================================================
// THEME — unit tests
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { theme } from '../ui/theme.js';

const HEX_RE = /^#[0-9a-f]{6}$/i;

describe('theme', () => {
  test('all keys are present', () => {
    const keys = ['foreground', 'muted', 'primary', 'primaryLight', 'success', 'error', 'warning', 'border'] as const;
    for (const key of keys) {
      assert.ok(key in theme, `missing key: ${key}`);
    }
  });

  test('all values are valid hex colors', () => {
    for (const [key, value] of Object.entries(theme)) {
      assert.match(value, HEX_RE, `${key}: "${value}" is not a valid hex color`);
    }
  });

  test('colors are meaningfully distinct', () => {
    const values = Object.values(theme);
    const unique = new Set(values);
    assert.ok(unique.size >= 5, `expected at least 5 distinct colors, got ${unique.size}`);
  });
});
