// ============================================================================
// STATUS BAR UI TESTS
// ============================================================================
// Renders the real App and verifies the context gauge above the footer: that
// it starts empty, moves as per-call output:context events land, ignores the
// cumulative output:usage totals, and disappears under EXECUTANT_STATUSLINE=0.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";

import { App } from "../ui/App.js";
import type { Event, Workflow } from "../types.js";
import { withInk, waitForFrame, settle } from "./ink-harness.js";

const WORKFLOW: Workflow = {
  goal: "test goal",
  sourcePath: "/tmp/task.yaml",
  tasks: [{ type: "command", name: "step-1", command: "true" }],
};

/** Two prompt steps — two separate `claude -p` sessions. */
const TWO_SESSION_WORKFLOW: Workflow = {
  goal: "test goal",
  sourcePath: "/tmp/task.yaml",
  tasks: [
    { type: "claude", name: "session-1", prompt: "go" },
    { type: "claude", name: "session-2", prompt: "go again" },
  ],
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

  /** Renders App and always unmounts, even if `body` throws. */
  const withApp = (
    events: Event[],
    body: (ink: { lastFrame: () => string | undefined }) => Promise<void>,
    workflow: Workflow = WORKFLOW,
  ) =>
    withInk(
      React.createElement(App, {
        workflow,
        events: runningStream(events),
        updateCheck: Promise.resolve(null),
      }),
      body,
    );

  test("shows an empty gauge before any Claude step has reported usage", async () => {
    await withApp(RUNNING_EVENTS, async ({ lastFrame }) => {
      const frame = await waitForFrame(lastFrame, /0% 0\.0k\/200k/, {
        describe: "an empty gauge",
      });
      assert.match(frame, /━{10} 0% 0\.0k\/200k/);
    });
  });

  test("names the repo and branch it is running in", async () => {
    // The suite runs inside executant's own checkout.
    await withApp(RUNNING_EVENTS, async ({ lastFrame }) => {
      const frame = await waitForFrame(lastFrame, /executant\s+\S+\s+━{10}/, {
        describe: "the repo and branch segment",
      });
      assert.match(frame, /executant\s+\S+\s+━{10}/);
    });
  });

  test("fills the gauge as a step reports its context", async () => {
    await withApp(
      [
        ...RUNNING_EVENTS,
        { type: "output:context", index: 0, tokens: 162_200 },
      ],
      async ({ lastFrame }) => {
        // 162200 of 200k = 81%.
        const frame = await waitForFrame(lastFrame, /81% 162\.2k\/200k/, {
          describe: "the gauge to fill to 81%",
        });
        assert.match(frame, /━{10} 81% 162\.2k\/200k/);
      },
    );
  });

  test("sizes the gauge to the model of the step that reported the usage", async () => {
    // Regression: the model used to be read from state.currentIndex, which
    // step:complete has already advanced past — so once the [1m] step
    // finished, its usage was re-scaled against the *next* step's 200k
    // window and the same token count jumped from 16% to 81%.
    await withApp(
      [
        { type: "workflow:start", workflow: MIXED_MODEL_WORKFLOW },
        { type: "step:start", index: 0, name: "wide-step" },
        { type: "output:context", index: 0, tokens: 162_200 },
        { type: "step:complete", index: 0, name: "wide-step", durationMs: 10 },
        { type: "step:start", index: 1, name: "after" },
      ],
      async ({ lastFrame }) => {
        // 162200 of 1M = 16%, and it stays that way after the step completes.
        const frame = await waitForFrame(lastFrame, /162\.2k/, {
          describe: "the gauge to report the step's context",
        });
        assert.match(frame, /16% 162\.2k\/1M/);
      },
      MIXED_MODEL_WORKFLOW,
    );
  });

  test("each session gets its own gauge — no carry-over between steps", async () => {
    // A step is one `claude -p` session with its own window. Step 2 must
    // start from empty rather than inheriting step 1's fill, and must never
    // show the two added together (202.2k here).
    await withApp(
      [
        { type: "workflow:start", workflow: TWO_SESSION_WORKFLOW },
        { type: "step:start", index: 0, name: "session-1" },
        { type: "output:context", index: 0, tokens: 162_200 },
        { type: "step:complete", index: 0, name: "session-1", durationMs: 10 },
        { type: "step:start", index: 1, name: "session-2" },
      ],
      async ({ lastFrame }) => {
        // Session 2 has opened but not yet reported a turn: empty window.
        const reset = await waitForFrame(lastFrame, /0% 0\.0k\/200k/, {
          describe: "the gauge to reset for the new session",
        });
        assert.doesNotMatch(reset, /162\.2k/);
      },
      TWO_SESSION_WORKFLOW,
    );
  });

  test("a session's turns replace rather than accumulate", async () => {
    // Within one session the conversation grows and is re-measured each
    // turn; the gauge tracks the latest measurement, never the sum.
    await withApp(
      [
        { type: "workflow:start", workflow: TWO_SESSION_WORKFLOW },
        { type: "step:start", index: 0, name: "session-1" },
        { type: "output:context", index: 0, tokens: 37_670 },
        { type: "output:context", index: 0, tokens: 37_844 },
        { type: "output:context", index: 0, tokens: 38_166 },
      ],
      async ({ lastFrame }) => {
        // 38166 of 200k = 19%, not (37670+37844+38166)=113.6k = 56%.
        const frame = await waitForFrame(lastFrame, /38\.1k/, {
          describe: "the latest turn's occupancy",
        });
        assert.match(frame, /19% 38\.1k\/200k/);
        assert.doesNotMatch(frame, /113\.6k/);
      },
      TWO_SESSION_WORKFLOW,
    );
  });

  test("ignores the cumulative output:usage total", async () => {
    // Regression: the gauge used to be fed output:usage, whose counts are the
    // CLI's totals across every API call in the step. A long step re-reads
    // its cached prefix each turn, so those summed to 3781.1k against a 200k
    // window on a real run. Only per-call output:context may move the gauge.
    await withApp(
      [
        ...RUNNING_EVENTS,
        {
          type: "output:usage",
          index: 0,
          usage: {
            inputTokens: 6,
            outputTokens: 328,
            cacheCreationTokens: 500_000,
            cacheReadTokens: 3_281_000,
          },
        },
      ],
      async ({ lastFrame }) => {
        // Asserting an absence, so this waits a fixed moment rather than
        // polling for a condition that should never arrive.
        await settle();
        const frame = lastFrame() ?? "";
        assert.doesNotMatch(frame, /3781\.1k/);
        assert.match(frame, /0% 0\.0k\/200k/);
      },
    );
  });

  test("EXECUTANT_STATUSLINE=0 hides it entirely", async () => {
    process.env["EXECUTANT_STATUSLINE"] = "0";
    await withApp(RUNNING_EVENTS, async ({ lastFrame }) => {
      await waitForFrame(lastFrame, /press q to quit/, {
        describe: "the footer",
      });
      assert.doesNotMatch(lastFrame() ?? "", /k\/200k/);
    });
  });
});
