// ============================================================================
// EVAL HISTORY — unit tests
// ============================================================================
// Tests for src/eval/history.ts: appendHistory/loadHistory persistence and
// buildTrends grouping, strict-vs-all filtering, and regime-change markers.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  toHistoryEntries,
  appendHistory,
  loadHistory,
  buildTrends,
} from "../eval/history.js";
import { recordHistory } from "../eval/index.js";
import type { EvalComparison, RunProvenance } from "../eval/types.js";

const _cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of _cleanupDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `eval-history-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  _cleanupDirs.push(dir);
  return dir;
}

function makeProvenance(overrides: Partial<RunProvenance> = {}): RunProvenance {
  return {
    runAt: "2026-01-01T00:00:00.000Z",
    repo: "coston/executant",
    gitSha: "sha1",
    judgeProvider: "claude",
    judgeModel: "sonnet",
    judgeVersion: "2.1.251",
    judgePromptHash: "prompt-hash-1",
    evalHash: "eval-hash-1",
    comparisonFingerprint: "fingerprint-1",
    ...overrides,
  };
}

function makeComparison(
  overrides: Partial<EvalComparison> = {},
): EvalComparison {
  const model = { provider: "claude" as const, model: "sonnet" };
  return {
    evalName: "sample-eval",
    templatePath: "/fake/prompt.txt",
    models: [model],
    runs: [
      {
        evalName: "sample-eval",
        templatePath: "/fake/prompt.txt",
        model,
        results: [
          {
            caseId: "case-1",
            output: "out",
            criteria: [{ criterion: "C1", pass: true, reason: "ok" }],
            passCount: 1,
            failCount: 0,
            durationMs: 500,
            costUsd: 0.01,
          },
        ],
        totalPass: 1,
        totalCriteria: 1,
        totalCostUsd: 0.01,
      },
    ],
    comparisonTable: [],
    provenance: makeProvenance(),
    ...overrides,
  };
}

describe("toHistoryEntries", () => {
  test("produces one entry per model run, carrying provenance", () => {
    const c = makeComparison();
    const entries = toHistoryEntries(c);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.evalName, "sample-eval");
    assert.equal(entries[0]!.modelLabel, "claude/sonnet");
    assert.equal(entries[0]!.passCount, 1);
    assert.equal(entries[0]!.totalCriteria, 1);
    assert.equal(entries[0]!.pct, 1);
    assert.equal(entries[0]!.costUsd, 0.01);
    assert.equal(entries[0]!.durationMs, 500);
    assert.equal(entries[0]!.gitSha, "sha1");
    assert.equal(entries[0]!.comparisonFingerprint, "fingerprint-1");
  });
});

describe("appendHistory / loadHistory", () => {
  test("round-trips entries through a JSONL file", () => {
    const dir = tmpDir();
    const historyPath = join(dir, "history.jsonl");
    appendHistory(makeComparison(), historyPath);

    const loaded = loadHistory(historyPath);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.evalName, "sample-eval");
  });

  test("appends across multiple calls rather than overwriting", () => {
    const dir = tmpDir();
    const historyPath = join(dir, "history.jsonl");
    appendHistory(
      makeComparison({
        provenance: makeProvenance({ runAt: "2026-01-01T00:00:00.000Z" }),
      }),
      historyPath,
    );
    appendHistory(
      makeComparison({
        provenance: makeProvenance({ runAt: "2026-01-02T00:00:00.000Z" }),
      }),
      historyPath,
    );

    const loaded = loadHistory(historyPath);
    assert.equal(loaded.length, 2);
  });

  test("loadHistory returns [] when the file doesn't exist", () => {
    assert.deepEqual(loadHistory("/nonexistent/history.jsonl"), []);
  });

  test("creates parent directories as needed", () => {
    const dir = tmpDir();
    const historyPath = join(dir, "nested", "dir", "history.jsonl");
    appendHistory(makeComparison(), historyPath);
    assert.equal(loadHistory(historyPath).length, 1);
  });

  test("recordHistory refuses to append when any result was resumed from a CSV", () => {
    // A cached score was produced under the *previous* run's provenance;
    // stamping it with today's runAt/gitSha/fingerprint fabricates a trend
    // point that never happened.
    const dir = tmpDir();
    const historyPath = join(dir, "history.jsonl");

    const cached = makeComparison();
    cached.runs = [{ ...cached.runs[0]!, cachedCount: 1 }];
    recordHistory(cached, historyPath);
    assert.deepEqual(loadHistory(historyPath), []);

    recordHistory(makeComparison(), historyPath);
    assert.equal(loadHistory(historyPath).length, 1);
  });

  test("skips a corrupt line instead of losing the whole log", () => {
    // A half-written trailing line is what an interrupted append leaves
    // behind; it must cost one warning, not the entire history.
    const dir = tmpDir();
    const historyPath = join(dir, "history.jsonl");
    appendHistory(makeComparison(), historyPath);
    appendFileSync(historyPath, '{"runAt":"2026-01-02T00:0', "utf8");

    const loaded = loadHistory(historyPath);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.evalName, "sample-eval");
  });
});

describe("buildTrends", () => {
  test("groups entries by eval+model and sorts by runAt", () => {
    const entries = [
      {
        ...toHistoryEntries(makeComparison())[0]!,
        runAt: "2026-01-03T00:00:00.000Z",
      },
      {
        ...toHistoryEntries(makeComparison())[0]!,
        runAt: "2026-01-01T00:00:00.000Z",
      },
      {
        ...toHistoryEntries(makeComparison())[0]!,
        runAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const groups = buildTrends(entries, "all");
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0]!.points.map((p) => p.runAt),
      [
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        "2026-01-03T00:00:00.000Z",
      ],
    );
  });

  test("separates different evals and models into distinct groups", () => {
    const base = toHistoryEntries(makeComparison())[0]!;
    const entries = [
      base,
      { ...base, evalName: "other-eval" },
      { ...base, modelLabel: "claude/opus" },
    ];
    const groups = buildTrends(entries, "all");
    assert.equal(groups.length, 3);
  });

  test("all mode keeps every run and flags regime-change points", () => {
    const base = toHistoryEntries(makeComparison())[0]!;
    const entries = [
      {
        ...base,
        runAt: "2026-01-01T00:00:00.000Z",
        comparisonFingerprint: "fp-a",
      },
      {
        ...base,
        runAt: "2026-01-02T00:00:00.000Z",
        comparisonFingerprint: "fp-a",
      },
      {
        ...base,
        runAt: "2026-01-03T00:00:00.000Z",
        comparisonFingerprint: "fp-b",
      },
    ];
    const [group] = buildTrends(entries, "all");
    assert.equal(group!.points.length, 3);
    assert.deepEqual(
      group!.points.map((p) => p.regimeChange),
      [false, false, true],
    );
  });

  test("strict mode keeps only runs matching the latest fingerprint", () => {
    const base = toHistoryEntries(makeComparison())[0]!;
    const entries = [
      {
        ...base,
        runAt: "2026-01-01T00:00:00.000Z",
        comparisonFingerprint: "fp-a",
      },
      {
        ...base,
        runAt: "2026-01-02T00:00:00.000Z",
        comparisonFingerprint: "fp-a",
      },
      {
        ...base,
        runAt: "2026-01-03T00:00:00.000Z",
        comparisonFingerprint: "fp-b",
      },
    ];
    const [group] = buildTrends(entries, "strict");
    assert.equal(group!.points.length, 1);
    assert.equal(group!.points[0]!.runAt, "2026-01-03T00:00:00.000Z");
    assert.equal(group!.points[0]!.regimeChange, false);
  });

  test("returns groups sorted by evalName then modelLabel", () => {
    const base = toHistoryEntries(makeComparison())[0]!;
    const entries = [
      { ...base, evalName: "zeta-eval" },
      { ...base, evalName: "alpha-eval" },
    ];
    const groups = buildTrends(entries, "all");
    assert.deepEqual(
      groups.map((g) => g.evalName),
      ["alpha-eval", "zeta-eval"],
    );
  });
});
