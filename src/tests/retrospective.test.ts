// ============================================================================
// FAILURE RETROSPECTIVE TESTS
// ============================================================================
// Covers the post-mortem produced when a step fails fatally:
//   - the enable/disable switch (EXECUTANT_RETROSPECTIVE)
//   - prompt construction (step, error, output, workflow all present)
//   - normalization of the model's response (defaults, fixable demotion)
//   - runner integration: emitted on fatal failure, skipped otherwise, and
//     never able to mask the original error
//   - reducer + pane action wiring the TUI depends on
//
// The whole suite runs with EXECUTANT_RETROSPECTIVE=0 (see package.json) so
// unrelated failure tests never spend an API call; the integration tests here
// turn it back on explicitly against a mock claude binary.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRetrospectivePrompt,
  describeWorkflow,
  isRetrospectiveEnabled,
  normalizeRetrospective,
} from "../retrospective.js";
import { describeQualityEvent } from "../runner.js";
import { loadWorkflow } from "../load-workflow.js";
import { reducer, buildInitialState } from "../ui/reducer.js";
import { availableActions, fitLists } from "../ui/RetrospectivePane.js";
import {
  collectEventsUntilError,
  installSequencedMock,
  tmpYaml,
} from "./helpers.js";
import type {
  CommandTask,
  Event,
  Retrospective,
  StepRetrospectiveEvent,
  Workflow,
} from "../types.js";

const SAMPLE: Retrospective = {
  step: "run-tests",
  summary: "The test suite failed because the fixture path was empty.",
  rootCause: "spec_file resolved to an empty string.",
  evidence: ["ENOENT: no such file or directory, open ''"],
  suggestions: [
    {
      step: "run-tests",
      issue: "spec_file has no default",
      change: "Add spec_file to vars",
      severity: "high",
    },
  ],
  workflowFixable: true,
  refineInstruction: "Add a spec_file var and reference it from run-tests.",
};

/** Mock claude that answers every invocation with the same text payload. */
function installMock(responseText: string): void {
  const mockDir = join(
    tmpdir(),
    `executant-retro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      JSON.stringify({ type: "result", total_cost_usd: 0.001 }) +
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

const VALID_RESPONSE = JSON.stringify({
  summary: "npm test failed",
  rootCause: "A renamed schema field broke an assertion.",
  evidence: ["expected 'userId' to be defined"],
  suggestions: [
    { step: "test", issue: "no retry", change: "set self_healing: true" },
  ],
  workflowFixable: true,
  refineInstruction: "Set self_healing: true on the test step.",
});

function failingWorkflow(): Workflow {
  return {
    goal: "test goal",
    source: "goal: test goal\nsteps:\n  - name: boom\n    command: exit 7\n",
    tasks: [
      {
        type: "command",
        name: "boom",
        command: "exit 7",
      } satisfies CommandTask,
    ],
  };
}

function retroEvents(events: Event[]): StepRetrospectiveEvent[] {
  return events.filter(
    (e): e is StepRetrospectiveEvent => e.type === "step:retrospective",
  );
}

// ----------------------------------------------------------------------------
// Enable switch
// ----------------------------------------------------------------------------

describe("isRetrospectiveEnabled", () => {
  test("defaults to on", () => {
    assert.equal(isRetrospectiveEnabled({}), true);
  });

  test("is off only for an explicit 0", () => {
    assert.equal(
      isRetrospectiveEnabled({ EXECUTANT_RETROSPECTIVE: "0" }),
      false,
    );
    assert.equal(
      isRetrospectiveEnabled({ EXECUTANT_RETROSPECTIVE: "1" }),
      true,
    );
  });
});

// ----------------------------------------------------------------------------
// Prompt construction
// ----------------------------------------------------------------------------

describe("buildRetrospectivePrompt", () => {
  const wf = failingWorkflow();
  const prompt = buildRetrospectivePrompt({
    workflow: wf,
    task: wf.tasks[0],
    error: new Error("Command failed with exit code 7"),
    lastOutput: "npm ERR! missing script: build",
  });

  test("includes the failing step, its definition, and the error", () => {
    assert.ok(prompt.includes("boom"));
    assert.ok(prompt.includes("exit 7"));
    assert.ok(prompt.includes("Command failed with exit code 7"));
  });

  test("includes the step output", () => {
    assert.ok(prompt.includes("npm ERR! missing script: build"));
  });

  test("includes the workflow definition so the file can be evaluated", () => {
    assert.ok(prompt.includes("goal: test goal"));
  });

  test("leaves no unfilled placeholders", () => {
    assert.equal(/\{\{[A-Z_]+\}\}/.test(prompt), false);
  });

  test("says so plainly when no output was captured", () => {
    const p = buildRetrospectivePrompt({
      workflow: wf,
      task: wf.tasks[0],
      error: new Error("x"),
    });
    assert.ok(p.includes("(no output captured)"));
  });

  test("truncates very long output, keeping the tail where the cause is", () => {
    const tail = "FINAL_ERROR_LINE";
    const long = "x".repeat(20_000) + tail;
    const p = buildRetrospectivePrompt({
      workflow: wf,
      task: wf.tasks[0],
      error: new Error("x"),
      lastOutput: long,
    });
    assert.ok(p.includes(tail));
    assert.ok(p.includes("(truncated)"));
    assert.ok(p.length < long.length);
  });

  test("carries the judge feedback that the error message throws away", () => {
    const p = buildRetrospectivePrompt({
      workflow: wf,
      task: wf.tasks[0],
      error: new Error('Step "boom" failed judge evaluation after 5 attempts'),
      qualityHistory: [
        "judge attempt 1/5: FAIL — no tests were added",
        "judge attempt 2/5: FAIL — coverage is still below 80%",
      ],
    });
    assert.ok(p.includes("no tests were added"));
    assert.ok(p.includes("coverage is still below 80%"));
  });

  test("says there was no quality-control loop when there wasn't one", () => {
    assert.ok(prompt.includes("(none — this step ran no judge"));
  });

  test("names the forEach position so the failing item is identified", () => {
    const p = buildRetrospectivePrompt({
      workflow: wf,
      task: wf.tasks[0],
      error: new Error("x"),
      position: "iteration 3/10 (item: src/legacy.coffee)",
    });
    assert.ok(p.includes("src/legacy.coffee"));
    assert.ok(p.includes("iteration 3/10"));
  });
});

describe("describeWorkflow", () => {
  test("prefers the original YAML source", () => {
    assert.ok(
      describeWorkflow(failingWorkflow()).startsWith("goal: test goal"),
    );
  });

  test("falls back to a YAML dump when there is no source", () => {
    const { source: _source, ...wf } = failingWorkflow();
    const described = describeWorkflow(wf);
    assert.ok(described.includes("goal: test goal"));
    assert.ok(described.includes("boom"));
  });
});

// ----------------------------------------------------------------------------
// Response normalization
// ----------------------------------------------------------------------------

describe("normalizeRetrospective", () => {
  const minimal = {
    summary: "s",
    rootCause: "r",
    workflowFixable: false,
  };

  test("fills omitted collections and stamps the step name", () => {
    const r = normalizeRetrospective("build", minimal);
    assert.equal(r.step, "build");
    assert.deepEqual(r.evidence, []);
    assert.deepEqual(r.suggestions, []);
    assert.equal(r.refineInstruction, "");
  });

  test("defaults suggestion severity to medium", () => {
    const r = normalizeRetrospective("build", {
      ...minimal,
      suggestions: [{ issue: "i", change: "c" }],
    });
    assert.equal(r.suggestions[0].severity, "medium");
  });

  test("demotes fixable when no refine instruction was given", () => {
    const r = normalizeRetrospective("build", {
      ...minimal,
      workflowFixable: true,
      refineInstruction: "   ",
    });
    assert.equal(r.workflowFixable, false);
  });

  test("keeps fixable when an instruction is present", () => {
    const r = normalizeRetrospective("build", {
      ...minimal,
      workflowFixable: true,
      refineInstruction: "add a var",
    });
    assert.equal(r.workflowFixable, true);
    assert.equal(r.refineInstruction, "add a var");
  });
});

// ----------------------------------------------------------------------------
// Runner integration
// ----------------------------------------------------------------------------

describe("runner retrospective", () => {
  let originalPath: string;
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    originalFlag = process.env["EXECUTANT_RETROSPECTIVE"];
    delete process.env["EXECUTANT_RETROSPECTIVE"];
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    if (originalFlag === undefined)
      delete process.env["EXECUTANT_RETROSPECTIVE"];
    else process.env["EXECUTANT_RETROSPECTIVE"] = originalFlag;
  });

  test("emits a retrospective after a fatal failure, before rethrowing", async () => {
    installMock(VALID_RESPONSE);
    const { events, error } = await collectEventsUntilError(failingWorkflow());

    // The original failure must still propagate untouched.
    assert.ok(error);
    const retros = retroEvents(events);
    assert.equal(retros.length, 1);
    assert.equal(retros[0].index, 0);
    assert.equal(retros[0].retrospective.step, "boom");
    assert.equal(retros[0].retrospective.summary, "npm test failed");
    assert.equal(retros[0].retrospective.workflowFixable, true);

    // Ordering matters: step:error is what the UI renders first.
    const types = events.map((e) => e.type);
    assert.ok(
      types.indexOf("step:error") < types.indexOf("step:retrospective"),
    );
  });

  test("is skipped when EXECUTANT_RETROSPECTIVE=0", async () => {
    process.env["EXECUTANT_RETROSPECTIVE"] = "0";
    installMock(VALID_RESPONSE);
    const { events, error } = await collectEventsUntilError(failingWorkflow());
    assert.ok(error);
    assert.equal(retroEvents(events).length, 0);
  });

  test("is skipped for a continue_on_error step, which does not end the run", async () => {
    installMock(VALID_RESPONSE);
    const { events, error } = await collectEventsUntilError({
      goal: "g",
      tasks: [
        {
          type: "command",
          name: "soft",
          command: "exit 7",
          continueOnError: true,
        } satisfies CommandTask,
      ],
    });
    assert.equal(error, undefined);
    assert.equal(retroEvents(events).length, 0);
  });

  test("a broken analysis never masks the original failure", async () => {
    installMock("this is not JSON at all");
    const { events, error } = await collectEventsUntilError(failingWorkflow());
    assert.ok(error);
    assert.match(error.message, /exited with code 7/);
    assert.equal(retroEvents(events).length, 0);
  });
});

// ----------------------------------------------------------------------------
// Quality-control history
// ----------------------------------------------------------------------------

describe("describeQualityEvent", () => {
  test("keeps the judge's feedback, which lives nowhere else", () => {
    assert.equal(
      describeQualityEvent({
        type: "step:judge",
        index: 0,
        verdict: "fail",
        attempt: 2,
        maxAttempts: 5,
        feedback: "coverage is still below 80%",
      }),
      "judge attempt 2/5: FAIL — coverage is still below 80%",
    );
  });

  test("renders a pass verdict with no feedback", () => {
    assert.equal(
      describeQualityEvent({
        type: "step:judge",
        index: 0,
        verdict: "pass",
        attempt: 1,
        maxAttempts: 5,
      }),
      "judge attempt 1/5: PASS",
    );
  });

  test("renders self-healing phases with their exit code", () => {
    assert.equal(
      describeQualityEvent({
        type: "step:healing",
        index: 0,
        phase: "attempt-failed",
        attempt: 1,
        maxAttempts: 5,
        exitCode: 1,
      }),
      "self-healing attempt 1/5: attempt-failed (exit 1)",
    );
  });
});

describe("judge-failure retrospective", () => {
  let originalPath: string;
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    originalFlag = process.env["EXECUTANT_RETROSPECTIVE"];
    delete process.env["EXECUTANT_RETROSPECTIVE"];
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    if (originalFlag === undefined)
      delete process.env["EXECUTANT_RETROSPECTIVE"];
    else process.env["EXECUTANT_RETROSPECTIVE"] = originalFlag;
  });

  test("a step exhausted by llm_as_judge gets every verdict in its prompt", async () => {
    // The mock answers every call with the same payload, so the step's own
    // output, each judge verdict, and the retrospective all read as this JSON.
    // What matters here is the prompt the retrospective was handed — captured
    // from the last invocation's argv by installSequencedMock.
    const judgeFail = JSON.stringify({
      pass: false,
      feedback: "no tests were added",
    });
    const retro = JSON.stringify({
      summary: "The step never satisfied the judge.",
      rootCause: "The prompt has no checkable definition of done.",
      workflowFixable: true,
      refineInstruction: "Give the step an explicit success condition.",
    });
    // 5 judge attempts = 5 step calls + 5 judge calls, then the retrospective.
    const { promptsDir } = installSequencedMock([
      ...Array.from({ length: 5 }, () => ["work done", judgeFail]).flat(),
      retro,
    ]);

    const { events, error } = await collectEventsUntilError({
      goal: "judge goal",
      source: "goal: judge goal\n",
      tasks: [
        {
          type: "claude",
          name: "write-tests",
          prompt: "Add tests",
          llmAsJudge: true,
        },
      ],
    });

    assert.ok(error);
    assert.match(error.message, /judge evaluation after 5 attempts/);

    const retros = retroEvents(events);
    assert.equal(retros.length, 1);
    assert.equal(retros[0].retrospective.step, "write-tests");

    // The 11th call (index 10) is the retrospective; it must carry the judge
    // history, since the error message alone says only "after 5 attempts".
    const prompt = readFileSync(join(promptsDir, "10.txt"), "utf8");
    assert.ok(prompt.includes("judge attempt 1/5: FAIL"));
    assert.ok(prompt.includes("judge attempt 5/5: FAIL"));
    assert.ok(prompt.includes("no tests were added"));
  });
});

// ----------------------------------------------------------------------------
// Run options
// ----------------------------------------------------------------------------

describe("RunOptions.retrospective", () => {
  test("overrides the env var in both directions", async () => {
    const { runWorkflow } = await import("../runner.js");
    const collect = async (retrospective: boolean) => {
      const events: Event[] = [];
      try {
        for await (const e of runWorkflow(failingWorkflow(), {
          retrospective,
        }))
          events.push(e);
      } catch {
        /* expected */
      }
      return events;
    };

    const originalPath = process.env["PATH"] ?? "";
    const originalFlag = process.env["EXECUTANT_RETROSPECTIVE"];
    try {
      installMock(VALID_RESPONSE);
      // Env says off (the suite default); the option turns it back on.
      process.env["EXECUTANT_RETROSPECTIVE"] = "0";
      assert.equal(retroEvents(await collect(true)).length, 1);
      // Env says on; the option turns it off.
      delete process.env["EXECUTANT_RETROSPECTIVE"];
      assert.equal(retroEvents(await collect(false)).length, 0);
    } finally {
      process.env["PATH"] = originalPath;
      if (originalFlag === undefined)
        delete process.env["EXECUTANT_RETROSPECTIVE"];
      else process.env["EXECUTANT_RETROSPECTIVE"] = originalFlag;
    }
  });
});

// ----------------------------------------------------------------------------
// UI wiring
// ----------------------------------------------------------------------------

describe("fitLists", () => {
  test("shows everything when there is room", () => {
    assert.deepEqual(fitLists(3, 2, 40, 3), { evidence: 3, suggestions: 2 });
  });

  test("never renders more rows than the budget allows", () => {
    for (const rows of [10, 16, 24, 40, 60]) {
      const fit = fitLists(20, 20, rows, 3);
      assert.ok(
        fit.evidence + fit.suggestions * 2 <= Math.max(0, rows - 10 - 3),
        `overflowed at ${rows} rows`,
      );
    }
  });

  test("caps both lists even on a very tall terminal", () => {
    assert.deepEqual(fitLists(50, 50, 200, 3), { evidence: 4, suggestions: 4 });
  });

  test("gives the remaining space to suggestions, the actionable half", () => {
    const fit = fitLists(10, 10, 18, 3);
    assert.ok(fit.suggestions >= fit.evidence);
  });

  test("shows nothing rather than overflowing a very short terminal", () => {
    assert.deepEqual(fitLists(5, 5, 10, 3), { evidence: 0, suggestions: 0 });
  });

  test("still shows content in a standard 24-row terminal", () => {
    // App budgets terminalRows - 8 once the task list is hidden.
    const fit = fitLists(4, 2, 24 - 8, 3);
    assert.ok(fit.suggestions >= 1);
  });
});

describe("reducer step:retrospective", () => {
  test("stores the retrospective on the execution state", () => {
    const wf = loadWorkflow(
      tmpYaml("goal: g\nsteps:\n  - name: s\n    command: echo hi\n"),
    );
    const state = reducer(buildInitialState(wf), {
      type: "step:retrospective",
      index: 0,
      retrospective: SAMPLE,
    });
    assert.deepEqual(state.retrospective, SAMPLE);
  });
});

describe("availableActions", () => {
  test("offers the update action for a fixable failure with a local file", () => {
    const ids = availableActions(SAMPLE, "/tmp/task.yaml").map((a) => a.id);
    assert.deepEqual(ids, ["update", "dismiss"]);
  });

  test("hides the update action when the workflow is not at fault", () => {
    const ids = availableActions(
      { ...SAMPLE, workflowFixable: false, refineInstruction: "" },
      "/tmp/task.yaml",
    ).map((a) => a.id);
    assert.deepEqual(ids, ["dismiss"]);
  });

  test("hides the update action for a remote workflow with no local file", () => {
    const ids = availableActions(SAMPLE, undefined).map((a) => a.id);
    assert.deepEqual(ids, ["dismiss"]);
  });
});

describe("loadWorkflow retrospective inputs", () => {
  test("records the source path and raw YAML for refine to act on", () => {
    const yaml = "goal: g\nsteps:\n  - name: s\n    command: echo hi\n";
    const file = tmpYaml(yaml);
    const wf = loadWorkflow(file);
    assert.equal(wf.sourcePath, file);
    assert.equal(wf.source, yaml);
  });
});
