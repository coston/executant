// ============================================================================
// CLAUDE RUNNER — helper function tests
// ============================================================================
// Unit tests for the exported helpers in tasks/claude.ts:
//   - METHODOLOGY: content integrity checks
//   - buildClaudeArgs: args construction and methodology injection
//   - isObject, getArray, buildExitError, resolveClaudePath

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  METHODOLOGY,
  buildClaudeArgs,
  isObject,
  getArray,
  buildExitError,
  resolveClaudePath,
  runClaude,
} from "../tasks/claude.js";
import type { OutputContextEvent, OutputUsageEvent } from "../types.js";

// ----------------------------------------------------------------------------
// METHODOLOGY — content integrity
// ----------------------------------------------------------------------------

describe("METHODOLOGY", () => {
  test("is non-empty", () => {
    assert.ok(METHODOLOGY.length > 0, "METHODOLOGY must not be empty");
  });

  test("contains Verification loop section", () => {
    assert.ok(
      METHODOLOGY.includes("Verification loop"),
      "missing Verification loop section",
    );
  });

  test("defines lint → typecheck → test → build in verification loop order", () => {
    const li = METHODOLOGY.indexOf("1. lint");
    const tc = METHODOLOGY.indexOf("2. typecheck");
    const te = METHODOLOGY.indexOf("3. test");
    const bu = METHODOLOGY.indexOf("4. build");
    assert.ok(li !== -1, '"1. lint" not found in verification loop');
    assert.ok(li < tc, "lint must precede typecheck");
    assert.ok(tc < te, "typecheck must precede test");
    assert.ok(te < bu, "test must precede build");
  });

  test("contains knowledge acquisition guidance", () => {
    assert.ok(
      METHODOLOGY.includes("documentation") ||
        METHODOLOGY.includes("Knowledge"),
      "missing knowledge acquisition section",
    );
  });

  test("contains decomposition guidance", () => {
    assert.ok(
      METHODOLOGY.includes("Decomposition") || METHODOLOGY.includes("slice"),
      "missing decomposition guidance",
    );
  });

  test("contains tests-first guidance", () => {
    assert.ok(
      METHODOLOGY.includes("failing tests") ||
        METHODOLOGY.includes("Test loop"),
      "missing tests-first guidance",
    );
  });

  test('starts with "Critical rules" after header stripping', () => {
    assert.ok(
      METHODOLOGY.startsWith("Critical rules"),
      `unexpected start — header may not have been stripped: "${METHODOLOGY.slice(0, 40)}"`,
    );
  });
});

// ----------------------------------------------------------------------------
// buildClaudeArgs — args construction
// ----------------------------------------------------------------------------

describe("buildClaudeArgs", () => {
  test("starts with --print followed by the prompt", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "hello world",
    });
    assert.equal(args[0], "--print");
    assert.equal(args[1], "hello world");
  });

  test("no --append-system-prompt by default (methodology is plan-only)", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "do something",
    });
    const count = args.filter((a) => a === "--append-system-prompt").length;
    assert.equal(
      count,
      0,
      "buildClaudeArgs should not auto-inject --append-system-prompt",
    );
  });

  test("one --append-system-prompt when appendSystemPrompt is set", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "test",
      appendSystemPrompt: "extra rules",
    });
    const count = args.filter((a) => a === "--append-system-prompt").length;
    assert.equal(count, 1, "should have exactly one --append-system-prompt");
    assert.ok(
      args.includes("extra rules"),
      "appendSystemPrompt value should be in args",
    );
  });

  test("omits --allowedTools when allowedTools is not specified (all tools)", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "test",
    });
    assert.ok(
      !args.includes("--allowedTools"),
      "--allowedTools should be absent when not specified",
    );
  });

  test("uses specified allowedTools", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "test",
      allowedTools: ["Read", "Grep"],
    });
    const idx = args.indexOf("--allowedTools");
    assert.equal(args[idx + 1], "Read,Grep");
  });

  test("uses bypassPermissions as default permission mode", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "test",
    });
    const idx = args.indexOf("--permission-mode");
    assert.equal(args[idx + 1], "bypassPermissions");
  });

  test("uses specified permissionMode", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "test",
      permissionMode: "default",
    });
    const idx = args.indexOf("--permission-mode");
    assert.equal(args[idx + 1], "default");
  });

  test("includes --model when specified", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "test",
      model: "claude-opus-4-7",
    });
    const idx = args.indexOf("--model");
    assert.ok(idx !== -1, "missing --model flag");
    assert.equal(args[idx + 1], "claude-opus-4-7");
  });

  test("omits --model when not specified", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "test",
    });
    assert.ok(!args.includes("--model"), "--model should be absent");
  });

  test("allowedTools: [] produces 'none' (no tools)", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "test",
      allowedTools: [],
    });
    const idx = args.indexOf("--allowedTools");
    assert.ok(idx !== -1, "missing --allowedTools");
    assert.equal(args[idx + 1], "none");
  });

  test("interactive=true omits --print and the prompt from args", () => {
    const args = buildClaudeArgs(
      { type: "claude", name: "test", prompt: "my prompt" },
      true,
    );
    assert.ok(
      !args.includes("--print"),
      "--print must be absent in interactive mode",
    );
    assert.ok(
      !args.includes("my prompt"),
      "prompt must not appear as CLI arg in interactive mode",
    );
  });

  test("interactive=false (default) includes --print and prompt", () => {
    const args = buildClaudeArgs({
      type: "claude",
      name: "test",
      prompt: "my prompt",
    });
    assert.equal(args[0], "--print");
    assert.equal(args[1], "my prompt");
  });

  test("interactive=true still includes --output-format stream-json", () => {
    const args = buildClaudeArgs(
      { type: "claude", name: "test", prompt: "p" },
      true,
    );
    const idx = args.indexOf("--output-format");
    assert.ok(idx !== -1, "missing --output-format");
    assert.equal(args[idx + 1], "stream-json");
  });
});

// ----------------------------------------------------------------------------
// isObject
// ----------------------------------------------------------------------------

describe("isObject", () => {
  test("returns true for a plain object", () => {
    assert.equal(isObject({ a: 1 }), true);
  });

  test("returns true for an empty object", () => {
    assert.equal(isObject({}), true);
  });

  test("returns false for null", () => {
    assert.equal(isObject(null), false);
  });

  test("returns false for an array", () => {
    assert.equal(isObject([1, 2, 3]), false);
  });

  test("returns false for a string", () => {
    assert.equal(isObject("hello"), false);
  });

  test("returns false for a number", () => {
    assert.equal(isObject(42), false);
  });

  test("returns false for undefined", () => {
    assert.equal(isObject(undefined), false);
  });
});

// ----------------------------------------------------------------------------
// getArray
// ----------------------------------------------------------------------------

describe("getArray", () => {
  test("returns the array at the given key path", () => {
    const obj = { message: { content: [1, 2, 3] } };
    assert.deepEqual(getArray(obj, "message", "content"), [1, 2, 3]);
  });

  test("returns empty array when intermediate key is missing", () => {
    const obj = { message: {} };
    assert.deepEqual(getArray(obj, "message", "content"), []);
  });

  test("returns empty array when root key is missing", () => {
    assert.deepEqual(getArray({}, "message", "content"), []);
  });

  test("returns empty array when value is not an array", () => {
    const obj = { content: "not an array" };
    assert.deepEqual(getArray(obj, "content"), []);
  });

  test("returns empty array when intermediate value is not an object", () => {
    const obj = { a: "string" };
    assert.deepEqual(getArray(obj, "a", "b"), []);
  });

  test("returns the array when only one key is given", () => {
    const obj = { items: ["x", "y"] };
    assert.deepEqual(getArray(obj, "items"), ["x", "y"]);
  });

  test("returns empty array when intermediate value is null", () => {
    const obj = { a: null } as Record<string, unknown>;
    assert.deepEqual(getArray(obj, "a", "b"), []);
  });

  test("traverses three levels deep", () => {
    const obj = { a: { b: { c: [42] } } };
    assert.deepEqual(getArray(obj, "a", "b", "c"), [42]);
  });

  test("returns empty array for empty keys list", () => {
    // No keys → result is the root object, which is not an array
    assert.deepEqual(getArray({ x: 1 }), []);
  });
});

// ----------------------------------------------------------------------------
// buildExitError
// ----------------------------------------------------------------------------

describe("buildExitError", () => {
  test("message contains exit code when no plain lines", () => {
    const err = buildExitError(1, []);
    assert.equal(err.message, "claude exited with code 1");
  });

  test("appends single plain line to message", () => {
    const err = buildExitError(1, ["You've hit your limit · resets 11:30am"]);
    assert.equal(
      err.message,
      "claude exited with code 1\nYou've hit your limit · resets 11:30am",
    );
  });

  test("appends multiple plain lines joined by newlines", () => {
    const err = buildExitError(2, ["line one", "line two"]);
    assert.equal(err.message, "claude exited with code 2\nline one\nline two");
  });

  test("reflects non-1 exit codes", () => {
    const err = buildExitError(137, []);
    assert.ok(err.message.includes("code 137"));
  });
});

// ----------------------------------------------------------------------------
// resolveClaudePath — error path
// ----------------------------------------------------------------------------

describe("resolveClaudePath — PATH manipulation", () => {
  let originalPath: string;
  let mockDir: string;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    mockDir = join(tmpdir(), `claude-path-test-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    rmSync(mockDir, { recursive: true, force: true });
  });

  test("returns the absolute path to the claude binary when found in PATH", () => {
    const mockBin = join(mockDir, "claude");
    writeFileSync(mockBin, "#!/usr/bin/env bash\necho mock\n", "utf8");
    chmodSync(mockBin, 0o755);
    process.env["PATH"] = `${mockDir}:${originalPath}`;

    const result = resolveClaudePath();
    assert.ok(
      result.includes("claude"),
      `Expected path to contain 'claude', got: ${result}`,
    );
    assert.ok(result.startsWith("/"), `Expected absolute path, got: ${result}`);
  });

  test("throws with a helpful message when claude is not in PATH", () => {
    process.env["PATH"] = "/nonexistent-dir-12345";
    assert.throws(
      () => resolveClaudePath(),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error");
        assert.ok(
          err.message.includes("claude CLI not found"),
          `unexpected: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ----------------------------------------------------------------------------
// result message parsing — output:usage
// ----------------------------------------------------------------------------

describe("runClaude — token usage parsing", () => {
  let mockDir: string;
  let originalPath: string;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    mockDir = join(tmpdir(), `claude-usage-test-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    process.env["PATH"] = `${mockDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    rmSync(mockDir, { recursive: true, force: true });
  });

  function installResult(resultLine: object): void {
    const script = join(mockDir, "claude");
    writeFileSync(
      script,
      `#!/usr/bin/env bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'
echo '${JSON.stringify(resultLine)}'
exit 0
`,
      "utf8",
    );
    chmodSync(script, 0o755);
  }

  async function runAndCollectUsage(): Promise<OutputUsageEvent | undefined> {
    const task = { type: "claude" as const, name: "t", prompt: "do it" };
    const events = [];
    for await (const e of runClaude(task)) events.push(e);
    return events.find((e): e is OutputUsageEvent => e.type === "output:usage");
  }

  test("emits output:usage with the four token fields from a full usage object", async () => {
    installResult({
      type: "result",
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 25,
      },
    });
    const usageEvent = await runAndCollectUsage();
    assert.ok(usageEvent, "expected an output:usage event");
    assert.deepEqual(usageEvent.usage, {
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 50,
      cacheReadTokens: 25,
    });
  });

  test("defaults missing individual usage fields to 0 rather than throwing", async () => {
    installResult({
      type: "result",
      total_cost_usd: 0.05,
      usage: { input_tokens: 500 },
    });
    const usageEvent = await runAndCollectUsage();
    assert.ok(usageEvent);
    assert.deepEqual(usageEvent.usage, {
      inputTokens: 500,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  test("emits no output:usage event when the result message has no usage field", async () => {
    installResult({ type: "result", total_cost_usd: 0.05 });
    const usageEvent = await runAndCollectUsage();
    assert.equal(usageEvent, undefined);
  });

  test("emits no output:usage event when usage is malformed (not an object)", async () => {
    installResult({ type: "result", total_cost_usd: 0.05, usage: "oops" });
    const usageEvent = await runAndCollectUsage();
    assert.equal(usageEvent, undefined);
  });
});

// ----------------------------------------------------------------------------
// assistant message parsing — output:context (per-call window occupancy)
// ----------------------------------------------------------------------------

describe("runClaude — per-call context parsing", () => {
  let mockDir: string;
  let originalPath: string;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    mockDir = join(tmpdir(), `claude-context-test-${Date.now()}`);
    mkdirSync(mockDir, { recursive: true });
    process.env["PATH"] = `${mockDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    rmSync(mockDir, { recursive: true, force: true });
  });

  /**
   * Transcript shape taken from a real three-turn `claude -p` run: the CLI
   * emits one assistant message per content block, all sharing that call's id
   * and usage, and a final result whose usage is the SUM over all three calls
   * (13236+174+322 cache creation, 24432+37668+37842 cache read).
   */
  const assistant = (
    id: string,
    block: string,
    cacheCreation: number,
    cacheRead: number,
  ) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        content: [{ type: block, text: "x", name: "Bash", input: {} }],
        usage: {
          input_tokens: 2,
          output_tokens: 2,
          cache_creation_input_tokens: cacheCreation,
          cache_read_input_tokens: cacheRead,
        },
      },
    });

  function installTranscript(): void {
    const lines = [
      assistant("msg_1", "thinking", 13_236, 24_432),
      assistant("msg_1", "text", 13_236, 24_432),
      assistant("msg_1", "tool_use", 13_236, 24_432),
      assistant("msg_2", "tool_use", 174, 37_668),
      assistant("msg_2", "tool_use", 174, 37_668),
      assistant("msg_3", "text", 322, 37_842),
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.05,
        usage: {
          input_tokens: 6,
          output_tokens: 328,
          cache_creation_input_tokens: 13_732,
          cache_read_input_tokens: 99_942,
        },
      }),
    ];
    const script = join(mockDir, "claude");
    writeFileSync(
      script,
      `#!/usr/bin/env bash\n${lines.map((l) => `echo '${l}'`).join("\n")}\nexit 0\n`,
      "utf8",
    );
    chmodSync(script, 0o755);
  }

  async function runAndCollect() {
    const task = { type: "claude" as const, name: "t", prompt: "do it" };
    const events = [];
    for await (const e of runClaude(task)) events.push(e);
    return {
      context: events.filter(
        (e): e is OutputContextEvent => e.type === "output:context",
      ),
      usage: events.find(
        (e): e is OutputUsageEvent => e.type === "output:usage",
      ),
    };
  }

  test("reports one context sample per API call, not per content block", async () => {
    installTranscript();
    const { context } = await runAndCollect();
    // Six assistant messages, three distinct message ids.
    assert.equal(context.length, 3);
    assert.deepEqual(
      context.map((e) => e.tokens),
      [37_670, 37_844, 38_166],
    );
  });

  test("the last sample is the call's own context, not the run's cumulative total", async () => {
    // Regression: the gauge was fed output:usage, whose counts are summed
    // across every call — each turn re-reads the cached prefix, so a long
    // step reported 3781.1k against a 200k window. Here the same transcript
    // would read 113.7k cumulatively where the real context was 38.2k.
    installTranscript();
    const { context, usage } = await runAndCollect();
    const last = context.at(-1);
    assert.equal(last?.tokens, 38_166);
    assert.ok(usage, "expected the cumulative output:usage event too");
    const cumulative =
      usage.usage.inputTokens +
      usage.usage.cacheCreationTokens +
      usage.usage.cacheReadTokens;
    assert.equal(cumulative, 113_680);
    assert.ok(
      last!.tokens < cumulative,
      "per-call context must be below the cumulative total",
    );
  });

  test("emits no context event for an assistant message without usage", async () => {
    const script = join(mockDir, "claude");
    writeFileSync(
      script,
      `#!/usr/bin/env bash
echo '{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"hi"}]}}'
exit 0
`,
      "utf8",
    );
    chmodSync(script, 0o755);
    const { context } = await runAndCollect();
    assert.equal(context.length, 0);
  });
});
