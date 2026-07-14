// ============================================================================
// TRACE CONTEXT TESTS (TRACEPARENT propagation)
// ============================================================================
// Tests the trace-context registry (src/lib/trace-context.ts) and that every
// spawn site — command.ts, claude.ts, opencode.ts, and the forEach item
// resolution shell in runner.ts — injects TRACEPARENT into the child-process
// env when the registry is set, and leaves the env untouched when it is not.
//
// Uses mock claude/opencode binaries installed into temp dirs prepended to
// PATH; the mocks dump their $TRACEPARENT to a sidecar file for assertions.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import {
  getTraceparent,
  setTraceparent,
  traceparentEnv,
} from "../lib/trace-context.js";
import type { Workflow } from "../types.js";
import { collectEvents, installMockClaude, tmpDir } from "./helpers.js";

const TRACEPARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

function singleStepWorkflow(task: Workflow["tasks"][number]): Workflow {
  return { goal: "trace context test", tasks: [task] };
}

/** Runs `command` as a workflow step and returns its output:text lines. */
async function commandOutput(command: string): Promise<string[]> {
  const events = await collectEvents(
    singleStepWorkflow({ type: "command", name: "probe", command }),
  );
  return events.flatMap((e) => (e.type === "output:text" ? [e.text] : []));
}

/**
 * Installs a mock opencode binary that dumps its $TRACEPARENT to a sidecar
 * file, emits nothing, and exits 0.
 */
function installMockOpenCode(traceparentFile: string): void {
  const mockDir = tmpDir();
  const bin = join(mockDir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\nprintf '%s' "$TRACEPARENT" > "${traceparentFile}"\nexit 0\n`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  process.env["PATH"] = `${mockDir}:${process.env["PATH"] ?? ""}`;
}

// Top-level wrapper serialises all describe blocks: sibling describes can run
// concurrently, which would leak the shared registry and process.env
// mutations between them.
describe("trace context", { concurrency: 1 }, () => {
  let originalPath: string;
  let originalTraceparent: string | undefined;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    // A TRACEPARENT inherited from the developer's shell would flow through
    // the { ...process.env } spread and break the "unset" assertions.
    originalTraceparent = process.env["TRACEPARENT"];
    delete process.env["TRACEPARENT"];
    setTraceparent(undefined);
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    if (originalTraceparent === undefined) delete process.env["TRACEPARENT"];
    else process.env["TRACEPARENT"] = originalTraceparent;
    setTraceparent(undefined);
  });

  // --------------------------------------------------------------------------
  // Registry
  // --------------------------------------------------------------------------

  describe("registry", () => {
    test("getTraceparent returns undefined until set", () => {
      assert.equal(getTraceparent(), undefined);
    });

    test("setTraceparent stores the value and undefined clears it", () => {
      setTraceparent(TRACEPARENT);
      assert.equal(getTraceparent(), TRACEPARENT);
      setTraceparent(undefined);
      assert.equal(getTraceparent(), undefined);
    });

    test("traceparentEnv returns the TRACEPARENT fragment when set", () => {
      setTraceparent(TRACEPARENT);
      assert.deepEqual(traceparentEnv(), { TRACEPARENT });
    });

    test("traceparentEnv returns an empty object when unset", () => {
      assert.deepEqual(traceparentEnv(), {});
    });
  });

  // --------------------------------------------------------------------------
  // command step spawn env
  // --------------------------------------------------------------------------

  describe("command step", () => {
    test("subprocess sees TRACEPARENT when the registry is set", async () => {
      setTraceparent(TRACEPARENT);
      const lines = await commandOutput('echo "tp=$TRACEPARENT"');
      assert.ok(
        lines.includes(`tp=${TRACEPARENT}`),
        `Expected "tp=${TRACEPARENT}" in ${JSON.stringify(lines)}`,
      );
    });

    test("subprocess sees no TRACEPARENT when the registry is unset", async () => {
      const lines = await commandOutput('echo "tp=$TRACEPARENT"');
      assert.ok(
        lines.includes("tp="),
        `Expected empty "tp=" in ${JSON.stringify(lines)}`,
      );
    });
  });

  // --------------------------------------------------------------------------
  // forEach item resolution spawn env
  // --------------------------------------------------------------------------

  describe("forEach item resolution", () => {
    const workflow = () =>
      singleStepWorkflow({
        type: "forEach",
        name: "iterate",
        forEach: 'echo "tp=$TRACEPARENT"',
        inner: [{ type: "log", name: "noop", message: "item: {{item}}" }],
      });

    /** Runs the workflow and returns the resolved iteration items. */
    async function resolvedItems(): Promise<string[]> {
      const events = await collectEvents(workflow());
      return events.flatMap((e) =>
        e.type === "step:iteration" ? [e.item] : [],
      );
    }

    test("the resolution command sees TRACEPARENT when the registry is set", async () => {
      setTraceparent(TRACEPARENT);
      assert.deepEqual(await resolvedItems(), [`tp=${TRACEPARENT}`]);
    });

    test("the resolution command sees no TRACEPARENT when the registry is unset", async () => {
      assert.deepEqual(await resolvedItems(), ["tp="]);
    });
  });

  // --------------------------------------------------------------------------
  // claude step spawn env
  // --------------------------------------------------------------------------

  describe("claude step", () => {
    const workflow = () =>
      singleStepWorkflow({ type: "claude", name: "probe", prompt: "Do X." });

    test("subprocess sees TRACEPARENT when the registry is set", async () => {
      const traceparentFile = join(tmpDir(), "traceparent.txt");
      installMockClaude({ traceparentFile });
      setTraceparent(TRACEPARENT);

      await collectEvents(workflow());
      assert.equal(readFileSync(traceparentFile, "utf8"), TRACEPARENT);
    });

    test("subprocess sees no TRACEPARENT when the registry is unset", async () => {
      const traceparentFile = join(tmpDir(), "traceparent.txt");
      installMockClaude({ traceparentFile });

      await collectEvents(workflow());
      assert.equal(readFileSync(traceparentFile, "utf8"), "");
    });
  });

  // --------------------------------------------------------------------------
  // opencode step spawn env
  // --------------------------------------------------------------------------

  describe("opencode step", () => {
    const workflow = () =>
      singleStepWorkflow({
        type: "claude",
        name: "probe",
        prompt: "Do X.",
        provider: "opencode",
      });

    test("subprocess sees TRACEPARENT when the registry is set", async () => {
      const traceparentFile = join(tmpDir(), "traceparent.txt");
      installMockOpenCode(traceparentFile);
      setTraceparent(TRACEPARENT);

      await collectEvents(workflow());
      assert.equal(readFileSync(traceparentFile, "utf8"), TRACEPARENT);
    });

    test("subprocess sees no TRACEPARENT when the registry is unset", async () => {
      const traceparentFile = join(tmpDir(), "traceparent.txt");
      installMockOpenCode(traceparentFile);

      await collectEvents(workflow());
      assert.equal(readFileSync(traceparentFile, "utf8"), "");
    });
  });
});
