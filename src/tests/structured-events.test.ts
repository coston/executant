// ============================================================================
// STRUCTURED EVENT TESTS (step:healing, step:judge, output:cost index)
// ============================================================================
// Asserts the structured events emitted alongside the free-text
// [self-healing]/[judge] logs: exact sequences, attempt counters, exit codes,
// and that runWorkflow patches the -1 index sentinel to the real step index.
//
// Uses mock claude binaries installed into temp dirs prepended to PATH.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type {
  Event,
  StepHealingEvent,
  StepJudgeEvent,
  Workflow,
} from "../types.js";
import { MAX_JUDGE_RETRIES } from "../runner.js";
import {
  collectEvents,
  collectEventsUntilError,
  flakyCommand,
  installMockClaude,
  installSequencedMock,
} from "./helpers.js";

function healingEvents(events: Event[]): StepHealingEvent[] {
  return events.filter((e): e is StepHealingEvent => e.type === "step:healing");
}

function judgeEvents(events: Event[]): StepJudgeEvent[] {
  return events.filter((e): e is StepJudgeEvent => e.type === "step:judge");
}

function judgeVerdict(pass: boolean, feedback: string): string {
  return JSON.stringify({ pass, reasoning: "evaluated", feedback });
}

/** A leading log step pushes the step under test to index 1, proving the -1
 *  sentinel is patched to the real index rather than accidentally matching 0. */
function withMarkerStep(task: Workflow["tasks"][number]): Workflow {
  return {
    goal: "structured events test",
    tasks: [{ type: "log", name: "marker", message: "start" }, task],
  };
}

// Top-level wrapper serialises all describe blocks: sibling describes can run
// concurrently, which would leak process.env mutations between them.
describe("structured events", { concurrency: 1 }, () => {
  let originalPath: string;
  let originalProvider: string | undefined;

  beforeEach(() => {
    originalPath = process.env["PATH"] ?? "";
    originalProvider = process.env["EXECUTANT_PROVIDER"];
    delete process.env["EXECUTANT_PROVIDER"];
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    if (originalProvider === undefined)
      delete process.env["EXECUTANT_PROVIDER"];
    else process.env["EXECUTANT_PROVIDER"] = originalProvider;
  });

  // --------------------------------------------------------------------------
  // step:healing
  // --------------------------------------------------------------------------

  describe("step:healing", () => {
    test("first-try success emits no step:healing events", async () => {
      const wf = withMarkerStep({
        type: "command",
        name: "passing",
        command: "echo ok",
        selfHealing: true,
      });

      const events = await collectEvents(wf);
      assert.deepEqual(healingEvents(events), []);
    });

    test("success after retry emits attempt-failed then healed with patched index", async () => {
      installMockClaude();
      const wf = withMarkerStep({
        type: "command",
        name: "flaky",
        command: flakyCommand(1),
        selfHealing: true,
        maxHealingAttempts: 3,
      });

      const events = await collectEvents(wf);
      assert.deepEqual(healingEvents(events), [
        {
          type: "step:healing",
          index: 1,
          phase: "attempt-failed",
          attempt: 1,
          maxAttempts: 3,
          exitCode: 1,
        },
        {
          type: "step:healing",
          index: 1,
          phase: "healed",
          attempt: 2,
          maxAttempts: 3,
        },
      ]);

      // Cost events from the healing Claude invocation carry the step's index.
      const costs = events.filter((e) => e.type === "output:cost");
      assert.deepEqual(costs, [{ type: "output:cost", index: 1, usd: 0.001 }]);
    });

    test("exhaustion emits attempt-failed per retry then exhausted with exit code", async () => {
      installMockClaude();
      const wf = withMarkerStep({
        type: "command",
        name: "doomed",
        command: "exit 42",
        selfHealing: true,
        maxHealingAttempts: 3,
      });

      const { events, error } = await collectEventsUntilError(wf);
      assert.ok(error, "Expected an error after exhausting attempts");
      assert.deepEqual(healingEvents(events), [
        {
          type: "step:healing",
          index: 1,
          phase: "attempt-failed",
          attempt: 1,
          maxAttempts: 3,
          exitCode: 42,
        },
        {
          type: "step:healing",
          index: 1,
          phase: "attempt-failed",
          attempt: 2,
          maxAttempts: 3,
          exitCode: 42,
        },
        {
          type: "step:healing",
          index: 1,
          phase: "exhausted",
          attempt: 3,
          maxAttempts: 3,
          exitCode: 42,
        },
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // step:judge
  // --------------------------------------------------------------------------

  describe("step:judge", () => {
    const wf = () =>
      withMarkerStep({
        type: "claude",
        name: "report",
        prompt: "Write a comprehensive report.",
        llmAsJudge: true,
      });

    test("pass on first attempt emits a single step:judge pass with patched index", async () => {
      installSequencedMock(["main step output", judgeVerdict(true, "")]);

      const events = await collectEvents(wf());
      assert.deepEqual(judgeEvents(events), [
        {
          type: "step:judge",
          index: 1,
          verdict: "pass",
          attempt: 1,
          maxAttempts: MAX_JUDGE_RETRIES,
        },
      ]);
    });

    test("fail then pass emits step:judge sequence with attempt numbers and feedback", async () => {
      const feedback = "add specific metrics and deadlines";
      installSequencedMock([
        "first attempt output",
        judgeVerdict(false, feedback),
        "improved output",
        judgeVerdict(true, ""),
      ]);

      const events = await collectEvents(wf());
      assert.deepEqual(judgeEvents(events), [
        {
          type: "step:judge",
          index: 1,
          verdict: "fail",
          attempt: 1,
          maxAttempts: MAX_JUDGE_RETRIES,
          feedback,
        },
        {
          type: "step:judge",
          index: 1,
          verdict: "pass",
          attempt: 2,
          maxAttempts: MAX_JUDGE_RETRIES,
        },
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // output:cost index patching
  // --------------------------------------------------------------------------

  describe("output:cost index", () => {
    test("output:cost events carry the real step index", async () => {
      installMockClaude();
      const wf = withMarkerStep({
        type: "claude",
        name: "ask",
        prompt: "Do a thing.",
      });

      const events = await collectEvents(wf);
      const costs = events.filter((e) => e.type === "output:cost");
      assert.deepEqual(costs, [{ type: "output:cost", index: 1, usd: 0.001 }]);
    });
  });
});
