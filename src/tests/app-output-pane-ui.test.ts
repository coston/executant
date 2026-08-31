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

import "./force-non-ci.js"; // must evaluate before any ink import — see its header
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { App } from "../ui/App.js";
import type { Event, Workflow } from "../types.js";
import { withInk, waitForFrame } from "./ink-harness.js";

async function* stream(events: Event[]): AsyncGenerator<Event> {
  for (const e of events) yield e;
}

/** Rendered frame height, the quantity every resize assertion is about. */
const rows = (frame: string | undefined) => (frame ?? "").split("\n").length;

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
    await withInk(
      React.createElement(App, {
        workflow,
        events: stream(events),
        updateCheck: Promise.resolve(null),
      }),
      async ({ lastFrame }) => {
        const frame = await waitForFrame(
          lastFrame,
          (f) => f.includes("step-15"),
          { describe: "the last step to appear" },
        );
        assert.match(frame, /step-1\b/);
        assert.match(frame, /step-15\b/);
        assert.doesNotMatch(frame, /earlier/);
      },
    );
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

    await withInk(
      React.createElement(App, {
        workflow,
        events: delayedStream(),
        updateCheck: Promise.resolve(null),
      }),
      async ({ lastFrame, stdin }) => {
        await waitForFrame(lastFrame, (f) => f.includes("output line 19"), {
          describe: "step 1's output to arrive",
        });
        const before = rows(lastFrame());

        // Wait for the shrink to land rather than sleeping a fixed 60ms:
        // under a loaded machine Ink can take far longer than that to process
        // four keystrokes and repaint, and a fixed sleep turns that into a
        // spurious failure.
        for (let i = 0; i < 4; i++) stdin.write("[");
        const shrunk = await waitForFrame(lastFrame, (f) => rows(f) < before, {
          describe: `the pane to shrink below ${before} rows`,
        });
        const afterShrink = rows(shrunk);

        // Also scroll up in step 1 — this should NOT survive the step change,
        // unlike the frozen height.
        stdin.write("\x1b[A");
        await waitForFrame(lastFrame, /scrolled up/, {
          describe: "the scroll indicator",
        });

        // Advance to step 2 — a frozen size should carry over rather than
        // springing back to the terminal's full auto-sized budget, but the
        // scroll position should reset to the new step's live tail.
        await waitForFrame(lastFrame, (f) => f.includes("step2 line 19"), {
          describe: "step 2's output to arrive",
        });
        assert.equal(rows(lastFrame()), afterShrink);
        assert.doesNotMatch(lastFrame() ?? "", /scrolled up/);
      },
    );
  });

  test("↑ scrolls the output pane and shows the scroll indicator", async () => {
    const workflow = workflowWithSteps(1);
    const manyLines = Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n");
    const events: Event[] = [
      { type: "workflow:start", workflow },
      { type: "step:start", index: 0, name: "step-1" },
      { type: "output:text", index: 0, text: manyLines },
    ];
    await withInk(
      React.createElement(App, {
        workflow,
        events: stream(events),
        updateCheck: Promise.resolve(null),
      }),
      async ({ lastFrame, stdin }) => {
        await waitForFrame(lastFrame, (f) => f.includes("L29"), {
          describe: "the step's output to arrive",
        });
        assert.doesNotMatch(lastFrame() ?? "", /scrolled up/);

        stdin.write("\x1b[A"); // up arrow
        stdin.write("\x1b[A");
        stdin.write("\x1b[A");
        await waitForFrame(lastFrame, /scrolled up 3 lines/, {
          describe: "the scroll indicator to report 3 lines",
        });

        stdin.write("\x1b[B"); // down arrow
        stdin.write("\x1b[B");
        stdin.write("\x1b[B");
        await waitForFrame(lastFrame, (f) => !/scrolled up/.test(f), {
          describe: "the scroll indicator to clear",
        });
      },
    );
  });
});
