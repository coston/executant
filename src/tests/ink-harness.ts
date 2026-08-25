// ============================================================================
// INK TEST HARNESS
// ============================================================================
// Shared helpers for the tests that render the real Ink TUI.
//
// Not a *.test.ts file, so `npm test`'s glob never picks it up as a suite.
//
// Why this exists: an Ink instance holds timers, stdin listeners and Ink's own
// render loop, all of which keep the event loop alive. A test that asserts
// before calling unmount() therefore turns a *failed assertion* into a process
// that never exits — and under `node --test`, one such file hangs the entire
// suite indefinitely rather than reporting a failure. That is exactly what
// happened: under CPU contention a frame assertion in app-output-pane-ui
// missed its deadline and the run wedged for as long as it was allowed to.
//
// withInk() makes the unmount unconditional, so a failure stays a failure.

import { render } from "ink-testing-library";
import type { ReactElement } from "react";

type Instance = ReturnType<typeof render>;

/**
 * Renders an Ink element, runs `body` against it, and unmounts no matter what.
 * Always prefer this over a bare render()/unmount() pair — a thrown assertion
 * between the two is what wedges the suite.
 */
export async function withInk<T>(
  element: ReactElement,
  body: (ink: Instance) => Promise<T> | T,
): Promise<T> {
  const ink = render(element);
  try {
    return await body(ink);
  } finally {
    ink.unmount();
  }
}

/**
 * Instances created via renderTracked, so a failing test's Ink tree is torn
 * down by an afterEach hook rather than by a line the failure skipped past.
 */
const live = new Set<Instance>();

/**
 * render(), but the instance is remembered for unmountAllInk(). Use in a file
 * whose tests share a render factory, paired with `afterEach(unmountAllInk)`;
 * prefer withInk() where a single test owns the whole lifetime.
 */
export function renderTracked(element: ReactElement): Instance {
  const ink = render(element);
  live.add(ink);
  return ink;
}

/**
 * Unmounts every tracked instance. Safe to call when a test already unmounted
 * its own instance — Ink's unmount is idempotent.
 */
export function unmountAllInk(): void {
  for (const ink of live) {
    try {
      ink.unmount();
    } catch {
      /* already gone */
    }
  }
  live.clear();
}

/**
 * How long a frame assertion waits before giving up. Deliberately generous:
 * these tests run 40+ node processes in parallel, each with its own esbuild
 * transform service, so first paint can be far slower than on an idle machine.
 * A long deadline costs nothing when the condition is met — it is only ever
 * paid on a genuine failure, where a clear message beats a fast one.
 */
const FRAME_TIMEOUT_MS = 15_000;

/** Poll interval while waiting for a frame to satisfy its condition. */
const POLL_MS = 20;

/**
 * Waits until the latest frame matches, then returns it. Throws with the last
 * frame rendered if the deadline passes, rather than returning a stale frame
 * for the caller to fail an assertion on — a timeout and a genuinely wrong
 * frame are different bugs and should not produce the same message.
 */
export async function waitForFrame(
  frame: () => string | undefined,
  match: RegExp | ((frame: string) => boolean),
  options: { timeoutMs?: number; describe?: string } = {},
): Promise<string> {
  const { timeoutMs = FRAME_TIMEOUT_MS, describe } = options;
  const matches = (f: string) =>
    typeof match === "function" ? match(f) : match.test(f);
  const deadline = Date.now() + timeoutMs;
  let last = frame() ?? "";
  while (Date.now() < deadline) {
    last = frame() ?? "";
    if (matches(last)) return last;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${describe ?? String(match)}\n` +
      `last frame was:\n${last}`,
  );
}

/**
 * A fixed pause, for the cases that assert something must NOT appear — those
 * cannot poll for a condition, since there is no condition to reach. Anything
 * asserting a positive outcome should use waitForFrame instead, which adapts
 * to a slow machine rather than racing it.
 */
export const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
