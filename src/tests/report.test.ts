// ============================================================================
// RUN REPORT TESTS
// ============================================================================
// Covers src/report.ts:
//   - pure aggregation (emptyUsage/addUsage/computeOverflow/buildRunReport)
//   - the enable/disable switch (EXECUTANT_REPORT_SUGGESTION)
//   - generateEfficiencySuggestion: happy path and graceful failure — a
//     broken/slow/malformed suggestion call must never throw or block

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installSequencedMock } from "./helpers.js";
import {
  addUsage,
  buildRunReport,
  computeOverflow,
  emptyUsage,
  formatNarrative,
  generateEfficiencySuggestion,
  isEfficiencySuggestionEnabled,
  CONTEXT_OVERFLOW_THRESHOLD,
} from "../report.js";
import type { StepSummary, TokenUsage, Workflow } from "../types.js";

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { ...emptyUsage(), ...partial };
}

const NO_NARRATIVE: StepSummary[] = [];

// ----------------------------------------------------------------------------
// emptyUsage / addUsage
// ----------------------------------------------------------------------------

describe("emptyUsage / addUsage", () => {
  test("emptyUsage is all zeros", () => {
    assert.deepEqual(emptyUsage(), {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  test("addUsage sums each field independently", () => {
    const a = usage({ inputTokens: 10, outputTokens: 5 });
    const b = usage({ inputTokens: 3, cacheReadTokens: 7 });
    assert.deepEqual(addUsage(a, b), {
      inputTokens: 13,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 7,
    });
  });
});

// ----------------------------------------------------------------------------
// computeOverflow
// ----------------------------------------------------------------------------

describe("computeOverflow", () => {
  test("no overflow when every call is under the threshold", () => {
    const calls = [
      usage({ inputTokens: 1_000 }),
      usage({ inputTokens: 199_999 }),
    ];
    assert.deepEqual(computeOverflow(calls), {
      overflowTokens: 0,
      overflowCalls: 0,
    });
  });

  test("a call exactly at the threshold does not overflow", () => {
    const calls = [usage({ inputTokens: CONTEXT_OVERFLOW_THRESHOLD })];
    assert.deepEqual(computeOverflow(calls), {
      overflowTokens: 0,
      overflowCalls: 0,
    });
  });

  test("one call one token over the threshold overflows by exactly one token", () => {
    const calls = [usage({ inputTokens: CONTEXT_OVERFLOW_THRESHOLD + 1 })];
    assert.deepEqual(computeOverflow(calls), {
      overflowTokens: 1,
      overflowCalls: 1,
    });
  });

  test("cache tokens count toward a single call's context size", () => {
    const calls = [
      usage({
        inputTokens: 150_000,
        cacheReadTokens: 40_000,
        cacheCreationTokens: 20_000,
      }),
    ];
    // 150k + 40k + 20k = 210k → 10k over.
    assert.deepEqual(computeOverflow(calls), {
      overflowTokens: 10_000,
      overflowCalls: 1,
    });
  });

  test("output tokens do not count toward context size", () => {
    const calls = [usage({ inputTokens: 100_000, outputTokens: 500_000 })];
    assert.deepEqual(computeOverflow(calls), {
      overflowTokens: 0,
      overflowCalls: 0,
    });
  });

  test("many small calls that sum past 200k never overflow — it's per-call, not a running total", () => {
    const calls = Array.from({ length: 10 }, () =>
      usage({ inputTokens: 50_000 }),
    ); // sums to 500k across calls, but each is well under 200k
    assert.deepEqual(computeOverflow(calls), {
      overflowTokens: 0,
      overflowCalls: 0,
    });
  });

  test("sums excess across multiple overflowing calls", () => {
    const calls = [
      usage({ inputTokens: CONTEXT_OVERFLOW_THRESHOLD + 5_000 }),
      usage({ inputTokens: 1_000 }), // no overflow
      usage({ inputTokens: CONTEXT_OVERFLOW_THRESHOLD + 15_000 }),
    ];
    assert.deepEqual(computeOverflow(calls), {
      overflowTokens: 20_000,
      overflowCalls: 2,
    });
  });

  test("empty input yields zero overflow", () => {
    assert.deepEqual(computeOverflow([]), {
      overflowTokens: 0,
      overflowCalls: 0,
    });
  });
});

// ----------------------------------------------------------------------------
// buildRunReport
// ----------------------------------------------------------------------------

describe("buildRunReport", () => {
  test("aggregates duration, cost, and total tokens across calls", () => {
    const report = buildRunReport({
      durationMs: 12_345,
      totalCostUsd: 0.4567,
      usageEvents: [
        usage({ inputTokens: 100, outputTokens: 50 }),
        usage({ inputTokens: 200, cacheReadTokens: 10 }),
      ],
      stepNarrative: NO_NARRATIVE,
    });
    assert.equal(report.durationMs, 12_345);
    assert.equal(report.totalCostUsd, 0.4567);
    assert.deepEqual(report.totalTokens, {
      inputTokens: 300,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 10,
    });
    assert.equal(report.overflowTokens, 0);
    assert.equal(report.overflowCalls, 0);
  });

  test("omits suggestion when none was given", () => {
    const report = buildRunReport({
      durationMs: 1,
      totalCostUsd: 0,
      usageEvents: [],
      stepNarrative: NO_NARRATIVE,
    });
    assert.equal("suggestion" in report, false);
  });

  test("includes suggestion when given", () => {
    const report = buildRunReport({
      durationMs: 1,
      totalCostUsd: 0,
      usageEvents: [],
      stepNarrative: NO_NARRATIVE,
      suggestion: "add concurrency: 4",
    });
    assert.equal(report.suggestion, "add concurrency: 4");
  });

  test("handles zero calls gracefully (no usage events at all)", () => {
    const report = buildRunReport({
      durationMs: 500,
      totalCostUsd: 0,
      usageEvents: [],
      stepNarrative: NO_NARRATIVE,
    });
    assert.deepEqual(report.totalTokens, emptyUsage());
  });

  test("carries the step narrative through unchanged", () => {
    const narrative: StepSummary[] = [
      { name: "a", durationMs: 100, costUsd: 0.01, qualityEvents: [] },
    ];
    const report = buildRunReport({
      durationMs: 1,
      totalCostUsd: 0.01,
      usageEvents: [],
      stepNarrative: narrative,
    });
    assert.deepEqual(report.stepNarrative, narrative);
  });
});

// ----------------------------------------------------------------------------
// formatNarrative
// ----------------------------------------------------------------------------

describe("formatNarrative", () => {
  test("says so plainly when no steps ran", () => {
    assert.equal(formatNarrative([]), "(no steps ran)");
  });

  test("states a clean step passed on the first attempt", () => {
    const text = formatNarrative([
      { name: "lint", durationMs: 4_100, costUsd: 0, qualityEvents: [] },
    ]);
    assert.ok(text.includes('"lint"'));
    assert.ok(text.includes("4s"));
    assert.ok(text.includes("passed clean on the first attempt"));
  });

  test("includes quality events in order", () => {
    const text = formatNarrative([
      {
        name: "write-tests",
        durationMs: 1000,
        costUsd: 0.01,
        qualityEvents: [
          "judge attempt 1/5: FAIL — missing edge case",
          "judge attempt 2/5: PASS",
        ],
      },
    ]);
    const failIdx = text.indexOf("FAIL — missing edge case");
    const passIdx = text.indexOf("attempt 2/5: PASS");
    assert.ok(failIdx !== -1 && passIdx !== -1 && failIdx < passIdx);
  });

  test("flags a continue_on_error failure", () => {
    const text = formatNarrative([
      {
        name: "deploy",
        durationMs: 500,
        costUsd: 0,
        qualityEvents: ["step failed: exit code 1"],
        failed: true,
      },
    ]);
    assert.ok(text.includes("FAILED (continue_on_error)"));
  });
});

// ----------------------------------------------------------------------------
// isEfficiencySuggestionEnabled
// ----------------------------------------------------------------------------

describe("isEfficiencySuggestionEnabled", () => {
  test("defaults to off — an automated/CI run is never disturbed by an unrequested API call", () => {
    assert.equal(isEfficiencySuggestionEnabled({}), false);
  });

  test("is on only for an explicit 1", () => {
    assert.equal(
      isEfficiencySuggestionEnabled({ EXECUTANT_REPORT_SUGGESTION: "1" }),
      true,
    );
    assert.equal(
      isEfficiencySuggestionEnabled({ EXECUTANT_REPORT_SUGGESTION: "0" }),
      false,
    );
    assert.equal(
      isEfficiencySuggestionEnabled({ EXECUTANT_REPORT_SUGGESTION: "true" }),
      false,
    );
  });
});

// ----------------------------------------------------------------------------
// generateEfficiencySuggestion — happy path + graceful failure
// ----------------------------------------------------------------------------

function installMock(responseText: string): void {
  const mockDir = join(
    tmpdir(),
    `executant-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(mockDir, { recursive: true });
  const responseFile = join(mockDir, "response.ndjson");
  writeFileSync(
    responseFile,
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: responseText }] },
    }) +
      "\n" +
      JSON.stringify({ type: "result", total_cost_usd: 0.0001 }) +
      "\n",
    "utf8",
  );
  const script = join(mockDir, "claude");
  writeFileSync(
    script,
    `#!/usr/bin/env bash\ncat "${responseFile}"\nexit 0\n`,
    "utf8",
  );
  chmodSync(script, 0o755);
  process.env["PATH"] = `${mockDir}:${process.env["PATH"] ?? ""}`;
}

function installFailingMock(): void {
  const mockDir = join(
    tmpdir(),
    `executant-report-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(mockDir, { recursive: true });
  const script = join(mockDir, "claude");
  writeFileSync(script, `#!/usr/bin/env bash\nexit 1\n`, "utf8");
  chmodSync(script, 0o755);
  process.env["PATH"] = `${mockDir}:${process.env["PATH"] ?? ""}`;
}

const SAMPLE_WORKFLOW: Workflow = {
  goal: "test goal",
  source: "goal: test goal\nsteps:\n  - name: s\n    command: echo hi\n",
  tasks: [{ type: "command", name: "s", command: "echo hi" }],
};

const SAMPLE_NARRATIVE: StepSummary[] = [
  { name: "s", durationMs: 100, costUsd: 0, qualityEvents: [] },
];

describe("generateEfficiencySuggestion", () => {
  let originalPath: string;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
  });

  test("returns the trimmed suggestion on a valid response", async () => {
    installMock(JSON.stringify({ suggestion: "  add concurrency: 4  " }));
    const suggestion = await generateEfficiencySuggestion(
      SAMPLE_WORKFLOW,
      SAMPLE_NARRATIVE,
    );
    assert.equal(suggestion, "add concurrency: 4");
  });

  test("returns undefined, never throws, when the CLI exits non-zero", async () => {
    installFailingMock();
    const suggestion = await generateEfficiencySuggestion(
      SAMPLE_WORKFLOW,
      SAMPLE_NARRATIVE,
    );
    assert.equal(suggestion, undefined);
  });

  test("returns undefined, never throws, on malformed (non-JSON) output", async () => {
    installMock("this is not JSON at all");
    const suggestion = await generateEfficiencySuggestion(
      SAMPLE_WORKFLOW,
      SAMPLE_NARRATIVE,
    );
    assert.equal(suggestion, undefined);
  });

  test("returns undefined when the claude binary isn't on PATH at all", async () => {
    process.env["PATH"] = "/nonexistent-bin-dir";
    const suggestion = await generateEfficiencySuggestion(
      SAMPLE_WORKFLOW,
      SAMPLE_NARRATIVE,
    );
    assert.equal(suggestion, undefined);
  });

  test("returns undefined for an empty suggestion string", async () => {
    installMock(JSON.stringify({ suggestion: "   " }));
    const suggestion = await generateEfficiencySuggestion(
      SAMPLE_WORKFLOW,
      SAMPLE_NARRATIVE,
    );
    assert.equal(suggestion, undefined);
  });

  test("the prompt sent to the model includes the formatted narrative", async () => {
    const { promptsDir } = installSequencedMock([
      JSON.stringify({ suggestion: "fine as-is" }),
    ]);
    await generateEfficiencySuggestion(SAMPLE_WORKFLOW, [
      {
        name: "write-tests",
        durationMs: 1000,
        costUsd: 0,
        qualityEvents: ["judge attempt 1/5: FAIL — missing edge case"],
      },
    ]);
    const prompt = readFileSync(join(promptsDir, "0.txt"), "utf8");
    assert.ok(prompt.includes("write-tests"));
    assert.ok(prompt.includes("missing edge case"));
  });
});
