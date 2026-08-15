// ============================================================================
// LOG PANE SCROLL — unit tests
// ============================================================================
// LogPane is a pure presentational component, so these render it directly
// with ink-testing-library rather than going through the full App — no event
// stream or reducer needed to verify the scroll-offset windowing math.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { LogPane } from "../ui/LogPane.js";

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

describe("LogPane scrolling", () => {
  test("pinned to the tail (offset 0) shows the last maxLines lines, no indicator", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 0,
      }),
    );
    const frame = lastFrame() ?? "";
    assert.match(frame, /line 16/);
    assert.match(frame, /line 20/);
    assert.doesNotMatch(frame, /line 15/);
    assert.doesNotMatch(frame, /scrolled up/);
    unmount();
  });

  test("scrolling up shows earlier lines and the scroll indicator", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 5,
      }),
    );
    const frame = lastFrame() ?? "";
    // One row of the 5-line budget is spent on the indicator, so 4 content
    // lines are visible, ending 5 lines back from the tail (line 15).
    assert.match(frame, /line 15/);
    assert.doesNotMatch(frame, /line 20/);
    assert.match(frame, /scrolled up 5 lines/);
    unmount();
  });

  test("scroll offset beyond available history clamps instead of going blank", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 1000,
      }),
    );
    const frame = lastFrame() ?? "";
    // Clamped to the oldest possible window — line 1 must still be visible.
    assert.match(frame, /line 1\b/);
    unmount();
  });

  test("box height never exceeds maxLines content rows regardless of scroll state", () => {
    const pinned = render(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 0,
      }),
    );
    const scrolled = render(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 3,
      }),
    );
    const countRows = (frame: string) => frame.split("\n").length;
    // Both include 2 border rows; scrolled trades one content row for the
    // indicator, so total row count must match, not grow.
    assert.equal(
      countRows(pinned.lastFrame() ?? ""),
      countRows(scrolled.lastFrame() ?? ""),
    );
    pinned.unmount();
    scrolled.unmount();
  });

  test("cursor is not shown while scrolled up, even when isActive", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 5,
        isActive: true,
      }),
    );
    assert.doesNotMatch(lastFrame() ?? "", /▌/);
    unmount();
  });

  test("cursor shows on the last line when pinned and isActive", () => {
    const { lastFrame, unmount } = render(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 0,
        isActive: true,
      }),
    );
    assert.match(lastFrame() ?? "", /▌/);
    unmount();
  });
});
