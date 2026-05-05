// ============================================================================
// UPDATE CHECK + UPGRADE
// ============================================================================
// checkForUpdate: compares the current version against remote git tags.
// Uses git ls-remote so it reuses the user's existing git credentials —
// no extra auth setup needed for private repos.
//
// doUpdate: runs `npm install -g github:coston/executant` to upgrade in-place.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execPromise = promisify(exec);

/**
 * Returns the latest version string if it is newer than currentVersion,
 * otherwise null. Any error (offline, auth failure, timeout) is silently
 * swallowed so callers never need to handle failures.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  try {
    const { stdout } = await execPromise(
      'git ls-remote --tags https://github.com/coston/executant.git',
      { timeout: 5000 },
    );
    const versions = parseVersionsFromGitOutput(stdout);
    const latest = versions.sort(compareSemver).at(-1);
    return latest && isNewer(latest, currentVersion) ? latest : null;
  } catch {
    return null;
  }
}

/**
 * Installs the latest version from GitHub.
 * Resolves on success, rejects with stderr on failure.
 */
export async function doUpdate(): Promise<void> {
  await execPromise('npm install -g github:coston/executant');
}

/** Parses version strings from `git ls-remote --tags` stdout. Exported for testing. */
export function parseVersionsFromGitOutput(stdout: string): string[] {
  const versions: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/refs\/tags\/v?(\d+\.\d+\.\d+)$/);
    if (m) versions.push(m[1]);
  }
  return versions;
}

/** Returns positive if a > b, negative if a < b, 0 if equal. Exported for testing. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function isNewer(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}
