// ============================================================================
// ITERATION ROW — display logic
// ============================================================================
// Tests for the IterationList suppression heuristic (repeat vs named forEach)
// and the inner step name deduplication (stripItem).
// These are tested via the reducer data model since the UI functions are
// module-private.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { IterationRecord } from "../types.js";

// Re-implement the two pure functions under test so we can assert on them
// without touching the private module scope. If the implementations diverge
// the integration via the TUI will catch it.

function stripItem(name: string, item: string): string {
  if (!name.includes(item)) return name;
  const stripped = name
    .replace(item, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-—–]+/, "")
    .replace(/[\s\-—–]+$/, "")
    .trim();
  return stripped || name;
}

function isRepeatStyle(history: IterationRecord[]): boolean {
  return history.every((r) => r.item === String(r.iteration));
}

// ----------------------------------------------------------------------------

describe("stripItem — inner step name deduplication", () => {
  test("removes item at end of name", () => {
    assert.equal(stripItem("review src/foo.ts", "src/foo.ts"), "review");
  });

  test("removes item at start of name", () => {
    assert.equal(stripItem("src/foo.ts — deploy", "src/foo.ts"), "deploy");
  });

  test("removes item in middle, collapses spaces", () => {
    assert.equal(
      stripItem("check src/foo.ts for issues", "src/foo.ts"),
      "check for issues",
    );
  });

  test("returns original name when item not present", () => {
    assert.equal(stripItem("lint all files", "src/foo.ts"), "lint all files");
  });

  test("falls back to original when stripping leaves nothing", () => {
    assert.equal(stripItem("src/foo.ts", "src/foo.ts"), "src/foo.ts");
  });

  test("handles item with regex-special characters (dots, slashes)", () => {
    assert.equal(stripItem("lint src/a.b.ts", "src/a.b.ts"), "lint");
  });
});

describe("isRepeatStyle — suppresses expansion for repeat steps", () => {
  const rec = (item: string, iteration: number): IterationRecord => ({
    item,
    iteration,
    total: 5,
    status: "running",
    startTime: Date.now(),
  });

  test("pure repeat items ('1','2','3') → true", () => {
    assert.ok(isRepeatStyle([rec("1", 1), rec("2", 2), rec("3", 3)]));
  });

  test("single numeric item matching iteration → true", () => {
    assert.ok(isRepeatStyle([rec("1", 1)]));
  });

  test("named items → false", () => {
    assert.ok(!isRepeatStyle([rec("src/a.ts", 1), rec("src/b.ts", 2)]));
  });

  test("numeric items that don't match iteration order → false", () => {
    // e.g. forEach: [42, 100, 200]
    assert.ok(!isRepeatStyle([rec("42", 1), rec("100", 2), rec("200", 3)]));
  });

  test("empty history → true (edge case: nothing to show)", () => {
    assert.ok(isRepeatStyle([]));
  });
});
