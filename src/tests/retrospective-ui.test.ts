// ============================================================================
// RETROSPECTIVE UI TESTS
// ============================================================================
// Renders the real Ink components and drives them with real keystrokes, which
// is the only way to cover the two pieces of behaviour that matter most and
// are not expressible as pure functions:
//   - RetrospectivePane: selection, shortcut keys, and the output toggle
//   - App: holding the TUI open on a failure instead of exiting, and still
//     exiting normally when the terminal cannot take keyboard input
//
// ink-testing-library's stdin reports isTTY and implements setRawMode, so
// Ink's useInput is live and `stdin.write("u")` behaves like a real keypress.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";

import { App } from "../ui/App.js";
import { RetrospectivePane } from "../ui/RetrospectivePane.js";
import type { Event, Retrospective, Workflow } from "../types.js";

const RETRO: Retrospective = {
  step: "check-dist",
  summary: "The step failed because dist/ was never created.",
  rootCause: "No build step runs before the check.",
  evidence: ["ls: dist: No such file or directory"],
  suggestions: [
    {
      step: "check-dist",
      issue: "assumes a build that never runs",
      change: "add a build step before it",
      severity: "high",
    },
  ],
  workflowFixable: true,
  refineInstruction: "Add a build step before check-dist.",
};

/** Lets Ink flush its render and input handling before assertions. */
const settle = () => new Promise((r) => setTimeout(r, 60));

function renderPane(
  props: Partial<React.ComponentProps<typeof RetrospectivePane>> = {},
) {
  const actions: string[] = [];
  const app = render(
    React.createElement(RetrospectivePane, {
      retrospective: RETRO,
      sourcePath: "/tmp/task.yaml",
      maxRows: 40,
      onAction: (a: string) => actions.push(a),
      ...props,
    }),
  );
  return { ...app, actions };
}

describe("RetrospectivePane rendering", () => {
  test("shows the summary, root cause, evidence, and suggestions", () => {
    const { lastFrame } = renderPane();
    const frame = lastFrame() ?? "";
    assert.match(frame, /retrospective — check-dist/);
    assert.match(frame, /dist\/ was never created/);
    assert.match(frame, /No build step runs before the check/);
    assert.match(frame, /No such file or directory/);
    assert.match(frame, /add a build step before it/);
  });

  test("offers the update action when the workflow is at fault", () => {
    const frame = renderPane().lastFrame() ?? "";
    assert.match(frame, /\[u\] Update the task file/);
    assert.match(frame, /\[d\] Dismiss/);
  });

  test("offers only dismiss when no workflow change would help", () => {
    const frame =
      renderPane({
        retrospective: {
          ...RETRO,
          workflowFixable: false,
          refineInstruction: "",
        },
      }).lastFrame() ?? "";
    assert.doesNotMatch(frame, /\[u\] Update the task file/);
    assert.match(frame, /No workflow change would have prevented this/);
  });

  test("renders no actions at all when it is not interactive", () => {
    const frame = renderPane({ onAction: undefined }).lastFrame() ?? "";
    assert.doesNotMatch(frame, /\[d\] Dismiss/);
    assert.match(frame, /dist\/ was never created/);
  });
});

describe("RetrospectivePane keyboard", () => {
  test("u dispatches the update action", async () => {
    const { stdin, actions } = renderPane();
    await settle();
    stdin.write("u");
    await settle();
    assert.deepEqual(actions, ["update"]);
  });

  test("d dispatches dismiss", async () => {
    const { stdin, actions } = renderPane();
    await settle();
    stdin.write("d");
    await settle();
    assert.deepEqual(actions, ["dismiss"]);
  });

  test("enter confirms the highlighted action", async () => {
    const { stdin, actions } = renderPane();
    await settle();
    stdin.write("\r");
    await settle();
    assert.deepEqual(actions, ["update"]); // update is selected first
  });

  test("arrow keys move the selection before enter confirms it", async () => {
    const { stdin, actions } = renderPane();
    await settle();
    stdin.write("[B"); // down
    await settle();
    stdin.write("\r");
    await settle();
    assert.deepEqual(actions, ["dismiss"]);
  });

  test("escape dismisses without updating the task file", async () => {
    const { stdin, actions } = renderPane();
    await settle();
    stdin.write("");
    await settle();
    assert.deepEqual(actions, ["dismiss"]);
  });

  test("o toggles to the raw step output and back", async () => {
    const { stdin, lastFrame, actions } = renderPane({
      outputLines: ["ls: dist: No such file or directory", "exit status 1"],
    });
    await settle();
    assert.match(lastFrame() ?? "", /\[o\] show the step output/);

    stdin.write("o");
    await settle();
    const shown = lastFrame() ?? "";
    assert.match(shown, /output from check-dist/);
    assert.match(shown, /exit status 1/);
    // The analysis is hidden while the output is up, and o is not an action.
    assert.doesNotMatch(shown, /root cause/);
    assert.deepEqual(actions, []);

    stdin.write("o");
    await settle();
    assert.match(lastFrame() ?? "", /root cause/);
  });

  test("the output toggle is not offered when there is no output", async () => {
    const { stdin, lastFrame } = renderPane({ outputLines: [] });
    await settle();
    assert.doesNotMatch(lastFrame() ?? "", /\[o\]/);
    stdin.write("o");
    await settle();
    assert.match(lastFrame() ?? "", /root cause/);
  });
});

// ----------------------------------------------------------------------------
// App — the exit-on-failure branch
// ----------------------------------------------------------------------------

const WORKFLOW: Workflow = {
  goal: "test goal",
  sourcePath: "/tmp/task.yaml",
  tasks: [{ type: "command", name: "check-dist", command: "ls dist" }],
};

/** Replays a fixed event stream, then throws like the runner does on failure. */
async function* failingStream(events: Event[]): AsyncGenerator<Event> {
  for (const e of events) yield e;
  throw new Error('Command "check-dist" exited with code 1');
}

const FAILURE_EVENTS: Event[] = [
  { type: "workflow:start", workflow: WORKFLOW },
  { type: "step:start", index: 0, name: "check-dist" },
  { type: "output:text", index: 0, text: "ls: dist: No such file" },
  {
    type: "step:error",
    index: 0,
    name: "check-dist",
    error: new Error("exited with code 1"),
    lastOutput: "ls: dist: No such file",
  },
  { type: "step:retrospective", index: 0, retrospective: RETRO },
];

function renderApp() {
  const updated: Retrospective[] = [];
  const app = render(
    React.createElement(App, {
      workflow: WORKFLOW,
      events: failingStream(FAILURE_EVENTS),
      updateCheck: Promise.resolve(null),
      onUpdateTaskFile: (r: Retrospective) => updated.push(r),
    }),
  );
  return { ...app, updated };
}

describe("App on a fatal failure", () => {
  test("holds the TUI open and interactive instead of exiting", async () => {
    const original = process.exitCode;
    const { lastFrame, stdin, updated, unmount } = renderApp();
    // Well past EXIT_DELAY_MS — without the retrospective the app would have
    // unmounted by now and stopped responding to input.
    await new Promise((r) => setTimeout(r, 900));
    assert.match(lastFrame() ?? "", /retrospective — check-dist/);
    assert.match(lastFrame() ?? "", /\[u\] Update the task file/);
    // The failure is still reported through the exit code.
    assert.equal(process.exitCode, 1);
    // Still live: a keypress this long after the failure is still handled.
    // A rendered-but-dead frame would leave this empty.
    stdin.write("u");
    await settle();
    assert.equal(updated.length, 1);
    unmount();
    process.exitCode = original;
  });

  test("u hands the retrospective back for the caller to refine", async () => {
    const original = process.exitCode;
    const { stdin, updated, unmount } = renderApp();
    await new Promise((r) => setTimeout(r, 300));
    stdin.write("u");
    await settle();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].refineInstruction, RETRO.refineInstruction);
    unmount();
    process.exitCode = original;
  });

  test("without a retrospective the failure path is untouched", async () => {
    const original = process.exitCode;
    const updated: Retrospective[] = [];
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, {
        workflow: WORKFLOW,
        // Same failure, minus the step:retrospective event.
        events: failingStream(FAILURE_EVENTS.slice(0, -1)),
        updateCheck: Promise.resolve(null),
        onUpdateTaskFile: (r: Retrospective) => updated.push(r),
      }),
    );
    await new Promise((r) => setTimeout(r, 900));
    assert.doesNotMatch(lastFrame() ?? "", /retrospective/);
    assert.equal(process.exitCode, 1);
    // Nothing is listening for actions — the app exited on its own.
    stdin.write("u");
    await settle();
    assert.deepEqual(updated, []);
    unmount();
    process.exitCode = original;
  });

  test("dismissing does not ask the caller to touch the task file", async () => {
    const original = process.exitCode;
    const { stdin, updated, unmount } = renderApp();
    await new Promise((r) => setTimeout(r, 300));
    stdin.write("d");
    await settle();
    assert.deepEqual(updated, []);
    unmount();
    process.exitCode = original;
  });

  test("hides the task list so the pane cannot overflow the terminal", async () => {
    const original = process.exitCode;
    const { lastFrame, unmount } = renderApp();
    await new Promise((r) => setTimeout(r, 300));
    // The step row (rendered as "1. check-dist" by TaskRow) is gone; only the
    // pane's own title mentions the step now.
    assert.doesNotMatch(lastFrame() ?? "", /1\. check-dist/);
    unmount();
    process.exitCode = original;
  });
});
