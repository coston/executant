// ============================================================================
// OPENCODE RUNNER — unit tests
// ============================================================================
// Tests for exported helpers in tasks/opencode.ts:
//   - buildOpenCodeArgs: args construction
//   - resolveOpenCodePath: binary detection
//   - runOpenCode: event stream from mock binary
//   - isObject: type guard

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOpenCodeArgs,
  resolveOpenCodePath,
  runOpenCode,
  isObject,
} from "../tasks/opencode.js";
import type { ClaudeTask } from "../types.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function installMockOpenCode(script: string): {
  mockDir: string;
  restorePath: () => void;
} {
  const mockDir = join(
    tmpdir(),
    `executant-mock-opencode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(mockDir, { recursive: true });
  const bin = join(mockDir, "opencode");
  writeFileSync(bin, `#!/usr/bin/env bash\n${script}`, "utf8");
  chmodSync(bin, 0o755);

  const original = process.env["PATH"] ?? "";
  process.env["PATH"] = `${mockDir}:${original}`;

  return {
    mockDir,
    restorePath: () => {
      process.env["PATH"] = original;
    },
  };
}

function baseTask(overrides: Partial<ClaudeTask> = {}): ClaudeTask {
  return {
    type: "claude",
    name: "test-step",
    prompt: "Do something",
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// buildOpenCodeArgs
// ----------------------------------------------------------------------------

describe("buildOpenCodeArgs", () => {
  const ORIGINAL_MODEL = process.env["EXECUTANT_MODEL"];
  const ORIGINAL_AGENT = process.env["EXECUTANT_AGENT"];

  beforeEach(() => {
    delete process.env["EXECUTANT_MODEL"];
    delete process.env["EXECUTANT_AGENT"];
  });

  afterEach(() => {
    if (ORIGINAL_MODEL !== undefined)
      process.env["EXECUTANT_MODEL"] = ORIGINAL_MODEL;
    else delete process.env["EXECUTANT_MODEL"];
    if (ORIGINAL_AGENT !== undefined)
      process.env["EXECUTANT_AGENT"] = ORIGINAL_AGENT;
    else delete process.env["EXECUTANT_AGENT"];
  });

  test("includes run --format json and the prompt", () => {
    const args = buildOpenCodeArgs(baseTask());
    assert.ok(args.includes("run"));
    assert.ok(args.includes("--format"));
    assert.ok(args.includes("json"));
    assert.equal(args[args.length - 1], "Do something");
  });

  test("includes --dangerously-skip-permissions for bypassPermissions (default)", () => {
    const args = buildOpenCodeArgs(baseTask());
    assert.ok(args.includes("--dangerously-skip-permissions"));
  });

  test("omits --dangerously-skip-permissions for default mode", () => {
    const args = buildOpenCodeArgs(baseTask({ permissionMode: "default" }));
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  });

  test("includes --model from task.model", () => {
    const args = buildOpenCodeArgs(
      baseTask({ model: "opencode-go/kimi-k2.6" }),
    );
    const idx = args.indexOf("--model");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "opencode-go/kimi-k2.6");
  });

  test("includes --model from EXECUTANT_MODEL env when task has no model", () => {
    process.env["EXECUTANT_MODEL"] = "opencode-go/deepseek-v4";
    const args = buildOpenCodeArgs(baseTask());
    const idx = args.indexOf("--model");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "opencode-go/deepseek-v4");
  });

  test("task.model takes priority over EXECUTANT_MODEL env", () => {
    process.env["EXECUTANT_MODEL"] = "opencode-go/deepseek-v4";
    const args = buildOpenCodeArgs(
      baseTask({ model: "opencode-go/kimi-k2.6" }),
    );
    const idx = args.indexOf("--model");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "opencode-go/kimi-k2.6");
  });

  test("omits --model when neither task.model nor EXECUTANT_MODEL is set", () => {
    const args = buildOpenCodeArgs(baseTask());
    assert.ok(!args.includes("--model"));
  });

  test("includes --agent from task.agent", () => {
    const args = buildOpenCodeArgs(baseTask({ agent: "build" }));
    const idx = args.indexOf("--agent");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "build");
  });

  test("includes --agent from EXECUTANT_AGENT env when task has no agent", () => {
    process.env["EXECUTANT_AGENT"] = "review";
    const args = buildOpenCodeArgs(baseTask());
    const idx = args.indexOf("--agent");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "review");
  });

  test("omits --agent when neither task.agent nor EXECUTANT_AGENT is set", () => {
    const args = buildOpenCodeArgs(baseTask());
    assert.ok(!args.includes("--agent"));
  });
});

// ----------------------------------------------------------------------------
// resolveOpenCodePath
// ----------------------------------------------------------------------------

describe("resolveOpenCodePath", () => {
  test("returns path when opencode binary is on PATH", () => {
    const { mockDir, restorePath } = installMockOpenCode("exit 0");
    try {
      const p = resolveOpenCodePath();
      assert.ok(p.startsWith(mockDir));
    } finally {
      restorePath();
    }
  });

  test("throws with install hint when opencode is not on PATH", () => {
    const original = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-path";
    try {
      assert.throws(
        () => resolveOpenCodePath(),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("opencode CLI not found"),
            `unexpected message: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      process.env["PATH"] = original;
    }
  });
});

// ----------------------------------------------------------------------------
// runOpenCode — integration with mock binary
// ----------------------------------------------------------------------------

describe("runOpenCode", () => {
  test("yields output:text events from text JSON messages", async () => {
    const { restorePath } = installMockOpenCode(
      `echo '{"type":"text","part":{"text":"hello from opencode"}}'
exit 0`,
    );
    try {
      const events = [];
      for await (const e of runOpenCode(baseTask())) events.push(e);
      const textEvents = events.filter((e) => e.type === "output:text");
      assert.ok(
        textEvents.some((e) => "text" in e && e.text === "hello from opencode"),
        `expected text event, got: ${JSON.stringify(textEvents)}`,
      );
    } finally {
      restorePath();
    }
  });

  test("yields output:tool events from tool_use JSON messages", async () => {
    const { restorePath } = installMockOpenCode(
      `echo '{"type":"tool_use","part":{"tool":"bash","state":{"input":{"command":"ls"}}}}'
exit 0`,
    );
    try {
      const events = [];
      for await (const e of runOpenCode(baseTask())) events.push(e);
      const toolEvents = events.filter((e) => e.type === "output:tool");
      assert.ok(
        toolEvents.some((e) => "tool" in e && e.tool === "Bash"),
        `expected tool event, got: ${JSON.stringify(toolEvents)}`,
      );
    } finally {
      restorePath();
    }
  });

  test("passes plain non-JSON lines through as output:text", async () => {
    const { restorePath } = installMockOpenCode(
      `echo 'plain text output'
exit 0`,
    );
    try {
      const events = [];
      for await (const e of runOpenCode(baseTask())) events.push(e);
      const textEvents = events.filter((e) => e.type === "output:text");
      assert.ok(
        textEvents.some((e) => "text" in e && e.text === "plain text output"),
        `expected plain text event, got: ${JSON.stringify(textEvents)}`,
      );
    } finally {
      restorePath();
    }
  });

  test("silently ignores unknown JSON event types", async () => {
    const { restorePath } = installMockOpenCode(
      `echo '{"type":"unknown_future_event","data":"whatever"}'
exit 0`,
    );
    try {
      const events = [];
      for await (const e of runOpenCode(baseTask())) events.push(e);
      // Only the log event from the start should exist — no crashes.
      const logEvents = events.filter((e) => e.type === "log");
      assert.ok(logEvents.length >= 1);
    } finally {
      restorePath();
    }
  });

  test("throws when opencode exits with non-zero code", async () => {
    const { restorePath } = installMockOpenCode(
      `echo 'something failed' >&2
exit 1`,
    );
    try {
      await assert.rejects(
        async () => {
          for await (const _ of runOpenCode(baseTask())) {
            /* consume */
          }
        },
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("opencode exited with code 1"),
            `unexpected message: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      restorePath();
    }
  });

  test("yields error message from error JSON events", async () => {
    const { restorePath } = installMockOpenCode(
      `echo '{"type":"error","error":{"message":"something went wrong"}}'
exit 0`,
    );
    try {
      const events = [];
      for await (const e of runOpenCode(baseTask())) events.push(e);
      const textEvents = events.filter((e) => e.type === "output:text");
      assert.ok(
        textEvents.some(
          (e) => "text" in e && e.text === "something went wrong",
        ),
        `expected error text event, got: ${JSON.stringify(textEvents)}`,
      );
    } finally {
      restorePath();
    }
  });
});

// ----------------------------------------------------------------------------
// isObject
// ----------------------------------------------------------------------------

describe("isObject", () => {
  test("returns true for plain objects", () => {
    assert.ok(isObject({ a: 1 }));
    assert.ok(isObject({}));
  });

  test("returns false for arrays", () => {
    assert.ok(!isObject([]));
    assert.ok(!isObject([1, 2]));
  });

  test("returns false for primitives and null", () => {
    assert.ok(!isObject(null));
    assert.ok(!isObject(undefined));
    assert.ok(!isObject("string"));
    assert.ok(!isObject(42));
    assert.ok(!isObject(true));
  });
});
