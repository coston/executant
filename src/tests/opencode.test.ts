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
  buildOpenCodePermissionEnv,
  resolveOpenCodePath,
  runOpenCode,
  runOpenCodeStructured,
  isObject,
} from "../tasks/opencode.js";
import type { ClaudeTask } from "../types.js";
import { z } from "zod";

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
      baseTask({ model: "llama-qwen7b/qwen2.5-coder-7b" }),
    );
    const idx = args.indexOf("--model");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "llama-qwen7b/qwen2.5-coder-7b");
  });

  test("includes --model from EXECUTANT_MODEL env when task has no model", () => {
    process.env["EXECUTANT_MODEL"] = "llama-llama8b/llama-3.1-8b";
    const args = buildOpenCodeArgs(baseTask());
    const idx = args.indexOf("--model");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "llama-llama8b/llama-3.1-8b");
  });

  test("task.model takes priority over EXECUTANT_MODEL env", () => {
    process.env["EXECUTANT_MODEL"] = "llama-llama8b/llama-3.1-8b";
    const args = buildOpenCodeArgs(
      baseTask({ model: "llama-qwen7b/qwen2.5-coder-7b" }),
    );
    const idx = args.indexOf("--model");
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], "llama-qwen7b/qwen2.5-coder-7b");
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
// runOpenCodeStructured
// ----------------------------------------------------------------------------

describe("runOpenCodeStructured", () => {
  const schema = z.object({ answer: z.string() });

  test("returns parsed object when model outputs valid JSON", async () => {
    // Use \\" so the bash script contains \" (literal backslash+quote in single-quoted string)
    // which JSON.parse will decode to " inside the part.text string value.
    const { restorePath } = installMockOpenCode(
      `echo '{"type":"text","part":{"text":"{\\"answer\\":\\"hello\\"}"}}'\nexit 0`,
    );
    try {
      const result = await runOpenCodeStructured(baseTask(), schema);
      assert.equal(result.answer, "hello");
    } finally {
      restorePath();
    }
  });

  test("throws descriptive error when model produces no output", async () => {
    const { restorePath } = installMockOpenCode("exit 0");
    try {
      await assert.rejects(
        () => runOpenCodeStructured(baseTask(), schema),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("no output"),
            `unexpected message: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      restorePath();
    }
  });

  test("throws descriptive error when output is plain text with no JSON", async () => {
    const { restorePath } = installMockOpenCode(
      `echo '{"type":"text","part":{"text":"rate limit exceeded"}}'
exit 0`,
    );
    try {
      await assert.rejects(
        () => runOpenCodeStructured(baseTask(), schema),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("did not return a JSON object") ||
              err.message.toLowerCase().includes("json"),
            `unexpected message: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      restorePath();
    }
  });

  test("throws when schema validation fails", async () => {
    const { restorePath } = installMockOpenCode(
      `echo '{"type":"text","part":{"text":"{\"wrong_field\":42}"}}'
exit 0`,
    );
    try {
      await assert.rejects(
        () => runOpenCodeStructured(baseTask(), schema),
        (err) => {
          assert.ok(err instanceof Error);
          return true;
        },
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

describe("buildOpenCodePermissionEnv", () => {
  test("returns undefined when allowedTools is undefined (unrestricted)", () => {
    assert.equal(buildOpenCodePermissionEnv(undefined), undefined);
  });

  test("returns deny-all JSON when allowedTools is empty (text-only mode)", () => {
    const result = buildOpenCodePermissionEnv([]);
    assert.ok(result);
    const rules = JSON.parse(result!);
    assert.ok(Array.isArray(rules));
    assert.ok(rules.every((r: { action: string }) => r.action === "deny"));
    assert.ok(
      rules.some((r: { permission: string }) => r.permission === "bash"),
    );
    assert.ok(
      rules.some((r: { permission: string }) => r.permission === "read"),
    );
    assert.ok(
      rules.some((r: { permission: string }) => r.permission === "webfetch"),
    );
  });

  test("denies only tools not in the allowed list", () => {
    const result = buildOpenCodePermissionEnv(["bash", "read"]);
    assert.ok(result);
    const rules = JSON.parse(result!) as {
      permission: string;
      action: string;
    }[];
    const denied = new Set(rules.map((r) => r.permission));
    assert.ok(!denied.has("bash"), "bash should not be denied");
    assert.ok(!denied.has("read"), "read should not be denied");
    assert.ok(denied.has("edit"), "edit should be denied");
    assert.ok(denied.has("webfetch"), "webfetch should be denied");
  });

  test("is case-insensitive — Claude-style names ('Bash', 'Read') work", () => {
    const result = buildOpenCodePermissionEnv(["Bash", "Read"]);
    assert.ok(result);
    const rules = JSON.parse(result!) as {
      permission: string;
      action: string;
    }[];
    const denied = new Set(rules.map((r) => r.permission));
    assert.ok(!denied.has("bash"));
    assert.ok(!denied.has("read"));
    assert.ok(denied.has("edit"));
  });

  test("returns undefined when all tools are explicitly allowed", () => {
    const allTools = [
      "bash",
      "read",
      "edit",
      "write",
      "glob",
      "grep",
      "webfetch",
      "websearch",
      "task",
      "skill",
      "lsp",
      "todowrite",
      "question",
      "external_directory",
      "doom_loop",
    ];
    assert.equal(buildOpenCodePermissionEnv(allTools), undefined);
  });
});
