// ============================================================================
// MOUSE RESIZE — unit tests
// ============================================================================
// Tests for src/ui/mouseResize.ts: the pure SGR-mouse/DSR parsing and drag
// math that backs the output pane's mouse drag-to-resize. No terminal or Ink
// component involved — these are the only parts of that feature that can be
// exercised without a real terminal, so they're tested exhaustively.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyDragDelta,
  computeOriginRow,
  isOnBorderRow,
  parseCursorPositionReport,
  parseSgrMouseEvents,
} from "../ui/mouseResize.js";

describe("parseSgrMouseEvents", () => {
  test("parses a left-button press as a down event", () => {
    const events = parseSgrMouseEvents("\x1b[<0;10;20M");
    assert.deepEqual(events, [{ button: 0, x: 10, y: 20, type: "down" }]);
  });

  test("parses a release (lowercase suffix) as an up event", () => {
    const events = parseSgrMouseEvents("\x1b[<0;10;20m");
    assert.deepEqual(events, [{ button: 0, x: 10, y: 20, type: "up" }]);
  });

  test("parses a motion report (button bit 32 set) as a move event", () => {
    // 32 = motion flag, 0 = left button still held -> Cb = 32
    const events = parseSgrMouseEvents("\x1b[<32;10;25M");
    assert.deepEqual(events, [{ button: 0, x: 10, y: 25, type: "move" }]);
  });

  test("parses multiple events in one chunk, in order", () => {
    const chunk = "\x1b[<0;5;5M\x1b[<32;5;6M\x1b[<32;5;7M\x1b[<0;5;7m";
    const events = parseSgrMouseEvents(chunk);
    assert.deepEqual(
      events.map((e) => e.type),
      ["down", "move", "move", "up"],
    );
    assert.deepEqual(
      events.map((e) => e.y),
      [5, 6, 7, 7],
    );
  });

  test("returns an empty array for text with no mouse sequences", () => {
    assert.deepEqual(parseSgrMouseEvents("just some plain output\n"), []);
  });

  test("ignores non-mouse escape sequences (e.g. an arrow key)", () => {
    assert.deepEqual(parseSgrMouseEvents("\x1b[A"), []);
  });
});

describe("parseCursorPositionReport", () => {
  test("parses a DSR cursor position reply", () => {
    assert.deepEqual(parseCursorPositionReport("\x1b[12;1R"), {
      row: 12,
      col: 1,
    });
  });

  test("returns null when no report is present", () => {
    assert.equal(parseCursorPositionReport("no report here"), null);
  });

  test("finds the report even mixed in with other bytes", () => {
    assert.deepEqual(
      parseCursorPositionReport("\x1b[<0;1;1M\x1b[40;7Rtrailing"),
      { row: 40, col: 7 },
    );
  });
});

describe("computeOriginRow", () => {
  test("recovers the frame's first row from the post-render cursor position", () => {
    // A 20-row frame rendered starting at absolute row 3 leaves the cursor
    // one row past the last line, i.e. at row 3 + 20 = 23.
    assert.equal(computeOriginRow(23, 20), 3);
  });

  test("origin row 1 when the frame starts at the very top of the terminal", () => {
    assert.equal(computeOriginRow(21, 20), 1);
  });
});

describe("isOnBorderRow", () => {
  test("true exactly on the border row", () => {
    assert.equal(isOnBorderRow(10, 10, 1), true);
  });

  test("true within tolerance above and below", () => {
    assert.equal(isOnBorderRow(9, 10, 1), true);
    assert.equal(isOnBorderRow(11, 10, 1), true);
  });

  test("false outside tolerance", () => {
    assert.equal(isOnBorderRow(8, 10, 1), false);
    assert.equal(isOnBorderRow(12, 10, 1), false);
  });

  test("zero tolerance requires an exact match", () => {
    assert.equal(isOnBorderRow(10, 10, 0), true);
    assert.equal(isOnBorderRow(9, 10, 0), false);
  });
});

describe("applyDragDelta", () => {
  test("grows the height by the drag delta", () => {
    assert.equal(applyDragDelta(10, 5, 3, 50), 15);
  });

  test("shrinks the height by a negative delta", () => {
    assert.equal(applyDragDelta(10, -4, 3, 50), 6);
  });

  test("clamps to the minimum", () => {
    assert.equal(applyDragDelta(10, -100, 3, 50), 3);
  });

  test("clamps to the maximum", () => {
    assert.equal(applyDragDelta(10, 100, 3, 50), 50);
  });

  test("degenerate min > max still returns a value within [min, min]", () => {
    // Guards the case where the terminal is so small autoMaxRows dips below
    // MIN_OUTPUT_ROWS — the caller's Math.max already prevents this in
    // practice, but the math itself should never throw or invert.
    assert.equal(applyDragDelta(10, 5, 10, 3), 10);
  });
});
