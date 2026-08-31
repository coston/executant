// ============================================================================
// EVAL PROVENANCE — unit tests
// ============================================================================
// Tests for src/eval/provenance.ts: git SHA/repo capture, judge version
// lookup, hashing, and the composed comparisonFingerprint.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getGitSha,
  getRepoSlug,
  hashContent,
  getEvalHash,
  computeComparisonFingerprint,
  buildProvenance,
} from "../eval/provenance.js";
import type { EvalFile } from "../eval/types.js";

function makeEvalFile(overrides: Partial<EvalFile> = {}): EvalFile {
  return {
    name: "sample-eval",
    prompt: "/fake/prompt.txt",
    placeholders: ["A"],
    testCases: [
      { id: "case-1", vars: { A: "hello" }, criteria: ["Is non-empty"] },
    ],
    ...overrides,
  };
}

describe("hashContent", () => {
  test("is deterministic for the same input", () => {
    assert.equal(hashContent("hello world"), hashContent("hello world"));
  });

  test("differs for different input", () => {
    assert.notEqual(hashContent("a"), hashContent("b"));
  });

  test("returns a 12-character hex string", () => {
    const h = hashContent("anything");
    assert.equal(h.length, 12);
    assert.ok(/^[0-9a-f]{12}$/.test(h));
  });
});

describe("getEvalHash", () => {
  test("is deterministic for the same eval file", () => {
    const f = makeEvalFile();
    assert.equal(getEvalHash(f), getEvalHash(f));
  });

  test("is insensitive to test case ordering", () => {
    const a = makeEvalFile({
      testCases: [
        { id: "case-1", vars: {}, criteria: ["C1"] },
        { id: "case-2", vars: {}, criteria: ["C2"] },
      ],
    });
    const b = makeEvalFile({
      testCases: [
        { id: "case-2", vars: {}, criteria: ["C2"] },
        { id: "case-1", vars: {}, criteria: ["C1"] },
      ],
    });
    assert.equal(getEvalHash(a), getEvalHash(b));
  });

  test("changes when a criterion changes", () => {
    const a = makeEvalFile();
    const b = makeEvalFile({
      testCases: [
        {
          id: "case-1",
          vars: { A: "hello" },
          criteria: ["Different criterion"],
        },
      ],
    });
    assert.notEqual(getEvalHash(a), getEvalHash(b));
  });

  test("changes when a fixture var value changes", () => {
    const a = makeEvalFile();
    const b = makeEvalFile({
      testCases: [
        { id: "case-1", vars: { A: "goodbye" }, criteria: ["Is non-empty"] },
      ],
    });
    assert.notEqual(getEvalHash(a), getEvalHash(b));
  });
});

describe("computeComparisonFingerprint", () => {
  test("is deterministic", () => {
    const fp1 = computeComparisonFingerprint("claude", "sonnet", "ph1", "eh1");
    const fp2 = computeComparisonFingerprint("claude", "sonnet", "ph1", "eh1");
    assert.equal(fp1, fp2);
  });

  test("changes when the judge model changes", () => {
    const fp1 = computeComparisonFingerprint("claude", "sonnet", "ph1", "eh1");
    const fp2 = computeComparisonFingerprint("claude", "opus", "ph1", "eh1");
    assert.notEqual(fp1, fp2);
  });

  test("changes when the judge prompt hash changes", () => {
    const fp1 = computeComparisonFingerprint("claude", "sonnet", "ph1", "eh1");
    const fp2 = computeComparisonFingerprint("claude", "sonnet", "ph2", "eh1");
    assert.notEqual(fp1, fp2);
  });

  test("changes when the eval hash changes", () => {
    const fp1 = computeComparisonFingerprint("claude", "sonnet", "ph1", "eh1");
    const fp2 = computeComparisonFingerprint("claude", "sonnet", "ph1", "eh2");
    assert.notEqual(fp1, fp2);
  });
});

describe("getGitSha / getRepoSlug", () => {
  test("getGitSha returns a 40-char hex SHA when run inside a git repo", () => {
    const sha = getGitSha();
    assert.ok(sha === undefined || /^[0-9a-f]{40}$/.test(sha));
  });

  test("getRepoSlug returns an owner/repo string or undefined", () => {
    const slug = getRepoSlug();
    assert.ok(slug === undefined || /^[^/]+\/[^/]+$/.test(slug));
  });
});

describe("buildProvenance", () => {
  test("returns a fully-formed RunProvenance record", () => {
    const p = buildProvenance(makeEvalFile());
    assert.equal(p.judgeProvider, "claude");
    assert.ok(typeof p.judgeModel === "string" && p.judgeModel.length > 0);
    assert.ok(!Number.isNaN(Date.parse(p.runAt)));
    assert.ok(/^[0-9a-f]{12}$/.test(p.judgePromptHash));
    assert.ok(/^[0-9a-f]{12}$/.test(p.evalHash));
    assert.ok(/^[0-9a-f]{12}$/.test(p.comparisonFingerprint));
  });

  test("comparisonFingerprint matches recomputing from the record's own fields", () => {
    const p = buildProvenance(makeEvalFile());
    const recomputed = computeComparisonFingerprint(
      p.judgeProvider,
      p.judgeModel,
      p.judgePromptHash,
      p.evalHash,
    );
    assert.equal(p.comparisonFingerprint, recomputed);
  });

  test("evalHash differs between two eval files with different criteria", () => {
    const p1 = buildProvenance(makeEvalFile());
    const p2 = buildProvenance(
      makeEvalFile({
        testCases: [
          { id: "case-1", vars: { A: "hello" }, criteria: ["A different one"] },
        ],
      }),
    );
    assert.notEqual(p1.evalHash, p2.evalHash);
    assert.notEqual(p1.comparisonFingerprint, p2.comparisonFingerprint);
  });
});
