// ============================================================================
// INTERJECT CHANNEL — unit tests
// ============================================================================
// Tests for InterjectChannel and its integration with runClaude + runWorkflow.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterjectChannel } from "../types.js";
import { runClaude } from "../tasks/claude.js";
import { runWorkflow } from "../runner.js";
import type { Workflow } from "../types.js";

// ----------------------------------------------------------------------------
// InterjectChannel — unit tests
// ----------------------------------------------------------------------------

describe("InterjectChannel", () => {
  test("delivers a message immediately when sender is registered", () => {
    const channel = new InterjectChannel();
    const received: string[] = [];
    channel.register((msg) => received.push(msg));
    channel.interject("hello");
    assert.deepEqual(received, ["hello"]);
  });

  test("queues messages sent before registration and flushes on register", () => {
    const channel = new InterjectChannel();
    channel.interject("first");
    channel.interject("second");
    const received: string[] = [];
    channel.register((msg) => received.push(msg));
    assert.deepEqual(received, ["first", "second"]);
  });

  test("after unregister, messages go to queue", () => {
    const channel = new InterjectChannel();
    const received: string[] = [];
    channel.register((msg) => received.push(msg));
    channel.unregister();
    channel.interject("queued");
    assert.deepEqual(received, []);
    assert.deepEqual(channel.consumeQueue(), ["queued"]);
  });

  test("consumeQueue drains and clears the queue", () => {
    const channel = new InterjectChannel();
    channel.interject("a");
    channel.interject("b");
    const first = channel.consumeQueue();
    const second = channel.consumeQueue();
    assert.deepEqual(first, ["a", "b"]);
    assert.deepEqual(second, []);
  });

  test("interject after register does not touch queue", () => {
    const channel = new InterjectChannel();
    const received: string[] = [];
    channel.register((msg) => received.push(msg));
    channel.interject("live");
    assert.deepEqual(received, ["live"]);
    assert.deepEqual(channel.consumeQueue(), []);
  });

  test("register with queued messages delivers them before live ones", () => {
    const channel = new InterjectChannel();
    channel.interject("queued-1");
    channel.interject("queued-2");
    const received: string[] = [];
    channel.register((msg) => received.push(msg));
    channel.interject("live");
    assert.deepEqual(received, ["queued-1", "queued-2", "live"]);
  });
});

// ----------------------------------------------------------------------------
// runClaude interactive mode — stdin injection
// ----------------------------------------------------------------------------

// Note: stdin injection (keeping stdin open for multi-turn input) was
// investigated but is not viable — the Claude CLI requires stdin EOF before
// it will process a piped prompt. Interjections are instead queued by
// InterjectChannel and prepended to the next Claude step's prompt.
describe("runClaude with channel — always uses --print mode", () => {
  let mockDir: string;
  let originalPath: string;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    mockDir = join(
      tmpdir(),
      `executant-interject-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(mockDir, { recursive: true });
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    rmSync(mockDir, { recursive: true, force: true });
  });

  test("channel parameter does not change the --print invocation", async () => {
    const script = join(mockDir, "claude");
    writeFileSync(
      script,
      `#!/usr/bin/env bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'
echo '{"type":"result","total_cost_usd":0.001}'
exit 0
`,
      "utf8",
    );
    chmodSync(script, 0o755);
    process.env["PATH"] = `${mockDir}:${originalPath}`;

    const channel = new InterjectChannel();
    const task = { type: "claude" as const, name: "t", prompt: "do it" };
    const events = [];
    for await (const e of runClaude(task, channel)) events.push(e);

    const texts = events
      .filter((e) => e.type === "output:text")
      .map((e) => (e as { text: string }).text);
    assert.ok(texts.includes("done"), "should yield output:text normally");
  });

  test("interjections sent during a Claude step queue for the next step", () => {
    const channel = new InterjectChannel();
    // Simulate user interjecting while a Claude step runs (sender not registered)
    channel.interject("use TypeScript");
    channel.interject("avoid any types");
    // Channel accumulates them in the queue since no step has registered a sender
    assert.deepEqual(channel.consumeQueue(), [
      "use TypeScript",
      "avoid any types",
    ]);
  });
});

// ----------------------------------------------------------------------------
// runWorkflow — queued interjection prepended to next Claude step
// ----------------------------------------------------------------------------

describe("runWorkflow queued interjection", () => {
  let mockDir: string;
  let originalPath: string;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    mockDir = join(
      tmpdir(),
      `executant-interject-wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(mockDir, { recursive: true });

    // Mock that echoes the --print arg back as output text
    const script = join(mockDir, "claude");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        // Find the argument after --print and echo it back
        "prompt_arg=",
        'for i in "$@"; do',
        '  if [ "$prev" = "--print" ]; then prompt_arg="$i"; fi',
        '  prev="$i"',
        "done",
        'echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"$prompt_arg\\"}]}}"',
        'echo \'{"type":"result","total_cost_usd":0}\'',
      ].join("\n") + "\n",
      "utf8",
    );
    chmodSync(script, 0o755);
    process.env["PATH"] = `${mockDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    rmSync(mockDir, { recursive: true, force: true });
  });

  test("queued message is prepended to next Claude step prompt when sent during script step", async () => {
    const channel = new InterjectChannel();
    const workflow: Workflow = {
      goal: "test",
      tasks: [
        { type: "command", name: "setup", command: "echo setup-done" },
        { type: "claude", name: "analyse", prompt: "analyse the code" },
      ],
    };

    const events: import("../types.js").Event[] = [];
    const gen = runWorkflow(workflow, {}, channel);

    for await (const event of gen) {
      events.push(event);
      // Inject during the script step (before Claude step runs)
      if (event.type === "step:start" && event.name === "setup") {
        channel.interject("use TypeScript not JavaScript");
      }
    }

    // The Claude step's output should contain the queued correction in the prompt
    const texts = events
      .filter((e) => e.type === "output:text")
      .map((e) => (e as { text: string }).text);

    // The mock echoes the first 80 chars of the prompt; it should include the queued message
    assert.ok(
      texts.some((t) => t.includes("User correction")),
      `expected queued correction in prompt, got texts: ${JSON.stringify(texts)}`,
    );
  });
});
