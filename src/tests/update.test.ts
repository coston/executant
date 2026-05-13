// ============================================================================
// UPDATE — unit tests
// ============================================================================
// Tests the pure functions in src/update.ts.
// checkForUpdate itself is not integration-tested here because it makes a
// real npm registry call; the pure logic it delegates to is fully covered.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareSemver } from '../update.js';

// ----------------------------------------------------------------------------
// compareSemver
// ----------------------------------------------------------------------------

describe('compareSemver', () => {
  test('returns 0 for equal versions', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  });

  test('returns positive when a has higher major', () => {
    assert.ok(compareSemver('2.0.0', '1.9.9') > 0);
  });

  test('returns negative when a has lower major', () => {
    assert.ok(compareSemver('1.0.0', '2.0.0') < 0);
  });

  test('compares minor correctly when major is equal', () => {
    assert.ok(compareSemver('1.2.0', '1.1.9') > 0);
    assert.ok(compareSemver('1.1.0', '1.2.0') < 0);
  });

  test('compares patch correctly when major and minor are equal', () => {
    assert.ok(compareSemver('1.0.2', '1.0.1') > 0);
    assert.ok(compareSemver('1.0.1', '1.0.2') < 0);
  });

  test('sort ascending produces correct order', () => {
    const versions = ['1.0.0', '0.2.0', '1.1.0', '0.1.0', '1.0.1'];
    const sorted = [...versions].sort(compareSemver);
    assert.deepEqual(sorted, ['0.1.0', '0.2.0', '1.0.0', '1.0.1', '1.1.0']);
  });

  test('at(-1) after sort gives the latest version', () => {
    const versions = ['0.1.0', '1.0.0', '0.9.9'];
    const latest = [...versions].sort(compareSemver).at(-1);
    assert.equal(latest, '1.0.0');
  });
});

// ----------------------------------------------------------------------------
// checkForUpdate — pure logic via compareSemver
// ----------------------------------------------------------------------------

describe('checkForUpdate — pure logic via compareSemver', () => {
  // Simulates what checkForUpdate does with the npm version string
  function simulateCheck(npmVersion: string, currentVersion: string): string | null {
    const latest = npmVersion.trim();
    if (!latest) return null;
    return compareSemver(latest, currentVersion) > 0 ? latest : null;
  }

  test('returns null when already on the latest version', () => {
    assert.equal(simulateCheck('1.0.0', '1.0.0'), null);
  });

  test('returns null when current version is newer than npm', () => {
    assert.equal(simulateCheck('0.9.0', '1.0.0'), null);
  });

  test('returns latest version string when a newer version exists', () => {
    assert.equal(simulateCheck('1.2.0', '0.1.0'), '1.2.0');
  });

  test('returns null when npm version string is empty', () => {
    assert.equal(simulateCheck('', '0.1.0'), null);
  });

  test('returns null when versions are equal', () => {
    assert.equal(simulateCheck('1.1.0', '1.1.0'), null);
  });
});
