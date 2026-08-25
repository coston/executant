// ============================================================================
// LOG PANE SCROLL — unit tests
// ============================================================================
// LogPane is a pure presentational component, so these render it directly
// with ink-testing-library rather than going through the full App — no event
// stream or reducer needed to verify the scroll-offset windowing math.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { LogPane } from "../ui/LogPane.js";
import { withInk } from "./ink-harness.js";

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

describe("LogPane scrolling", () => {
  test("pinned to the tail (offset 0) shows the last maxLines lines, no indicator", async () => {
    await withInk(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 0,
      }),
      ({ lastFrame }) => {
        const frame = lastFrame() ?? "";
        assert.match(frame, /line 16/);
        assert.match(frame, /line 20/);
        assert.doesNotMatch(frame, /line 15/);
        assert.doesNotMatch(frame, /scrolled up/);
      },
    );
  });

  test("scrolling up shows earlier lines and the scroll indicator", async () => {
    await withInk(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 5,
      }),
      ({ lastFrame }) => {
        const frame = lastFrame() ?? "";
        // One row of the 5-line budget is spent on the indicator, so 4
        // content lines are visible, ending 5 lines back from the tail.
        assert.match(frame, /line 15/);
        assert.doesNotMatch(frame, /line 20/);
        assert.match(frame, /scrolled up 5 lines/);
      },
    );
  });

  test("scroll offset beyond available history clamps instead of going blank", async () => {
    await withInk(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 1000,
      }),
      ({ lastFrame }) => {
        // Clamped to the oldest possible window — line 1 stays visible.
        assert.match(lastFrame() ?? "", /line 1\b/);
      },
    );
  });

  test("box height never exceeds maxLines content rows regardless of scroll state", async () => {
    const countRows = (frame: string) => frame.split("\n").length;
    await withInk(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 0,
      }),
      (pinned) =>
        withInk(
          React.createElement(LogPane, {
            lines: LINES,
            maxLines: 5,
            scrollOffset: 3,
          }),
          (scrolled) => {
            // Both include 2 border rows; scrolled trades one content row
            // for the indicator, so the row count must match, not grow.
            assert.equal(
              countRows(pinned.lastFrame() ?? ""),
              countRows(scrolled.lastFrame() ?? ""),
            );
          },
        ),
    );
  });

  test("cursor is not shown while scrolled up, even when isActive", async () => {
    await withInk(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 5,
        isActive: true,
      }),
      ({ lastFrame }) => {
        assert.doesNotMatch(lastFrame() ?? "", /▌/);
      },
    );
  });

  test("cursor shows on the last line when pinned and isActive", async () => {
    await withInk(
      React.createElement(LogPane, {
        lines: LINES,
        maxLines: 5,
        scrollOffset: 0,
        isActive: true,
      }),
      ({ lastFrame }) => {
        assert.match(lastFrame() ?? "", /▌/);
      },
    );
  });
});
