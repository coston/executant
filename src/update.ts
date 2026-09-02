// ============================================================================
// UPDATE CHECK + UPGRADE
// ============================================================================
// checkForUpdate: compares the current version against the npm registry.
// doUpdate: runs `npm install -g executant` to upgrade in-place.
// runAutoUpdate: the blocking check-install-reexec flow used at CLI startup.

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getErrorMessage } from "./lib/utils.js";

const execPromise = promisify(exec);

/**
 * Returns the latest version string if it is newer than currentVersion,
 * otherwise null. Any error (offline, timeout) is silently swallowed.
 */
export async function checkForUpdate(
  currentVersion: string,
): Promise<string | null> {
  try {
    const { stdout } = await execPromise("npm view executant version", {
      timeout: 5000,
    });
    const latest = stdout.trim();
    return latest && isNewer(latest, currentVersion) ? latest : null;
  } catch {
    return null;
  }
}

/** Max time to wait for `npm install -g` before giving up on the update. */
export const UPDATE_TIMEOUT_MS = 30_000;

/**
 * Installs the latest version from npm.
 * Resolves on success, rejects (including on timeout) with stderr on failure —
 * callers should fall back to the currently running version rather than block
 * indefinitely on a stalled network or registry.
 */
export async function doUpdate(): Promise<void> {
  await execPromise("npm install -g executant", {
    timeout: UPDATE_TIMEOUT_MS,
    // A verbose install (deprecation notices, peer-dep warnings) can exceed
    // Node's 1MB default before UPDATE_TIMEOUT_MS elapses; without headroom
    // that buffer kill looks identical to a real timeout (both set `killed`).
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** True when a doUpdate() rejection was caused by hitting UPDATE_TIMEOUT_MS. */
export function isUpdateTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { killed?: boolean; signal?: string }).killed === true &&
    (err as { signal?: string }).signal === "SIGTERM"
  );
}

/**
 * Re-execs `argv` (`[nodePath, scriptPath, ...args]`) as a child process with
 * inherited stdio, marking it as an already-attempted auto-update so it never
 * loops back into runAutoUpdate. Resolves with the child's exit code; rejects
 * if the child could not be spawned at all.
 */
function reexec(
  argv: readonly string[],
  spawnFn: typeof spawn,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnFn(argv[0], argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, EXECUTANT_AUTO_UPDATED: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolvePromise(code ?? (signal ? 1 : 0)),
    );
  });
}

interface AutoUpdateOptions {
  /** The version currently running (src/version.ts's CURRENT_VERSION). */
  currentVersion: string;
  /**
   * True when this process is itself the result of a prior auto-update
   * re-exec (EXECUTANT_AUTO_UPDATED=1). Skips the check entirely, bounding
   * the flow to a single hop — otherwise a `doUpdate()` that "succeeds" but
   * can't actually replace the running binary (a dev checkout, a global
   * install path that doesn't match npm's, ...) would loop forever, each
   * iteration re-detecting the same "newer" version and re-execing.
   */
  alreadyAttempted: boolean;
  /** `[nodePath, scriptPath, ...cliArgs]` to re-exec on a successful install. */
  argv: readonly string[];
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  /** Test seams — default to the real implementations above. */
  checkForUpdateFn?: typeof checkForUpdate;
  doUpdateFn?: typeof doUpdate;
  spawnFn?: typeof spawn;
  /** Test seam — default to the real process.exit. */
  exitFn?: (code: number) => void;
}

/**
 * The blocking check-install-reexec flow run at CLI startup (see index.ts).
 * On a successful install this calls `exitFn` with the re-exec'd child's exit
 * code and does not resolve further meaningfully (in production `exitFn` is
 * `process.exit`, which terminates the process). On any other outcome it
 * resolves with the version to show in the "update available" banner, or
 * null when no banner is needed.
 */
export async function runAutoUpdate(
  opts: AutoUpdateOptions,
): Promise<{ bannerVersion: string | null }> {
  const {
    currentVersion,
    alreadyAttempted,
    argv,
    log = console.log,
    error = console.error,
    checkForUpdateFn = checkForUpdate,
    doUpdateFn = doUpdate,
    spawnFn = spawn,
    exitFn = process.exit,
  } = opts;

  if (alreadyAttempted) return { bannerVersion: null };

  const newer = await checkForUpdateFn(currentVersion);
  if (!newer) return { bannerVersion: null };

  log(`executant v${newer} available — updating...`);
  try {
    await doUpdateFn();
  } catch (err) {
    const reason = isUpdateTimeout(err)
      ? `timed out after ${UPDATE_TIMEOUT_MS / 1000}s`
      : getErrorMessage(err);
    error(
      `Auto-update to v${newer} failed (${reason}), continuing with v${currentVersion}`,
    );
    return { bannerVersion: newer };
  }

  log(`Updated to v${newer}. Restarting...`);
  try {
    const exitCode = await reexec(argv, spawnFn);
    exitFn(exitCode);
  } catch (err) {
    error(
      `Updated to v${newer} but could not restart automatically (${getErrorMessage(err)}) — ` +
        `continuing with v${currentVersion}; the next run will use v${newer}.`,
    );
  }
  return { bannerVersion: null };
}

/** Returns positive if a > b, negative if a < b, 0 if equal. Exported for testing. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function isNewer(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}
