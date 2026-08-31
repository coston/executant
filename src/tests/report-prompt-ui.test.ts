// ============================================================================
// REPORT PROMPT UI TESTS
// ============================================================================
// Renders the real Ink components and drives them with real keystrokes:
//   - ReportPrompt: the choosing/analyzing/done phases and their keybindings
//   - App: holding the TUI open after a successful run instead of exiting
//     immediately, only when the terminal supports input and no suggestion
//     was already generated automatically
//
// ink-testing-library's stdin reports isTTY and implements setRawMode, so
// Ink's useInput is live and `stdin.write("a")` behaves like a real keypress.

import "./force-non-ci.js"; // must evaluate before any ink import — see its header
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import {
  renderTracked,
  unmountAllInk,
  waitForFrame,
  settle,
} from "./ink-harness.js";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { App } from "../ui/App.js";
import { ReportPrompt } from "../ui/ReportPrompt.js";
import type { Event, RunReport, Workflow } from "../types.js";

// Any instance a test rendered is torn down here, pass or fail: a live Ink
// tree keeps timers and stdin listeners on the event loop, so a failed
// assertion that skipped its unmount() would hang this process forever —
// and with it the whole `node --test` run.
afterEach(unmountAllInk);

let mockDir: string;
let originalPath: string | undefined;
beforeEach(() => {
  mockDir = mkdtempSync(join(tmpdir(), "executant-report-ui-"));
  originalPath = process.env["PATH"];
  process.env["PATH"] = `${mockDir}:${originalPath ?? ""}`;
});
afterEach(() => {
  process.env["PATH"] = originalPath;
  rmSync(mockDir, { recursive: true, force: true });
});

/**
 * Mock claude that answers every invocation with the given suggestion JSON.
 * `delayMs` (default 0) sleeps before responding — real subprocess spawn+run
 * is often faster than a test's settle() checkpoint, so a test asserting on
 * the transient "analyzing…" state needs an artificial delay to observe it
 * reliably rather than racing a near-instant mock.
 */
function installSuggestionMock(suggestionText: string, delayMs = 0): void {
  const responseFile = join(mockDir, "response.ndjson");
  const ndjson =
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ suggestion: suggestionText }),
          },
        ],
      },
    }) +
    "\n" +
    JSON.stringify({ type: "result", total_cost_usd: 0.0001 }) +
    "\n";
  writeFileSync(responseFile, ndjson, "utf8");
  const script = join(mockDir, "claude");
  const sleep = delayMs > 0 ? `sleep ${(delayMs / 1000).toFixed(3)}\n` : "";
  writeFileSync(
    script,
    `#!/usr/bin/env bash\n${sleep}cat "${responseFile}"\nexit 0\n`,
    "utf8",
  );
  chmodSync(script, 0o755);
}

function installFailingMock(): void {
  const script = join(mockDir, "claude");
  writeFileSync(script, `#!/usr/bin/env bash\nexit 1\n`, "utf8");
  chmodSync(script, 0o755);
}

const REPORT: RunReport = {
  durationMs: 65_000,
  totalCostUsd: 0.1234,
  totalTokens: {
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  overflowTokens: 0,
  overflowCalls: 0,
  stepNarrative: [
    {
      name: "bump-year",
      durationMs: 65_000,
      costUsd: 0.1234,
      qualityEvents: [],
    },
  ],
};

const WORKFLOW: Workflow = {
  goal: "test goal",
  source:
    "goal: test goal\nsteps:\n  - name: bump-year\n    command: echo hi\n",
  tasks: [{ type: "command", name: "bump-year", command: "echo hi" }],
};

function renderPrompt(report: RunReport = REPORT) {
  const done: number[] = [];
  const app = renderTracked(
    React.createElement(ReportPrompt, {
      report,
      workflow: WORKFLOW,
      onDone: () => done.push(1),
    }),
  );
  return { ...app, done };
}

describe("ReportPrompt rendering", () => {
  test("shows duration, cost, and tokens up front", () => {
    const { lastFrame, unmount } = renderPrompt();
    assert.match(lastFrame() ?? "", /1m 05s/);
    assert.match(lastFrame() ?? "", /\$0\.1234/);
    assert.match(lastFrame() ?? "", /1,200/);
    unmount();
  });

  test("offers the analyze choice before anything is requested", () => {
    const { lastFrame, unmount } = renderPrompt();
    assert.match(lastFrame() ?? "", /\[a\] analyze this run/);
    unmount();
  });

  test("shows the overflow figure when present", () => {
    const { lastFrame, unmount } = renderPrompt({
      ...REPORT,
      overflowCalls: 2,
      overflowTokens: 5_000,
    });
    assert.match(lastFrame() ?? "", /5,000 over 200k in 2 call\(s\)/);
    unmount();
  });
});

describe("ReportPrompt keyboard", () => {
  test("any key other than 'a' skips and calls onDone immediately", async () => {
    const { stdin, done, unmount } = renderPrompt();
    await settle();
    stdin.write("q");
    await settle();
    assert.equal(done.length, 1);
    unmount();
  });

  test("'a' runs the analysis and shows the resulting suggestion", async () => {
    installSuggestionMock("add concurrency: 4 to bump-year", 300);
    const { stdin, lastFrame, done, unmount } = renderPrompt();
    await settle();
    stdin.write("a");
    await settle();
    assert.match(lastFrame() ?? "", /analyzing…/);
    assert.equal(done.length, 0); // still waiting, not dismissed yet

    const shown = await waitForFrame(
      lastFrame,
      /add concurrency: 4 to bump-year/,
    );
    assert.match(shown, /add concurrency: 4 to bump-year/);
    assert.match(shown, /press any key to exit/);
    // Give the effect that resubscribes useInput with the now-"done" closure
    // a chance to flush — the frame can render before that effect commits.
    await settle();

    stdin.write("x");
    await settle();
    assert.equal(done.length, 1);
    unmount();
  });

  test("a failed analysis still resolves to a dismissable state, not a hang", async () => {
    installFailingMock();
    const { stdin, lastFrame, done, unmount } = renderPrompt();
    await settle();
    stdin.write("a");
    await settle();

    const shown = await waitForFrame(lastFrame, /analysis unavailable/);
    assert.match(shown, /analysis unavailable/);

    stdin.write("x");
    await settle();
    assert.equal(done.length, 1);
    unmount();
  });

  test("input during analysis does not double-dismiss", async () => {
    installSuggestionMock("fine as-is", 300);
    const { stdin, lastFrame, done, unmount } = renderPrompt();
    await settle();
    stdin.write("a");
    await settle();
    // Pressing keys mid-flight must not call onDone — only after the result lands.
    stdin.write("q");
    stdin.write("q");
    await settle();
    assert.equal(done.length, 0);
    await waitForFrame(lastFrame, /fine as-is/);
    assert.equal(done.length, 0);
    unmount();
  });
});

// ----------------------------------------------------------------------------
// App — holding the TUI open after a successful run
// ----------------------------------------------------------------------------

async function* successStream(events: Event[]): AsyncGenerator<Event> {
  for (const e of events) yield e;
}

function successEvents(report?: RunReport): Event[] {
  const events: Event[] = [
    { type: "workflow:start", workflow: WORKFLOW },
    { type: "step:start", index: 0, name: "bump-year" },
    { type: "step:complete", index: 0, name: "bump-year", durationMs: 10 },
  ];
  if (report) events.push({ type: "workflow:report", report });
  events.push({
    type: "workflow:complete",
    workflow: WORKFLOW,
    durationMs: 10,
  });
  return events;
}

function renderApp(events: Event[]) {
  return renderTracked(
    React.createElement(App, {
      workflow: WORKFLOW,
      events: successStream(events),
      updateCheck: Promise.resolve(null),
    }),
  );
}

describe("App after a successful run", () => {
  test("holds the TUI open and offers the analyze prompt when no suggestion exists yet", async () => {
    const { lastFrame, unmount } = renderApp(successEvents(REPORT));
    // Well past EXIT_DELAY_MS — without ReportPrompt holding it open the app
    // would have unmounted by now and stopped rendering/responding.
    await new Promise((r) => setTimeout(r, 900));
    assert.match(lastFrame() ?? "", /\[a\] analyze this run/);
    unmount();
  });

  test("exits normally (no prompt) when a suggestion was already generated automatically", async () => {
    const { lastFrame, unmount } = renderApp(
      successEvents({ ...REPORT, suggestion: "already analyzed" }),
    );
    await new Promise((r) => setTimeout(r, 900));
    const frame = lastFrame() ?? "";
    assert.match(frame, /already analyzed/);
    assert.doesNotMatch(frame, /\[a\] analyze this run/);
    unmount();
  });

  test("pressing a key in the prompt eventually lets the app exit", async () => {
    const { stdin, unmount } = renderApp(successEvents(REPORT));
    await new Promise((r) => setTimeout(r, 300));
    stdin.write("x");
    // No assertion beyond "this doesn't hang" — unmount() below would leave a
    // dangling timer/listener if the component never responded to the skip.
    await settle();
    unmount();
  });
});
