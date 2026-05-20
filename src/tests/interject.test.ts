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
  test("consumeQueue drains and clears the queue", () => {
    const channel = new InterjectChannel();
    channel.interject("a");
    channel.interject("b");
    const first = channel.consumeQueue();
    const second = channel.consumeQueue();
    assert.deepEqual(first, ["a", "b"]);
    assert.deepEqual(second, []);
  });
});

// ----------------------------------------------------------------------------
// runClaude interactive mode — stdin injection
// ----------------------------------------------------------------------------

// Note: stdin injection is not viable — the Claude CLI requires stdin EOF
// before processing. Interjections queue and prepend to the next Claude step.
describe("runClaude — always uses --print mode", () => {
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

  test("yields output:text events from the claude CLI", async () => {
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

    const task = { type: "claude" as const, name: "t", prompt: "do it" };
    const events = [];
    for await (const e of runClaude(task)) events.push(e);

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
    // Channel accumulates them — always queued until consumed by the next Claude step
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
