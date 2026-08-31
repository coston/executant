// ============================================================================
// EVAL HTML REPORT — unit tests
// ============================================================================
// Tests for src/eval/html-report.ts: renderHtmlReport is pure (entries in,
// HTML string out), so everything is asserted on the returned markup.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderHtmlReport } from "../eval/html-report.js";
import type { HistoryEntry } from "../eval/history.js";

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runAt: "2026-01-01T00:00:00.000Z",
    repo: "coston/executant",
    gitSha: "abcdef1234567890abcdef1234567890abcdef12",
    evalName: "sample-eval",
    modelLabel: "claude/sonnet",
    provider: "claude",
    model: "sonnet",
    passCount: 4,
    totalCriteria: 6,
    pct: 4 / 6,
    costUsd: 0.05,
    durationMs: 60_000,
    judgeProvider: "claude",
    judgeModel: "sonnet",
    judgeVersion: "2.1.251",
    judgePromptHash: "prompt-hash-1",
    evalHash: "eval-hash-1",
    comparisonFingerprint: "fingerprint-1",
    ...overrides,
  };
}

describe("renderHtmlReport", () => {
  test("emits a single self-contained document with the purple-dark tokens inline", () => {
    const html = renderHtmlReport([makeEntry()], "all");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /--background: oklch\(/);
    assert.match(html, /--chart-1: oklch\(/);
    // Self-contained: no external fetches of any kind.
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /<link/);
    assert.doesNotMatch(html, /url\(http/);
  });

  test("ranks the leaderboard by each model's latest run, best first", () => {
    const html = renderHtmlReport(
      [
        makeEntry({
          modelLabel: "claude/haiku",
          model: "haiku",
          pct: 0.5,
          passCount: 3,
        }),
        makeEntry({
          modelLabel: "claude/opus",
          model: "opus",
          pct: 1,
          passCount: 6,
        }),
      ],
      "all",
    );
    const opus = html.indexOf("claude/opus");
    const haiku = html.indexOf("claude/haiku");
    assert.ok(opus !== -1 && haiku !== -1);
    assert.ok(opus < haiku, "the higher-scoring model must be ranked first");
  });

  test("marks a regime change between runs with differing fingerprints", () => {
    const html = renderHtmlReport(
      [
        makeEntry({ runAt: "2026-01-01T00:00:00.000Z" }),
        makeEntry({
          runAt: "2026-01-02T00:00:00.000Z",
          comparisonFingerprint: "fingerprint-2",
        }),
      ],
      "all",
    );
    assert.match(html, /class="regime"/);
    assert.match(html, /regime change/);
  });

  test("no marker when every run shares one fingerprint", () => {
    const html = renderHtmlReport(
      [
        makeEntry({ runAt: "2026-01-01T00:00:00.000Z" }),
        makeEntry({ runAt: "2026-01-02T00:00:00.000Z" }),
      ],
      "all",
    );
    assert.doesNotMatch(html, /class="regime"/);
  });

  test("escapes HTML in names sourced from the history file", () => {
    const html = renderHtmlReport(
      [makeEntry({ evalName: '<script>alert("x")</script>' })],
      "all",
    );
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });

  test("labels opencode models LOCAL and claude models API", () => {
    const html = renderHtmlReport(
      [
        makeEntry(),
        makeEntry({
          modelLabel: "opencode/llama-qwen7b/qwen2.5-coder-7b",
          provider: "opencode",
          model: "llama-qwen7b/qwen2.5-coder-7b",
          costUsd: undefined,
        }),
      ],
      "all",
    );
    assert.match(html, />LOCAL</);
    assert.match(html, />API</);
  });

  test("renders a missing cost as an em dash, not $NaN", () => {
    const html = renderHtmlReport([makeEntry({ costUsd: undefined })], "all");
    assert.doesNotMatch(html, /NaN/);
    assert.match(html, /—/);
  });

  test("renders an empty-history message rather than a bare page", () => {
    const html = renderHtmlReport([], "all");
    assert.match(html, /No history records yet/);
  });

  test("renders a 10-bin score-distribution strip per eval card", () => {
    const html = renderHtmlReport(
      [
        makeEntry({
          modelLabel: "claude/haiku",
          model: "haiku",
          pct: 1,
          passCount: 6,
        }),
        makeEntry(),
      ],
      "all",
    );
    assert.equal(html.match(/class="hbar/g)?.length, 10);
    // pct 4/6 ≈ 0.667 lands in the 60–70% bin; pct 1 in the 90–100% bin.
    assert.match(html, /title="60–70%: 1 model\(s\)"/);
    assert.match(html, /title="90–100%: 1 model\(s\)"/);
    assert.match(html, /title="0–10%: 0 model\(s\)"/);
  });

  test("histogram bins on the latest run per model, not every record", () => {
    const html = renderHtmlReport(
      [
        makeEntry({
          runAt: "2026-01-01T00:00:00.000Z",
          pct: 0.1,
          passCount: 1,
        }),
        makeEntry({ runAt: "2026-01-02T00:00:00.000Z", pct: 1, passCount: 6 }),
      ],
      "all",
    );
    assert.match(html, /title="90–100%: 1 model\(s\)"/);
    assert.match(html, /title="10–20%: 0 model\(s\)"/);
  });
});
