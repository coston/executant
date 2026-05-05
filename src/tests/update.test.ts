// ============================================================================
// UPDATE — unit tests
// ============================================================================
// Tests the pure functions in src/update.ts.
// checkForUpdate itself is not integration-tested here because it makes a
// real git ls-remote call; the pure logic it delegates to is fully covered.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareSemver, parseVersionsFromGitOutput } from '../update.js';

// ----------------------------------------------------------------------------
// parseVersionsFromGitOutput
// ----------------------------------------------------------------------------

describe('parseVersionsFromGitOutput', () => {
  test('extracts versions from standard ls-remote output', () => {
    const stdout = [
      'abc123\trefs/tags/v0.1.0',
      'def456\trefs/tags/v0.2.0',
      'ghi789\trefs/tags/v1.0.0',
    ].join('\n');
    assert.deepEqual(parseVersionsFromGitOutput(stdout), ['0.1.0', '0.2.0', '1.0.0']);
  });

  test('strips leading v from tag names', () => {
    const stdout = 'abc\trefs/tags/v1.2.3\n';
    assert.deepEqual(parseVersionsFromGitOutput(stdout), ['1.2.3']);
  });

  test('accepts tags without leading v', () => {
    const stdout = 'abc\trefs/tags/1.2.3\n';
    assert.deepEqual(parseVersionsFromGitOutput(stdout), ['1.2.3']);
  });

  test('ignores annotated tag dereference lines (^{})', () => {
    // git ls-remote --tags emits both the tag object and the commit it points to
    const stdout = [
      'abc\trefs/tags/v1.0.0',
      'def\trefs/tags/v1.0.0^{}',
    ].join('\n');
    assert.deepEqual(parseVersionsFromGitOutput(stdout), ['1.0.0']);
  });

  test('ignores non-version tags', () => {
    const stdout = [
      'abc\trefs/tags/v1.0.0',
      'def\trefs/tags/latest',
      'ghi\trefs/tags/stable',
      'jkl\trefs/tags/v2.0.0',
    ].join('\n');
    assert.deepEqual(parseVersionsFromGitOutput(stdout), ['1.0.0', '2.0.0']);
  });

  test('returns empty array for empty output', () => {
    assert.deepEqual(parseVersionsFromGitOutput(''), []);
  });

  test('returns empty array for output with no matching tags', () => {
    const stdout = 'abc\trefs/heads/main\ndef\trefs/tags/latest\n';
    assert.deepEqual(parseVersionsFromGitOutput(stdout), []);
  });
});

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
// checkForUpdate integration via pure logic
// ----------------------------------------------------------------------------

describe('checkForUpdate — pure logic via parseVersionsFromGitOutput + compareSemver', () => {
  // Simulates what checkForUpdate does with real ls-remote output
  function simulateCheck(stdout: string, currentVersion: string): string | null {
    const versions = parseVersionsFromGitOutput(stdout);
    const latest = versions.sort(compareSemver).at(-1);
    if (!latest) return null;
    return compareSemver(latest, currentVersion) > 0 ? latest : null;
  }

  test('returns null when already on the latest version', () => {
    const stdout = 'abc\trefs/tags/v1.0.0\n';
    assert.equal(simulateCheck(stdout, '1.0.0'), null);
  });

  test('returns null when current version is newer than any tag', () => {
    const stdout = 'abc\trefs/tags/v0.9.0\n';
    assert.equal(simulateCheck(stdout, '1.0.0'), null);
  });

  test('returns latest version string when a newer tag exists', () => {
    const stdout = [
      'abc\trefs/tags/v0.1.0',
      'def\trefs/tags/v1.0.0',
      'ghi\trefs/tags/v1.2.0',
    ].join('\n');
    assert.equal(simulateCheck(stdout, '0.1.0'), '1.2.0');
  });

  test('returns null when output is empty (no releases yet)', () => {
    assert.equal(simulateCheck('', '0.1.0'), null);
  });

  test('picks the highest semver tag, not the last in output order', () => {
    const stdout = [
      'abc\trefs/tags/v1.2.0',
      'def\trefs/tags/v0.9.0',
      'ghi\trefs/tags/v1.1.0',
    ].join('\n');
    assert.equal(simulateCheck(stdout, '0.1.0'), '1.2.0');
  });
});
