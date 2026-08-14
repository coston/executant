// ============================================================================
// STATUSLINE UI TESTS
// ============================================================================
// Renders the real App with a project directory containing a .claude/settings
// statusLine command, verifying the footer picks up its output — and stays
// silent when nothing is configured or the feature is disabled.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { App } from "../ui/App.js";
import type { Event, Workflow } from "../types.js";

const WORKFLOW: Workflow = {
  goal: "test goal",
  sourcePath: "/tmp/task.yaml",
  tasks: [{ type: "command", name: "step-1", command: "true" }],
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

describe("App statusline", () => {
  let projectDir: string;
  let originalCwd: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = process.env["EXECUTANT_STATUSLINE"];
    projectDir = mkdtempSync(join(tmpdir(), "executant-statusline-app-"));
  });

  afterEach(() => {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env["EXECUTANT_STATUSLINE"];
    else process.env["EXECUTANT_STATUSLINE"] = originalEnv;
    rmSync(projectDir, { recursive: true, force: true });
  });

  function configureStatusLine(command: string) {
    const claudeDir = join(projectDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command } }),
    );
    process.chdir(projectDir);
  }

  test("shows the configured statusLine command's output in the footer", async () => {
    configureStatusLine("printf 'bedrock spend today: 3.21\\n'");
    const { lastFrame, unmount } = render(
      React.createElement(App, {
        workflow: WORKFLOW,
        events: runningStream(RUNNING_EVENTS),
        updateCheck: Promise.resolve(null),
      }),
    );
    await waitForFrame(lastFrame, /bedrock spend today: 3\.21/);
    assert.match(lastFrame() ?? "", /bedrock spend today: 3\.21/);
    unmount();
  });

  test("shows nothing extra when no statusLine is configured", async () => {
    process.chdir(projectDir); // .claude/settings.json deliberately absent
    const { lastFrame, unmount } = render(
      React.createElement(App, {
        workflow: WORKFLOW,
        events: runningStream(RUNNING_EVENTS),
        updateCheck: Promise.resolve(null),
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? "", /press q to quit/);
    unmount();
  });

  test("EXECUTANT_STATUSLINE=0 disables it even when configured", async () => {
    configureStatusLine("printf 'should not appear\\n'");
    process.env["EXECUTANT_STATUSLINE"] = "0";
    const { lastFrame, unmount } = render(
      React.createElement(App, {
        workflow: WORKFLOW,
        events: runningStream(RUNNING_EVENTS),
        updateCheck: Promise.resolve(null),
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(lastFrame() ?? "", /should not appear/);
    unmount();
  });
});
