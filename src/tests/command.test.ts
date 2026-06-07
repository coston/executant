// ============================================================================
// COMMAND RUNNER TESTS
// ============================================================================
// Tests for runCommand from src/tasks/command.ts using real bash subprocesses.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCommand } from "../tasks/command.js";
import type {
  CommandTask,
  Event,
  LogEvent,
  OutputTextEvent,
} from "../types.js";
import { TimeoutError } from "../types.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTask(command: string, name = "test-step"): CommandTask {
  return { type: "command", name, command };
}

async function collectEvents(task: CommandTask): Promise<Event[]> {
  const events: Event[] = [];
  for await (const e of runCommand(task)) events.push(e);
  return events;
}

async function collectEventsExpectingError(
  task: CommandTask,
): Promise<{ events: Event[]; error: Error }> {
  const events: Event[] = [];
  try {
    for await (const e of runCommand(task)) events.push(e);
    throw new Error("expected runCommand to throw");
  } catch (err) {
    return {
      events,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

// ----------------------------------------------------------------------------
// runCommand
// ----------------------------------------------------------------------------

describe("runCommand", () => {
  test("first event is a log event with $ prefix", async () => {
    const events = await collectEvents(makeTask("echo hi"));
    const first = events[0] as LogEvent;
    assert.equal(first.type, "log");
    assert.equal(first.level, "info");
    assert.ok(first.text.startsWith("$ "));
    assert.ok(first.text.includes("echo hi"));
  });

  test("yields output:text events for each stdout line", async () => {
    const events = await collectEvents(makeTask("echo foo && echo bar"));
    const textEvents = events.filter(
      (e): e is OutputTextEvent => e.type === "output:text",
    );
    const lines = textEvents.map((e) => e.text);
    assert.ok(lines.includes("foo"));
    assert.ok(lines.includes("bar"));
  });

  test("output:text events have index -1", async () => {
    const events = await collectEvents(makeTask("echo hello"));
    const textEvents = events.filter(
      (e): e is OutputTextEvent => e.type === "output:text",
    );
    for (const e of textEvents) assert.equal(e.index, -1);
  });

  test("captures stderr lines as output:text events", async () => {
    const events = await collectEvents(makeTask("echo err >&2"));
    const textEvents = events.filter(
      (e): e is OutputTextEvent => e.type === "output:text",
    );
    assert.ok(textEvents.some((e) => e.text.includes("err")));
  });

  test("empty command output yields no output:text events", async () => {
    const events = await collectEvents(makeTask("true"));
    const textEvents = events.filter((e) => e.type === "output:text");
    assert.equal(textEvents.length, 0);
  });

  test("throws on non-zero exit code", async () => {
    const { error } = await collectEventsExpectingError(
      makeTask("exit 1", "failing-step"),
    );
    assert.ok(
      error.message.includes("failing-step"),
      `expected step name in error: ${error.message}`,
    );
    assert.ok(
      error.message.includes("1"),
      `expected exit code in error: ${error.message}`,
    );
  });

  test("error message contains the step name", async () => {
    const { error } = await collectEventsExpectingError(
      makeTask("exit 2", "my-named-step"),
    );
    assert.ok(error.message.includes("my-named-step"));
  });
});

// ----------------------------------------------------------------------------
// timeout_seconds
// ----------------------------------------------------------------------------

describe("runCommand — timeout_seconds", () => {
  test("throws TimeoutError when command exceeds timeout", async () => {
    const task: CommandTask = {
      type: "command",
      name: "slow",
      command: "sleep 60",
      timeoutSeconds: 0.1,
    };
    const { error } = await collectEventsExpectingError(task);
    assert.ok(
      error instanceof TimeoutError,
      `expected TimeoutError, got ${error.constructor.name}: ${error.message}`,
    );
    assert.ok(error.message.includes("slow"));
    assert.equal((error as TimeoutError).exitCode, 3);
  });

  test("does not throw TimeoutError when command completes before timeout", async () => {
    const task: CommandTask = {
      type: "command",
      name: "fast",
      command: "echo done",
      timeoutSeconds: 10,
    };
    const events = await collectEvents(task);
    const textEvents = events.filter(
      (e): e is OutputTextEvent => e.type === "output:text",
    );
    assert.ok(textEvents.some((e) => e.text.includes("done")));
  });

  test("without timeout_seconds, slow commands are not killed", async () => {
    const task: CommandTask = {
      type: "command",
      name: "short-sleep",
      command: "sleep 0.05",
    };
    const events = await collectEvents(task);
    const textEvents = events.filter((e) => e.type === "output:text");
    assert.equal(textEvents.length, 0);
  });
});
