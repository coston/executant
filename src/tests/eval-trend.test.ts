// ============================================================================
// EVAL:TREND — unit tests
// ============================================================================
// Tests for src/eval/trend-index.ts CLI arg parsing and the printTrends
// terminal renderer (report.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseTrendArgs } from "../eval/trend-index.js";
import { printTrends } from "../eval/report.js";
import { buildTrends, toHistoryEntries } from "../eval/history.js";
import type { EvalComparison } from "../eval/types.js";

describe("parseTrendArgs", () => {
  test("defaults to results/eval-history.jsonl and all mode", () => {
    const args = parseTrendArgs([]);
    assert.equal(args.historyPath, "results/eval-history.jsonl");
    assert.equal(args.mode, "all");
    assert.equal(args.evalFilter, undefined);
  });

  test("--history overrides the default path", () => {
    const args = parseTrendArgs(["--history", "custom/path.jsonl"]);
    assert.equal(args.historyPath, "custom/path.jsonl");
  });

  test("--mode strict is parsed", () => {
    const args = parseTrendArgs(["--mode", "strict"]);
    assert.equal(args.mode, "strict");
  });

  test("--eval filters to a single eval name", () => {
    const args = parseTrendArgs(["--eval", "judge-evaluation"]);
    assert.equal(args.evalFilter, "judge-evaluation");
  });

  test("throws on an invalid --mode value", () => {
    assert.throws(() => parseTrendArgs(["--mode", "bogus"]), /Invalid --mode/);
  });

  test("--html captures the output path", () => {
    const args = parseTrendArgs(["--html", "results/bench.html"]);
    assert.equal(args.htmlPath, "results/bench.html");
    assert.equal(parseTrendArgs([]).htmlPath, undefined);
  });

  test("throws when a flag is missing its value instead of silently ignoring it", () => {
    // `--mode` silently falling back to "all" would hand the user
    // non-comparable data while they believe it's strict.
    assert.throws(() => parseTrendArgs(["--mode"]), /Missing value for --mode/);
    assert.throws(
      () => parseTrendArgs(["--history", "--mode", "strict"]),
      /Missing value for --history/,
    );
    assert.throws(() => parseTrendArgs(["--eval"]), /Missing value for --eval/);
  });
});

describe("printTrends", () => {
  test("does not throw for an empty group list", () => {
    assert.doesNotThrow(() => printTrends([]));
  });

  test("does not throw when rendering groups with a regime change", () => {
    const model = { provider: "claude" as const, model: "sonnet" };
    const comparison: EvalComparison = {
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
      provenance: {
        runAt: "2026-01-01T00:00:00.000Z",
        repo: "coston/executant",
        gitSha: "a".repeat(40),
        judgeProvider: "claude",
        judgeModel: "sonnet",
        judgePromptHash: "ph1",
        evalHash: "eh1",
        comparisonFingerprint: "fp1",
      },
    };
    const entries = [
      ...toHistoryEntries(comparison),
      ...toHistoryEntries({
        ...comparison,
        provenance: {
          ...comparison.provenance,
          runAt: "2026-01-02T00:00:00.000Z",
          comparisonFingerprint: "fp2",
        },
      }),
    ];
    const groups = buildTrends(entries, "all");
    assert.doesNotThrow(() => printTrends(groups));
    assert.equal(groups[0]!.points[1]!.regimeChange, true);
  });
});
