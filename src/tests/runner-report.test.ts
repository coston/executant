// ============================================================================
// RUNNER — workflow:report integration
// ============================================================================
// Covers the report the runner emits after a successful run:
//   - fires once, immediately before workflow:complete
//   - aggregates cost/tokens across every step's output:cost/output:usage
//   - computes the >200k-token overflow tier
//   - is skipped on cancellation and on a fatal step failure
//   - a nested `workflow:` step never emits its own report (report: false)
//   - the efficiency suggestion is included when enabled, and the whole
//     report still ships (gracefully) when the suggestion call fails

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ClaudeTask,
  CommandTask,
  Event,
  WorkflowReportEvent,
  Workflow,
} from "../types.js";
import { runWorkflow } from "../runner.js";
import { installSequencedMock, tmpDir } from "./helpers.js";
import { loadWorkflow } from "../load-workflow.js";
import { resolveWorkflow } from "../resolve-workflow.js";

function reportEvents(events: Event[]): WorkflowReportEvent[] {
  return events.filter(
    (e): e is WorkflowReportEvent => e.type === "workflow:report",
  );
}

/** Mock claude that answers every invocation with the given usage/cost. */
function installUsageMock(opts: {
  costUsd: number;
  inputTokens: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}): void {
  const mockDir = join(
    tmpdir(),
    `executant-report-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(mockDir, { recursive: true });
  const script = join(mockDir, "claude");
  const resultLine = JSON.stringify({
    type: "result",
    total_cost_usd: opts.costUsd,
    usage: {
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: opts.cacheReadTokens ?? 0,
    },
  });
  writeFileSync(
    script,
    `#!/usr/bin/env bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'
echo '${resultLine}'
exit 0
`,
    "utf8",
  );
  chmodSync(script, 0o755);
  process.env["PATH"] = `${mockDir}:${process.env["PATH"] ?? ""}`;
}

function claudeStep(name: string): ClaudeTask {
  return { type: "claude", name, prompt: `do ${name}` };
}

describe("runWorkflow — workflow:report", () => {
  let originalPath: string;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
  });

  test("fires once, immediately before workflow:complete", async () => {
    installUsageMock({ costUsd: 0.01, inputTokens: 100 });
    const wf: Workflow = { goal: "g", tasks: [claudeStep("a")] };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);

    const reports = reportEvents(events);
    assert.equal(reports.length, 1);
    const types = events.map((e) => e.type);
    assert.equal(
      types.indexOf("workflow:report") + 1,
      types.indexOf("workflow:complete"),
    );
  });

  test("aggregates cost and tokens across multiple steps", async () => {
    installUsageMock({ costUsd: 0.01, inputTokens: 100, outputTokens: 20 });
    const wf: Workflow = {
      goal: "g",
      tasks: [claudeStep("a"), claudeStep("b")],
    };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);

    const report = reportEvents(events)[0]!.report;
    assert.ok(Math.abs(report.totalCostUsd - 0.02) < 1e-9);
    assert.equal(report.totalTokens.inputTokens, 200);
    assert.equal(report.totalTokens.outputTokens, 40);
  });

  test("a script-only run reports zero cost and zero tokens", async () => {
    const wf: Workflow = {
      goal: "g",
      tasks: [{ type: "command", name: "s", command: "echo hi" }],
    };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);

    const report = reportEvents(events)[0]!.report;
    assert.equal(report.totalCostUsd, 0);
    assert.deepEqual(report.totalTokens, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    assert.equal(report.overflowCalls, 0);
  });

  test("computes overflow when a single call's context exceeds 200k", async () => {
    installUsageMock({
      costUsd: 1,
      inputTokens: 190_000,
      cacheReadTokens: 20_000,
    }); // 210k context → 10k over
    const wf: Workflow = { goal: "g", tasks: [claudeStep("a")] };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);

    const report = reportEvents(events)[0]!.report;
    assert.equal(report.overflowCalls, 1);
    assert.equal(report.overflowTokens, 10_000);
  });

  test("does not fire on a cancelled run", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".executant-cancel"), "", "utf8");
    const wf: Workflow = {
      goal: "g",
      tasks: [
        { type: "command", name: "s", command: "echo hi" } as CommandTask,
      ],
    };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf, { workDir: dir })) events.push(e);
    assert.equal(reportEvents(events).length, 0);
    assert.ok(events.some((e) => e.type === "workflow:cancelled"));
  });

  test("does not fire when a fatal step failure ends the run", async () => {
    const wf: Workflow = {
      goal: "g",
      tasks: [{ type: "command", name: "boom", command: "exit 7" }],
    };
    const events: Event[] = [];
    try {
      for await (const e of runWorkflow(wf)) events.push(e);
    } catch {
      /* expected */
    }
    assert.equal(reportEvents(events).length, 0);
  });

  test("RunOptions.report: false disables the report entirely", async () => {
    installUsageMock({ costUsd: 0.01, inputTokens: 100 });
    const wf: Workflow = { goal: "g", tasks: [claudeStep("a")] };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf, { report: false })) events.push(e);
    assert.equal(reportEvents(events).length, 0);
  });

  test("a nested `workflow:` step never emits its own report — only the outer run does", async () => {
    const dir = tmpDir();
    const childPath = join(dir, "child.yaml");
    writeFileSync(
      childPath,
      "goal: child\nsteps:\n  - name: build\n    command: echo build\n",
      "utf8",
    );
    const parentPath = join(dir, "parent.yaml");
    writeFileSync(
      parentPath,
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
      "utf8",
    );
    const wf = await resolveWorkflow(loadWorkflow(parentPath));

    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);
    assert.equal(reportEvents(events).length, 1);
  });

  test("includes the efficiency suggestion when enabled and the CLI returns one", async () => {
    const original = process.env["EXECUTANT_REPORT_SUGGESTION"];
    process.env["EXECUTANT_REPORT_SUGGESTION"] = "1";
    try {
      // First response is the step's own output; the second is the trailing
      // suggestion call's structured JSON.
      installSequencedMock([
        "step output",
        JSON.stringify({ suggestion: "add concurrency: 4 to deploy" }),
      ]);
      const wf: Workflow = { goal: "g", tasks: [claudeStep("a")] };
      const events: Event[] = [];
      for await (const e of runWorkflow(wf)) events.push(e);
      assert.equal(
        reportEvents(events)[0]!.report.suggestion,
        "add concurrency: 4 to deploy",
      );
    } finally {
      if (original === undefined)
        delete process.env["EXECUTANT_REPORT_SUGGESTION"];
      else process.env["EXECUTANT_REPORT_SUGGESTION"] = original;
    }
  });

  test("ships the report without a suggestion when the suggestion call fails", async () => {
    const original = process.env["EXECUTANT_REPORT_SUGGESTION"];
    process.env["EXECUTANT_REPORT_SUGGESTION"] = "1";
    try {
      // Only one canned response exists; the trailing suggestion call reads
      // past the end and gets nothing usable back — must not throw.
      installSequencedMock(["step output"]);
      const wf: Workflow = { goal: "g", tasks: [claudeStep("a")] };
      const events: Event[] = [];
      for await (const e of runWorkflow(wf)) events.push(e);
      const reports = reportEvents(events);
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.report.suggestion, undefined);
    } finally {
      if (original === undefined)
        delete process.env["EXECUTANT_REPORT_SUGGESTION"];
      else process.env["EXECUTANT_REPORT_SUGGESTION"] = original;
    }
  });

  test("suggestion is omitted (not even attempted) by default — opt-in only", async () => {
    // Off by default so an automated/CI run is never disturbed by an extra
    // API call it didn't ask for (EXECUTANT_REPORT_SUGGESTION=1 opts in).
    installUsageMock({ costUsd: 0.01, inputTokens: 100 });
    const wf: Workflow = { goal: "g", tasks: [claudeStep("a")] };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);
    assert.equal(reportEvents(events)[0]!.report.suggestion, undefined);
  });

  test("stepNarrative carries judge history for a step that retried before passing", async () => {
    const judgeFail = JSON.stringify({
      pass: false,
      feedback: "missing edge case",
    });
    const judgePass = JSON.stringify({ pass: true, feedback: "" });
    // step attempt 1, judge (fail), step attempt 2, judge (pass).
    installSequencedMock(["work v1", judgeFail, "work v2", judgePass]);
    const wf: Workflow = {
      goal: "g",
      tasks: [
        {
          type: "claude",
          name: "write-tests",
          prompt: "add tests",
          llmAsJudge: true,
        },
      ],
    };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);

    const narrative = reportEvents(events)[0]!.report.stepNarrative;
    assert.equal(narrative.length, 1);
    assert.equal(narrative[0]!.name, "write-tests");
    assert.ok(narrative[0]!.qualityEvents.some((e) => e.includes("FAIL")));
    assert.ok(narrative[0]!.qualityEvents.some((e) => e.includes("PASS")));
    assert.ok(!narrative[0]!.failed);
  });

  test("stepNarrative records a continue_on_error failure with failed: true", async () => {
    const wf: Workflow = {
      goal: "g",
      tasks: [
        {
          type: "command",
          name: "flaky",
          command: "exit 1",
          continueOnError: true,
        },
      ],
    };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);

    const narrative = reportEvents(events)[0]!.report.stepNarrative;
    assert.equal(narrative.length, 1);
    assert.equal(narrative[0]!.name, "flaky");
    assert.equal(narrative[0]!.failed, true);
    assert.ok(
      narrative[0]!.qualityEvents.some((e) => e.includes("step failed")),
    );
  });

  test("a clean step's narrative entry has no quality events", async () => {
    installUsageMock({ costUsd: 0.01, inputTokens: 100 });
    const wf: Workflow = { goal: "g", tasks: [claudeStep("a")] };
    const events: Event[] = [];
    for await (const e of runWorkflow(wf)) events.push(e);

    const narrative = reportEvents(events)[0]!.report.stepNarrative;
    assert.equal(narrative.length, 1);
    assert.deepEqual(narrative[0]!.qualityEvents, []);
    assert.equal(narrative[0]!.costUsd, 0.01);
  });
});
