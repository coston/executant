// ============================================================================
// UPDATE — unit tests
// ============================================================================
// Tests the pure functions in src/update.ts.
// checkForUpdate itself is not integration-tested here because it makes a
// real npm registry call; the pure logic it delegates to is fully covered.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import {
  compareSemver,
  isUpdateTimeout,
  runAutoUpdate,
  UPDATE_TIMEOUT_MS,
} from "../update.js";
import type { ChildProcess } from "node:child_process";

// ----------------------------------------------------------------------------
// compareSemver
// ----------------------------------------------------------------------------

describe("compareSemver", () => {
  test("returns 0 for equal versions", () => {
    assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  });

  test("returns positive when a has higher major", () => {
    assert.ok(compareSemver("2.0.0", "1.9.9") > 0);
  });

  test("returns negative when a has lower major", () => {
    assert.ok(compareSemver("1.0.0", "2.0.0") < 0);
  });

  test("compares minor correctly when major is equal", () => {
    assert.ok(compareSemver("1.2.0", "1.1.9") > 0);
    assert.ok(compareSemver("1.1.0", "1.2.0") < 0);
  });

  test("compares patch correctly when major and minor are equal", () => {
    assert.ok(compareSemver("1.0.2", "1.0.1") > 0);
    assert.ok(compareSemver("1.0.1", "1.0.2") < 0);
  });

  test("sort ascending produces correct order", () => {
    const versions = ["1.0.0", "0.2.0", "1.1.0", "0.1.0", "1.0.1"];
    const sorted = [...versions].sort(compareSemver);
    assert.deepEqual(sorted, ["0.1.0", "0.2.0", "1.0.0", "1.0.1", "1.1.0"]);
  });

  test("at(-1) after sort gives the latest version", () => {
    const versions = ["0.1.0", "1.0.0", "0.9.9"];
    const latest = [...versions].sort(compareSemver).at(-1);
    assert.equal(latest, "1.0.0");
  });
});

// ----------------------------------------------------------------------------
// checkForUpdate — pure logic via compareSemver
// ----------------------------------------------------------------------------

describe("checkForUpdate — pure logic via compareSemver", () => {
  // Simulates what checkForUpdate does with the npm version string
  function simulateCheck(
    npmVersion: string,
    currentVersion: string,
  ): string | null {
    const latest = npmVersion.trim();
    if (!latest) return null;
    return compareSemver(latest, currentVersion) > 0 ? latest : null;
  }

  test("returns null when already on the latest version", () => {
    assert.equal(simulateCheck("1.0.0", "1.0.0"), null);
  });

  test("returns null when current version is newer than npm", () => {
    assert.equal(simulateCheck("0.9.0", "1.0.0"), null);
  });

  test("returns latest version string when a newer version exists", () => {
    assert.equal(simulateCheck("1.2.0", "0.1.0"), "1.2.0");
  });

  test("returns null when npm version string is empty", () => {
    assert.equal(simulateCheck("", "0.1.0"), null);
  });

  test("returns null when versions are equal", () => {
    assert.equal(simulateCheck("1.1.0", "1.1.0"), null);
  });
});

// ----------------------------------------------------------------------------
// isUpdateTimeout — distinguishes a killed-by-timeout doUpdate() rejection
// from any other install failure (network error, npm registry error, etc.)
// ----------------------------------------------------------------------------

describe("isUpdateTimeout", () => {
  test("returns true for an error shaped like a timed-out exec (killed: true)", () => {
    assert.equal(isUpdateTimeout({ killed: true, signal: "SIGTERM" }), true);
  });

  test("returns false for a plain Error (e.g. npm exiting non-zero)", () => {
    assert.equal(
      isUpdateTimeout(new Error("Command failed: npm install -g executant")),
      false,
    );
  });

  test("returns false for an error object with killed: false", () => {
    assert.equal(isUpdateTimeout({ killed: false }), false);
  });

  test("returns false for killed: true without SIGTERM (e.g. a maxBuffer-style kill)", () => {
    assert.equal(isUpdateTimeout({ killed: true }), false);
    assert.equal(isUpdateTimeout({ killed: true, signal: "SIGKILL" }), false);
  });

  test("returns false for non-object values", () => {
    assert.equal(isUpdateTimeout("some string"), false);
    assert.equal(isUpdateTimeout(null), false);
    assert.equal(isUpdateTimeout(undefined), false);
  });

  test("UPDATE_TIMEOUT_MS is a sane positive bound used by doUpdate()", () => {
    assert.ok(UPDATE_TIMEOUT_MS > 0);
  });
});

// ----------------------------------------------------------------------------
// runAutoUpdate — the blocking check-install-reexec flow, with every real
// side effect (npm check, npm install, child_process.spawn, process.exit)
// injected so the orchestration logic is exercised without touching them.
// ----------------------------------------------------------------------------

type Spawn = typeof import("node:child_process").spawn;

/** A fake spawn() that emits 'exit' or 'error' on the next microtask. */
function fakeSpawn(
  outcome: { exitCode: number } | { spawnError: Error },
): Spawn {
  return ((..._args: unknown[]) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    queueMicrotask(() => {
      if ("spawnError" in outcome) {
        child.emit("error", outcome.spawnError);
      } else {
        child.emit("exit", outcome.exitCode, null);
      }
    });
    return child;
  }) as Spawn;
}

function collector() {
  const lines: string[] = [];
  return { fn: (msg: string) => lines.push(msg), lines };
}

describe("runAutoUpdate", () => {
  const argv = ["/usr/bin/node", "/usr/local/bin/executant", "workflow.yaml"];

  test("skips the check entirely when alreadyAttempted is true (bounds re-exec to one hop)", async () => {
    let checkCalls = 0;
    const result = await runAutoUpdate({
      currentVersion: "1.0.0",
      alreadyAttempted: true,
      argv,
      checkForUpdateFn: async () => {
        checkCalls++;
        return "2.0.0";
      },
    });
    assert.equal(checkCalls, 0);
    assert.deepEqual(result, { bannerVersion: null });
  });

  test("does nothing when already on the latest version", async () => {
    let doUpdateCalls = 0;
    const result = await runAutoUpdate({
      currentVersion: "1.0.0",
      alreadyAttempted: false,
      argv,
      checkForUpdateFn: async () => null,
      doUpdateFn: async () => {
        doUpdateCalls++;
      },
    });
    assert.equal(doUpdateCalls, 0);
    assert.deepEqual(result, { bannerVersion: null });
  });

  test("installs and re-execs on a newer version, forwarding the child exit code to exitFn", async () => {
    let exitCode: number | undefined;
    const result = await runAutoUpdate({
      currentVersion: "1.0.0",
      alreadyAttempted: false,
      argv,
      checkForUpdateFn: async () => "2.0.0",
      doUpdateFn: async () => {},
      spawnFn: fakeSpawn({ exitCode: 5 }),
      exitFn: (code) => {
        exitCode = code;
      },
      log: () => {},
      error: () => {},
    });
    assert.equal(exitCode, 5);
    assert.deepEqual(result, { bannerVersion: null });
  });

  test("falls back to the current version and surfaces a timeout-specific message when doUpdate times out", async () => {
    const errors = collector();
    const result = await runAutoUpdate({
      currentVersion: "1.0.0",
      alreadyAttempted: false,
      argv,
      checkForUpdateFn: async () => "2.0.0",
      doUpdateFn: async () => {
        const err = new Error("Command failed: npm install -g executant");
        Object.assign(err, { killed: true, signal: "SIGTERM" });
        throw err;
      },
      log: () => {},
      error: errors.fn,
    });
    assert.deepEqual(result, { bannerVersion: "2.0.0" });
    assert.ok(
      errors.lines.some((l) =>
        l.includes(`timed out after ${UPDATE_TIMEOUT_MS / 1000}s`),
      ),
    );
  });

  test("falls back to the current version on a non-timeout install failure", async () => {
    const errors = collector();
    const result = await runAutoUpdate({
      currentVersion: "1.0.0",
      alreadyAttempted: false,
      argv,
      checkForUpdateFn: async () => "2.0.0",
      doUpdateFn: async () => {
        throw new Error("registry unreachable");
      },
      log: () => {},
      error: errors.fn,
    });
    assert.deepEqual(result, { bannerVersion: "2.0.0" });
    assert.ok(errors.lines.some((l) => l.includes("registry unreachable")));
    assert.ok(!errors.lines.some((l) => l.includes("timed out")));
  });

  test("install succeeds but a failed re-exec spawn does not crash — falls back with no banner needed", async () => {
    const errors = collector();
    let exitCalled = false;
    const result = await runAutoUpdate({
      currentVersion: "1.0.0",
      alreadyAttempted: false,
      argv,
      checkForUpdateFn: async () => "2.0.0",
      doUpdateFn: async () => {},
      spawnFn: fakeSpawn({ spawnError: new Error("spawn EACCES") }),
      exitFn: () => {
        exitCalled = true;
      },
      log: () => {},
      error: errors.fn,
    });
    assert.equal(exitCalled, false);
    assert.deepEqual(result, { bannerVersion: null });
    assert.ok(
      errors.lines.some(
        (l) => l.includes("could not restart") && l.includes("spawn EACCES"),
      ),
    );
  });
});
