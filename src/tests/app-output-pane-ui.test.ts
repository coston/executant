// ============================================================================
// APP OUTPUT PANE UI TESTS
// ============================================================================
// Renders the real App and drives it with real keystrokes to verify the
// output-pane layout behavior: the step list is never trimmed, the output
// pane's height can be resized with the keyboard, and a resize freezes for
// the rest of the run instead of springing back to auto-sizing on the next
// step. Mouse drag-to-resize (useOutputResize's other half) is exercised in
// mouse-resize.test.ts at the pure-function level — ink-testing-library's
// stdin mock does deliver raw bytes to the same `internal_eventEmitter`
// channel that hook listens on, but asserting exact on-screen row positions
// from a text frame is what the pure math tests already cover directly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../ui/App.js";
import type { Event, Workflow } from "../types.js";

async function* stream(events: Event[]): AsyncGenerator<Event> {
  for (const e of events) yield e;
}

const waitFor = async (
  frame: () => string | undefined,
  predicate: (frame: string) => boolean,
): Promise<string> => {
  const deadline = Date.now() + 2000;
  let last = frame() ?? "";
  while (Date.now() < deadline) {
    last = frame() ?? "";
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last;
};
const settle = () => new Promise((r) => setTimeout(r, 60));

function workflowWithSteps(count: number): Workflow {
  return {
    goal: "many-step workflow",
    sourcePath: "/tmp/task.yaml",
    tasks: Array.from({ length: count }, (_, i) => ({
      type: "command" as const,
      name: `step-${i + 1}`,
      command: "true",
    })),
  };
}

describe("App output pane", () => {
  test("the full step list renders even when it would once have been trimmed", async () => {
    const workflow = workflowWithSteps(15);
    const events: Event[] = [
      { type: "workflow:start", workflow },
      { type: "step:start", index: 0, name: "step-1" },
    ];
    const { lastFrame, unmount } = render(
      React.createElement(App, {
        workflow,
        events: stream(events),
        updateCheck: Promise.resolve(null),
      }),
    );
    await waitFor(lastFrame, (f) => f.includes("step-15"));
    const frame = lastFrame() ?? "";
    assert.match(frame, /step-1\b/);
    assert.match(frame, /step-15\b/);
    assert.doesNotMatch(frame, /earlier/);
    unmount();
  });

  test("[ shrinks the output pane and the size persists across the next step", async () => {
    const workflow = workflowWithSteps(2);
    const step1Lines = Array.from(
      { length: 20 },
      (_, i) => `output line ${i}`,
    ).join("\n");
    const step2Lines = Array.from(
      { length: 20 },
      (_, i) => `step2 line ${i}`,
    ).join("\n");

    // A real delay between step 1's output and step 2 starting — a fixed
    // array processed with no delay would dispatch both steps back-to-back
    // before the test ever gets a chance to press a key in between.
    async function* delayedStream(): AsyncGenerator<Event> {
      yield { type: "workflow:start", workflow };
      yield { type: "step:start", index: 0, name: "step-1" };
      yield { type: "output:text", index: 0, text: step1Lines };
      await new Promise((r) => setTimeout(r, 150));
      yield { type: "step:complete", index: 0, name: "step-1", durationMs: 1 };
      yield { type: "step:start", index: 1, name: "step-2" };
      yield { type: "output:text", index: 1, text: step2Lines };
    }

    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, {
        workflow,
        events: delayedStream(),
        updateCheck: Promise.resolve(null),
      }),
    );
    await waitFor(lastFrame, (f) => f.includes("output line 19"));
    const before = (lastFrame() ?? "").split("\n").length;

    for (let i = 0; i < 4; i++) stdin.write("[");
    await settle();
    const afterShrink = (lastFrame() ?? "").split("\n").length;
    assert.ok(
      afterShrink < before,
      `expected shrunk frame (${afterShrink} lines) to be shorter than before (${before})`,
    );

    // Also scroll up in step 1 — this should NOT survive the step change,
    // unlike the frozen height.
    stdin.write("\x1b[A");
    await settle();
    assert.match(lastFrame() ?? "", /scrolled up/);

    // Advance to step 2 — a frozen size should carry over rather than
    // springing back to the terminal's full auto-sized budget, but the
    // scroll position should reset to the new step's live tail.
    await waitFor(lastFrame, (f) => f.includes("step2 line 19"));
    const afterNextStep = (lastFrame() ?? "").split("\n").length;
    assert.equal(afterNextStep, afterShrink);
    assert.doesNotMatch(lastFrame() ?? "", /scrolled up/);
    unmount();
  });

  test("↑ scrolls the output pane and shows the scroll indicator", async () => {
    const workflow = workflowWithSteps(1);
    const manyLines = Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n");
    const events: Event[] = [
      { type: "workflow:start", workflow },
      { type: "step:start", index: 0, name: "step-1" },
      { type: "output:text", index: 0, text: manyLines },
    ];
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, {
        workflow,
        events: stream(events),
        updateCheck: Promise.resolve(null),
      }),
    );
    await waitFor(lastFrame, (f) => f.includes("L29"));
    assert.doesNotMatch(lastFrame() ?? "", /scrolled up/);

    stdin.write("\x1b[A"); // up arrow
    stdin.write("\x1b[A");
    stdin.write("\x1b[A");
    await settle();
    assert.match(lastFrame() ?? "", /scrolled up 3 lines/);

    stdin.write("\x1b[B"); // down arrow
    stdin.write("\x1b[B");
    stdin.write("\x1b[B");
    await settle();
    assert.doesNotMatch(lastFrame() ?? "", /scrolled up/);
    unmount();
  });
});
