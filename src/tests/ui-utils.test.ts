// ============================================================================
// UI UTILS — unit tests
// ============================================================================
// Tests for src/ui/utils.ts: countIterationRows

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clamp, countIterationRows } from "../ui/utils.js";
import type { IterationRecord } from "../types.js";

const MAX = 8;

function makeRecord(
  iteration: number,
  total: number,
  item?: string,
): IterationRecord {
  return {
    item: item ?? `item-${iteration}`,
    iteration,
    total,
    status: "complete",
    startTime: 0,
  };
}

// ----------------------------------------------------------------------------
// countIterationRows
// ----------------------------------------------------------------------------

describe("countIterationRows", () => {
  test("returns 0 for undefined history", () => {
    assert.equal(countIterationRows(undefined, MAX), 0);
  });

  test("returns 0 for empty history", () => {
    assert.equal(countIterationRows([], MAX), 0);
  });

  test("returns 0 for repeat-style history (item === String(iteration))", () => {
    const history = [
      { ...makeRecord(1, 3), item: "1" },
      { ...makeRecord(2, 3), item: "2" },
      { ...makeRecord(3, 3), item: "3" },
    ];
    assert.equal(countIterationRows(history, MAX), 0);
  });

  test("returns visible count when items are not repeat-style and count ≤ maxVisible", () => {
    const history = [makeRecord(1, 3), makeRecord(2, 3), makeRecord(3, 3)];
    assert.equal(countIterationRows(history, MAX), 3);
  });

  test("returns maxVisible when count equals maxVisible exactly", () => {
    const history = Array.from({ length: MAX }, (_, i) =>
      makeRecord(i + 1, MAX),
    );
    assert.equal(countIterationRows(history, MAX), MAX);
  });

  test('returns maxVisible + 1 when count exceeds maxVisible (extra row for "… N earlier")', () => {
    const history = Array.from({ length: MAX + 3 }, (_, i) =>
      makeRecord(i + 1, MAX + 3),
    );
    assert.equal(countIterationRows(history, MAX), MAX + 1);
  });

  test("mixed history where only some items match iteration number is not repeat-style", () => {
    // Only ALL items must match for repeat-style — partial match is forEach
    const history = [
      { ...makeRecord(1, 2), item: "1" },
      { ...makeRecord(2, 2), item: "src/foo.ts" },
    ];
    assert.equal(countIterationRows(history, MAX), 2);
  });
});

// ----------------------------------------------------------------------------
// clamp
// ----------------------------------------------------------------------------

describe("clamp", () => {
  test("returns the value unchanged when within range", () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  test("clamps to the minimum", () => {
    assert.equal(clamp(-5, 0, 10), 0);
  });

  test("clamps to the maximum", () => {
    assert.equal(clamp(15, 0, 10), 10);
  });

  test("min equal to max pins the value", () => {
    assert.equal(clamp(15, 7, 7), 7);
  });

  test("an inverted range (min > max) still returns a bounded value", () => {
    assert.equal(clamp(15, 10, 3), 10);
    assert.equal(clamp(-15, 10, 3), 10);
  });
});
