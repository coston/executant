// ============================================================================
// APP NON-TTY REGRESSION TEST
// ============================================================================
// Regression test for a real bug hit while building output-pane scroll/resize:
// ink's `isRawModeSupported` is `stdin.isTTY`, which Node leaves `undefined`
// (not `false`) on a non-TTY stdin (e.g. executant's output piped to a file
// or another command). `useInput`'s `isActive` option only treats a literal
// `false` as "inactive" — anything else, including `undefined`, defaults to
// active — so a naive `&&` chain computing `enabled` for useOutputResize's
// useInput call could evaluate to `undefined` instead of `false` and still
// be treated as active, which crashes Ink with "Raw mode is not supported on
// the current process.stdin" as soon as that hook mounts. This only ever
// showed up against a real non-TTY process.stdin — ink-testing-library's
// mock stdin defaults `isTTY: true`, so every other App test in this suite
// runs the isActive:true path and would not have caught it.
//
// This constructs a minimal fake stdin/stdout by hand (mirroring what
// ink-testing-library does internally) with `isTTY: undefined`, and drives
// ink's real `render()` directly rather than going through
// ink-testing-library, which offers no way to override isTTY. The step must
// stay "running" for a real wall-clock stretch before this test asserts
// anything: a synchronous burst of dispatches (workflow:start immediately
// followed by workflow:complete) gets batched by React into too few commits
// to ever land on the vulnerable "step running on a non-TTY" render at all.

import "./force-non-ci.js"; // must evaluate before any ink import — see its header
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import React from "react";
import { render } from "ink";
import { App } from "../ui/App.js";
import type { Event, Workflow } from "../types.js";

class FakeStdin extends EventEmitter {
  isTTY: boolean | undefined = undefined;
  setRawMode(_enabled: boolean) {
    // A real non-TTY stdin has no setRawMode at all in practice, but Ink
    // only calls it after checking isRawModeSupported — this exists purely
    // so nothing throws if that guard is ever bypassed.
  }
  setEncoding() {}
  ref() {}
  unref() {}
  resume() {}
  pause() {}
  read() {
    return null;
  }
}

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 24;
  frames: string[] = [];
  write(data: string) {
    this.frames.push(data);
    return true;
  }
  lastFrame() {
    return this.frames.at(-1);
  }
}

const WORKFLOW: Workflow = {
  goal: "non-tty smoke test",
  sourcePath: "/tmp/task.yaml",
  tasks: [{ type: "command", name: "step-1", command: "true" }],
};

async function* runningStream(): AsyncGenerator<Event> {
  yield { type: "workflow:start", workflow: WORKFLOW };
  yield { type: "step:start", index: 0, name: "step-1" };
  // Hold on the "step running" render — the one where showOutputPane is
  // true and isRawModeSupported is undefined — long enough for React's
  // passive effects to actually flush and hit the bug, instead of the whole
  // run resolving inside one batched commit.
  await new Promise((r) => setTimeout(r, 1000));
}

describe("App on a non-TTY stdin", () => {
  test("never calls setRawMode(true) while a step is running", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const stderr = new FakeStdout();
    let rawModeCalledWithTrue = false;
    stdin.setRawMode = (enabled: boolean) => {
      if (enabled) rawModeCalledWithTrue = true;
    };

    const instance = render(
      React.createElement(App, {
        workflow: WORKFLOW,
        events: runningStream(),
        updateCheck: Promise.resolve(null),
      }),
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    // The unmount must happen even if an assertion below fails: a live Ink
    // instance keeps timers and stdin listeners on the event loop, so an
    // un-unmounted failure hangs this process forever and, under
    // `node --test`, wedges the whole suite instead of reporting a failure.
    try {
      // Deliberately a fixed wait, not "poll until step-1 appears" — that
      // text is already on screen in the very first frame (before step-1
      // even starts running), so a content-based exit condition would return
      // before the vulnerable effect ever gets a chance to flush.
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(
        rawModeCalledWithTrue,
        false,
        "setRawMode(true) must never be called when the stdin is not a TTY",
      );
      const frame = stdout.lastFrame() ?? "";
      assert.doesNotMatch(frame, /Raw mode is not supported/);
      assert.match(frame, /step-1/);
    } finally {
      instance.unmount();
    }
  });
});
