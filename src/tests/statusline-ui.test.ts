// ============================================================================
// STATUS BAR UI TESTS
// ============================================================================
// Renders the real App and verifies the context gauge above the footer: that
// it starts empty, moves as output:usage events land, and disappears entirely
// under EXECUTANT_STATUSLINE=0.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";

import { App } from "../ui/App.js";
import type { Event, Workflow } from "../types.js";

const WORKFLOW: Workflow = {
  goal: "test goal",
  sourcePath: "/tmp/task.yaml",
  tasks: [{ type: "command", name: "step-1", command: "true" }],
};

/** An extended-context prompt step followed by a step that names no model. */
const MIXED_MODEL_WORKFLOW: Workflow = {
  goal: "test goal",
  sourcePath: "/tmp/task.yaml",
  tasks: [
    { type: "claude", name: "wide-step", prompt: "go", model: "opus[1m]" },
    { type: "command", name: "after", command: "true" },
  ],
};

/**
 * Yields the given events and then completes — with no workflow:complete or
 * error event, App never calls exit() and stays mounted mid-run, which is
 * all these tests need. (An async generator that instead awaits forever to
 * simulate "still running" cannot be interrupted by App's cleanup: per spec,
 * .return() on a generator suspended inside an unsettled `await` only takes
 * effect once that await resolves, so it would hang the test process at exit.)
 */
async function* runningStream(events: Event[]): AsyncGenerator<Event> {
  for (const e of events) yield e;
}

const RUNNING_EVENTS: Event[] = [
  { type: "workflow:start", workflow: WORKFLOW },
  { type: "step:start", index: 0, name: "step-1" },
];

const waitForFrame = async (
  frame: () => string | undefined,
  pattern: RegExp,
): Promise<string> => {
  const deadline = Date.now() + 2000;
  let last = frame() ?? "";
  while (Date.now() < deadline) {
    last = frame() ?? "";
    if (pattern.test(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last;
};

describe("App status bar", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["EXECUTANT_STATUSLINE"];
    // `npm test` disables the bar suite-wide so unrelated UI tests keep a
    // stable row budget. These tests are the ones that need it on.
    delete process.env["EXECUTANT_STATUSLINE"];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env["EXECUTANT_STATUSLINE"];
    else process.env["EXECUTANT_STATUSLINE"] = originalEnv;
  });

  const renderApp = (events: Event[], workflow: Workflow = WORKFLOW) =>
    render(
      React.createElement(App, {
        workflow,
        events: runningStream(events),
        updateCheck: Promise.resolve(null),
      }),
    );

  test("shows an empty gauge before any Claude step has reported usage", async () => {
    const { lastFrame, unmount } = renderApp(RUNNING_EVENTS);
    await waitForFrame(lastFrame, /0% 0\.0k\/200k/);
    assert.match(lastFrame() ?? "", /━{10} 0% 0\.0k\/200k/);
    unmount();
  });

  test("names the repo and branch it is running in", async () => {
    // The suite runs inside executant's own checkout.
    const { lastFrame, unmount } = renderApp(RUNNING_EVENTS);
    await waitForFrame(lastFrame, /executant/);
    assert.match(lastFrame() ?? "", /executant\s+\S+\s+━{10}/);
    unmount();
  });

  test("fills the gauge as a step reports its context", async () => {
    const { lastFrame, unmount } = renderApp([
      ...RUNNING_EVENTS,
      {
        type: "output:usage",
        index: 0,
        usage: {
          inputTokens: 12_200,
          outputTokens: 1200,
          cacheCreationTokens: 50_000,
          cacheReadTokens: 100_000,
        },
      },
    ]);
    // 12200 + 50000 + 100000 = 162200 of 200k = 81%.
    await waitForFrame(lastFrame, /81% 162\.2k\/200k/);
    assert.match(lastFrame() ?? "", /━{10} 81% 162\.2k\/200k/);
    unmount();
  });

  test("sizes the gauge to the model of the step that reported the usage", async () => {
    // Regression: the model used to be read from state.currentIndex, which
    // step:complete has already advanced past — so once the [1m] step
    // finished, its usage was re-scaled against the *next* step's 200k
    // window and the same token count jumped from 16% to 81%.
    const { lastFrame, unmount } = renderApp(
      [
        { type: "workflow:start", workflow: MIXED_MODEL_WORKFLOW },
        { type: "step:start", index: 0, name: "wide-step" },
        {
          type: "output:usage",
          index: 0,
          usage: {
            inputTokens: 12_200,
            outputTokens: 1200,
            cacheCreationTokens: 50_000,
            cacheReadTokens: 100_000,
          },
        },
        { type: "step:complete", index: 0, name: "wide-step", durationMs: 10 },
        { type: "step:start", index: 1, name: "after" },
      ],
      MIXED_MODEL_WORKFLOW,
    );
    // 162200 of 1M = 16%, and it stays that way after the step completes.
    await waitForFrame(lastFrame, /162\.2k/);
    assert.match(lastFrame() ?? "", /16% 162\.2k\/1M/);
    unmount();
  });

  test("EXECUTANT_STATUSLINE=0 hides it entirely", async () => {
    process.env["EXECUTANT_STATUSLINE"] = "0";
    const { lastFrame, unmount } = renderApp(RUNNING_EVENTS);
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(lastFrame() ?? "", /k\/200k/);
    assert.match(lastFrame() ?? "", /press q to quit/);
    unmount();
  });
});
