// ============================================================================
// UPDATE CHECK + UPGRADE
// ============================================================================
// checkForUpdate: compares the current version against the npm registry.
// doUpdate: runs `npm install -g executant` to upgrade in-place.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execPromise = promisify(exec);

/**
 * Returns the latest version string if it is newer than currentVersion,
 * otherwise null. Any error (offline, timeout) is silently swallowed.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  try {
    const { stdout } = await execPromise('npm view executant version', { timeout: 5000 });
    const latest = stdout.trim();
    return latest && isNewer(latest, currentVersion) ? latest : null;
  } catch {
    return null;
  }
}

/**
 * Installs the latest version from npm.
 * Resolves on success, rejects with stderr on failure.
 */
export async function doUpdate(): Promise<void> {
  await execPromise('npm install -g executant');
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
