// ============================================================================
// EVAL COMPARISON — unit tests
// ============================================================================
// Tests for the multi-model eval comparison system:
//   - parseModelTarget: parsing "provider/model" strings
//   - parseArgs: new --models, --output-json, --output-csv flags
//   - toJson / toCsv: serializers
//   - printComparison: smoke test (output contains expected labels)

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseModelTarget,
  parseArgs,
  loadExistingResults,
} from "../eval/index.js";
import { toJson, toCsv, modelLabel } from "../eval/export.js";
import type {
  EvalComparison,
  ModelEvalRun,
  ModelTarget,
} from "../eval/types.js";

// ----------------------------------------------------------------------------
// parseModelTarget
// ----------------------------------------------------------------------------

describe("parseModelTarget", () => {
  test("parses claude/sonnet correctly", () => {
    const t = parseModelTarget("claude/sonnet");
    assert.equal(t.provider, "claude");
    assert.equal(t.model, "sonnet");
  });

  test("parses opencode with nested slash in model name (llama.cpp)", () => {
    const t = parseModelTarget("opencode/llama-qwen7b/qwen2.5-coder-7b");
    assert.equal(t.provider, "opencode");
    assert.equal(t.model, "llama-qwen7b/qwen2.5-coder-7b");
  });

  test("parses opencode with deeper nested model name", () => {
    const t = parseModelTarget("opencode/llama-qwen14b/qwen2.5-coder-14b");
    assert.equal(t.provider, "opencode");
    assert.equal(t.model, "llama-qwen14b/qwen2.5-coder-14b");
  });

  test("throws when no slash present", () => {
    assert.throws(
      () => parseModelTarget("claudesonnet"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("provider/model"));
        return true;
      },
    );
  });

  test("throws for unknown provider", () => {
    assert.throws(
      () => parseModelTarget("gemini/gemini-pro"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("gemini"));
        return true;
      },
    );
  });
});

// ----------------------------------------------------------------------------
// parseArgs — new flags
// ----------------------------------------------------------------------------

describe("parseArgs — models / output flags", () => {
  test("models defaults to empty array", () => {
    const args = parseArgs(["evals/test.yaml"]);
    assert.deepEqual(args.models, []);
  });

  test("--models parses single model", () => {
    const args = parseArgs(["--models", "claude/sonnet", "evals/test.yaml"]);
    assert.equal(args.models.length, 1);
    assert.equal(args.models[0]!.provider, "claude");
    assert.equal(args.models[0]!.model, "sonnet");
  });

  test("--models parses comma-separated list", () => {
    const args = parseArgs([
      "--models",
      "claude/sonnet,opencode/llama-qwen7b/qwen2.5-coder-7b",
      "evals/test.yaml",
    ]);
    assert.equal(args.models.length, 2);
    assert.equal(args.models[0]!.provider, "claude");
    assert.equal(args.models[1]!.provider, "opencode");
    assert.equal(args.models[1]!.model, "llama-qwen7b/qwen2.5-coder-7b");
  });

  test("--output-json is parsed", () => {
    const args = parseArgs([
      "--output-json",
      "results/comp.json",
      "evals/test.yaml",
    ]);
    assert.equal(args.outputJson, "results/comp.json");
  });

  test("--output-csv is parsed", () => {
    const args = parseArgs([
      "--output-csv",
      "results/comp.csv",
      "evals/test.yaml",
    ]);
    assert.equal(args.outputCsv, "results/comp.csv");
  });

  test("outputJson and outputCsv are undefined by default", () => {
    const args = parseArgs(["evals/test.yaml"]);
    assert.equal(args.outputJson, undefined);
    assert.equal(args.outputCsv, undefined);
  });

  test("all new flags coexist with existing flags", () => {
    const args = parseArgs([
      "--refine",
      "--max-iter",
      "3",
      "--models",
      "claude/sonnet",
      "--output-json",
      "out.json",
      "--output-csv",
      "out.csv",
      "evals/test.yaml",
    ]);
    assert.equal(args.refine, true);
    assert.equal(args.maxIter, 3);
    assert.equal(args.models.length, 1);
    assert.equal(args.outputJson, "out.json");
    assert.equal(args.outputCsv, "out.csv");
    assert.equal(args.evalFile, "evals/test.yaml");
  });
});

// ----------------------------------------------------------------------------
// modelLabel
// ----------------------------------------------------------------------------

describe("modelLabel", () => {
  test("returns label when set", () => {
    const m: ModelTarget = {
      provider: "claude",
      model: "sonnet",
      label: "Claude 3.5",
    };
    assert.equal(modelLabel(m), "Claude 3.5");
  });

  test("returns provider/model when no label", () => {
    const m: ModelTarget = { provider: "claude", model: "sonnet" };
    assert.equal(modelLabel(m), "claude/sonnet");
  });

  test("handles nested model name", () => {
    const m: ModelTarget = {
      provider: "opencode",
      model: "llama-qwen7b/qwen2.5-coder-7b",
    };
    assert.equal(modelLabel(m), "opencode/llama-qwen7b/qwen2.5-coder-7b");
  });
});

// ----------------------------------------------------------------------------
// Fixture helpers
// ----------------------------------------------------------------------------

function makeComparison(): EvalComparison {
  const claudeModel: ModelTarget = { provider: "claude", model: "sonnet" };
  const ocModel: ModelTarget = {
    provider: "opencode",
    model: "llama-qwen7b/qwen2.5-coder-7b",
  };

  const claudeRun: ModelEvalRun = {
    evalName: "test-eval",
    templatePath: "evals/test.eval.yaml",
    model: claudeModel,
    results: [
      {
        caseId: "case-a",
        output: "output a",
        criteria: [
          { criterion: "Is valid JSON", pass: true, reason: "it is" },
          {
            criterion: "Contains goal",
            pass: false,
            reason: "missing goal field",
          },
        ],
        passCount: 1,
        failCount: 1,
        durationMs: 1200,
      },
      {
        caseId: "case-b",
        output: "output b",
        criteria: [
          { criterion: "Non-empty", pass: true, reason: "has content" },
        ],
        passCount: 1,
        failCount: 0,
        durationMs: 800,
      },
    ],
    totalPass: 2,
    totalCriteria: 3,
  };

  const ocRun: ModelEvalRun = {
    evalName: "test-eval",
    templatePath: "evals/test.eval.yaml",
    model: ocModel,
    results: [
      {
        caseId: "case-a",
        output: "output a oc",
        criteria: [
          { criterion: "Is valid JSON", pass: true, reason: "it is" },
          { criterion: "Contains goal", pass: true, reason: "goal found" },
        ],
        passCount: 2,
        failCount: 0,
        durationMs: 4500,
      },
      {
        caseId: "case-b",
        output: "output b oc",
        criteria: [
          { criterion: "Non-empty", pass: true, reason: "has content" },
        ],
        passCount: 1,
        failCount: 0,
        durationMs: 3200,
      },
    ],
    totalPass: 3,
    totalCriteria: 3,
  };

  return {
    evalName: "test-eval",
    templatePath: "evals/test.eval.yaml",
    models: [claudeModel, ocModel],
    runs: [claudeRun, ocRun],
    comparisonTable: [
      {
        caseId: "case-a",
        scores: {
          "claude/sonnet": { pass: 1, total: 2, pct: 0.5 },
          "opencode/llama-qwen7b/qwen2.5-coder-7b": {
            pass: 2,
            total: 2,
            pct: 1,
          },
        },
      },
      {
        caseId: "case-b",
        scores: {
          "claude/sonnet": { pass: 1, total: 1, pct: 1 },
          "opencode/llama-qwen7b/qwen2.5-coder-7b": {
            pass: 1,
            total: 1,
            pct: 1,
          },
        },
      },
    ],
  };
}

// ----------------------------------------------------------------------------
// toJson
// ----------------------------------------------------------------------------

describe("toJson", () => {
  test("returns valid JSON string", () => {
    const c = makeComparison();
    const json = toJson(c);
    assert.doesNotThrow(() => JSON.parse(json));
  });

  test("JSON contains evalName", () => {
    const c = makeComparison();
    const parsed = JSON.parse(toJson(c)) as Record<string, unknown>;
    assert.equal(parsed["evalName"], "test-eval");
  });

  test("JSON contains both model runs", () => {
    const c = makeComparison();
    const parsed = JSON.parse(toJson(c)) as Record<string, unknown>;
    assert.ok(Array.isArray(parsed["runs"]));
    assert.equal((parsed["runs"] as unknown[]).length, 2);
  });

  test("JSON contains comparisonTable", () => {
    const c = makeComparison();
    const parsed = JSON.parse(toJson(c)) as Record<string, unknown>;
    assert.ok(Array.isArray(parsed["comparisonTable"]));
  });
});

// ----------------------------------------------------------------------------
// toCsv
// ----------------------------------------------------------------------------

describe("toCsv", () => {
  test("first line is the header", () => {
    const c = makeComparison();
    const csv = toCsv(c);
    const lines = csv.trim().split("\n");
    assert.equal(
      lines[0],
      "eval_name,template_path,case_id,criterion,model_label,provider,model,pass,reason,duration_ms",
    );
  });

  test("has correct number of data rows (2 cases × 3 criteria × 2 models = 6 rows)", () => {
    const c = makeComparison();
    const csv = toCsv(c);
    const lines = csv.trim().split("\n");
    // 1 header + 6 data rows
    assert.equal(lines.length, 7);
  });

  test("data rows contain expected model label", () => {
    const c = makeComparison();
    const csv = toCsv(c);
    assert.ok(csv.includes("claude/sonnet"));
    assert.ok(csv.includes("opencode/llama-qwen7b/qwen2.5-coder-7b"));
  });

  test("pass column contains true/false values", () => {
    const c = makeComparison();
    const csv = toCsv(c);
    assert.ok(csv.includes(",true,") || csv.includes(",true\n"));
    assert.ok(csv.includes(",false,") || csv.includes(",false\n"));
  });

  test("cells with commas or quotes are escaped", () => {
    const c = makeComparison();
    // Inject a reason with a comma and a quote
    c.runs[0]!.results[0]!.criteria[1]!.reason = 'failed, "badly"';
    const csv = toCsv(c);
    assert.ok(csv.includes('"failed, ""badly"""'));
  });
});

// ----------------------------------------------------------------------------
// loadExistingResults
// ----------------------------------------------------------------------------

describe("loadExistingResults", () => {
  test("returns empty map when file does not exist", () => {
    const result = loadExistingResults("/nonexistent/path.csv");
    assert.equal(result.size, 0);
  });

  test("round-trips toCsv output back into TestResult objects", async () => {
    const c = makeComparison();
    const csv = toCsv(c);

    // Write to a temp file
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpPath = `/tmp/eval-resume-test-${Date.now()}.csv`;
    writeFileSync(tmpPath, csv, "utf8");

    try {
      const byModel = loadExistingResults(tmpPath);

      // Should have 2 models
      assert.equal(byModel.size, 2);

      // Check claude/sonnet case-a
      const claudeResults = byModel.get("claude/sonnet");
      assert.ok(claudeResults, "claude/sonnet should be present");
      const caseA = claudeResults.get("case-a");
      assert.ok(caseA, "case-a should be present");
      assert.equal(caseA.caseId, "case-a");
      assert.equal(caseA.criteria.length, 2);
      assert.equal(caseA.passCount, 1);
      assert.equal(caseA.failCount, 1);
      assert.equal(caseA.durationMs, 1200);

      // Check opencode model case-b
      const ocResults = byModel.get("opencode/llama-qwen7b/qwen2.5-coder-7b");
      assert.ok(ocResults, "opencode model should be present");
      const caseB = ocResults.get("case-b");
      assert.ok(caseB);
      assert.equal(caseB.passCount, 1);
      assert.equal(caseB.durationMs, 3200);
    } finally {
      unlinkSync(tmpPath);
    }
  });

  test("correctly parses pass=true and pass=false", async () => {
    const csv =
      [
        "eval_name,template_path,case_id,criterion,model_label,provider,model,pass,reason,duration_ms",
        '"e","t","case-1","criterion A","m/x","m","x",true,"ok",500',
        '"e","t","case-1","criterion B","m/x","m","x",false,"nope",500',
      ].join("\n") + "\n";

    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpPath = `/tmp/eval-resume-test2-${Date.now()}.csv`;
    writeFileSync(tmpPath, csv, "utf8");

    try {
      const byModel = loadExistingResults(tmpPath);
      const result = byModel.get("m/x")?.get("case-1");
      assert.ok(result);
      assert.equal(result.passCount, 1);
      assert.equal(result.failCount, 1);
      assert.equal(result.criteria[0]!.pass, true);
      assert.equal(result.criteria[1]!.pass, false);
    } finally {
      unlinkSync(tmpPath);
    }
  });
});
