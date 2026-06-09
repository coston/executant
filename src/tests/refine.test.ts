// ============================================================================
// REFINE SUBCOMMAND — unit tests
// ============================================================================
// Tests pure helper functions in src/refine.ts.
// parseRefineArgs is tested via argument-parsing error paths,
// intercepting process.exit so the test process doesn't actually quit.
// streamRefine is tested end-to-end via mock claude binaries installed into PATH.
//
// Two-pass pipeline order per successful run:
//   Invocation 0: Refine pass (structured_output with workflow JSON)
//   Invocation 1: Judge pass (text with JSON {"pass":true,"feedback":""})

import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach, mock } from "node:test";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRefineArgs, streamRefine } from "../refine.js";
import type { RefineArgs } from "../refine.js";
import type { PlanEvent } from "../ui/PlanApp.js";

// ---------------------------------------------------------------------------
// parseRefineArgs — argument validation
// ---------------------------------------------------------------------------

describe("parseRefineArgs — argument errors", () => {
  let exitCode: number | undefined;
  let stderrLines: string[];
  let originalExit: typeof process.exit;

  beforeEach(() => {
    exitCode = undefined;
    stderrLines = [];
    originalExit = process.exit;

    mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });

    (process as NodeJS.Process).exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${exitCode})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    mock.restoreAll();
  });

  function stderr(): string {
    return stderrLines.join("");
  }

  test("exits 1 with usage message when no args provided", () => {
    assert.throws(() => parseRefineArgs([]), /process\.exit\(1\)/);
    assert.equal(exitCode, 1);
    assert.ok(stderr().includes("No task file specified"));
  });

  test("exits 1 when task file does not exist", () => {
    assert.throws(
      () => parseRefineArgs(["/nonexistent/path/task.yaml", "simplify"]),
      /process\.exit\(1\)/,
    );
    assert.equal(exitCode, 1);
    assert.ok(stderr().includes("File not found"));
  });

  test("exits 1 when no instructions provided and stdin is a TTY", () => {
    const tmpFile = join(tmpdir(), `refine-test-${process.pid}.yaml`);
    writeFileSync(
      tmpFile,
      "goal: test\nsteps:\n  - name: a\n    prompt: do it\n",
    );

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    try {
      assert.throws(() => parseRefineArgs([tmpFile]), /process\.exit\(1\)/);
      assert.equal(exitCode, 1);
      assert.ok(stderr().includes("No refinement instructions provided"));
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
      rmSync(tmpFile, { force: true });
    }
  });

  test("exits 1 when -f given without a path", () => {
    const tmpFile = join(tmpdir(), `refine-test-${process.pid}.yaml`);
    writeFileSync(
      tmpFile,
      "goal: test\nsteps:\n  - name: a\n    prompt: do it\n",
    );

    try {
      assert.throws(
        () => parseRefineArgs([tmpFile, "-f"]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitCode, 1);
      assert.ok(stderr().includes("-f/--file requires a file path"));
    } finally {
      rmSync(tmpFile, { force: true });
    }
  });

  test("exits 1 when -f instructions file does not exist", () => {
    const tmpFile = join(tmpdir(), `refine-test-${process.pid}.yaml`);
    writeFileSync(
      tmpFile,
      "goal: test\nsteps:\n  - name: a\n    prompt: do it\n",
    );

    try {
      assert.throws(
        () => parseRefineArgs([tmpFile, "-f", "/no/such/file.txt"]),
        /process\.exit\(1\)/,
      );
      assert.equal(exitCode, 1);
      assert.ok(stderr().includes("File not found"));
    } finally {
      rmSync(tmpFile, { force: true });
    }
  });

  test("exits 0 and prints help for --help", () => {
    assert.throws(() => parseRefineArgs(["--help"]), /process\.exit\(0\)/);
    assert.equal(exitCode, 0);
  });

  test("exits 0 and prints help for -h", () => {
    assert.throws(() => parseRefineArgs(["-h"]), /process\.exit\(0\)/);
    assert.equal(exitCode, 0);
  });
});

describe("parseRefineArgs — success cases", () => {
  let tmpFile: string;
  let originalExit: typeof process.exit;

  const YAML_CONTENT =
    "goal: Add user authentication\nsteps:\n  - name: implement\n    prompt: Implement auth\n";

  beforeEach(() => {
    tmpFile = join(
      tmpdir(),
      `refine-test-success-${process.pid}-${Date.now()}.yaml`,
    );
    writeFileSync(tmpFile, YAML_CONTENT);
    originalExit = process.exit;
    (process as NodeJS.Process).exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    rmSync(tmpFile, { force: true });
  });

  test("parses task file and positional instructions", () => {
    const args = parseRefineArgs([tmpFile, "make it simpler"]);
    assert.equal(args.taskFile, tmpFile);
    assert.equal(args.instructions, "make it simpler");
    assert.equal(args.existingYaml, YAML_CONTENT.trim());
    assert.equal(args.description, "Add user authentication");
  });

  test("parses multi-word instructions", () => {
    const args = parseRefineArgs([tmpFile, "add", "e2e", "tests"]);
    assert.equal(args.instructions, "add e2e tests");
  });

  test("extracts goal from YAML as description", () => {
    const args = parseRefineArgs([tmpFile, "simplify"]);
    assert.equal(args.description, "Add user authentication");
  });

  test("uses default description when YAML has no goal", () => {
    const noGoalFile = join(tmpdir(), `refine-nogoal-${process.pid}.yaml`);
    writeFileSync(noGoalFile, "steps:\n  - name: a\n    prompt: do it\n");
    try {
      const args = parseRefineArgs([noGoalFile, "simplify"]);
      assert.equal(args.description, "Refine workflow");
    } finally {
      rmSync(noGoalFile, { force: true });
    }
  });

  test("reads instructions from -f file", () => {
    const instrFile = join(tmpdir(), `refine-instr-${process.pid}.txt`);
    writeFileSync(instrFile, "add e2e screenshot tests\n");
    try {
      const args = parseRefineArgs([tmpFile, "-f", instrFile]);
      assert.equal(args.instructions, "add e2e screenshot tests");
    } finally {
      rmSync(instrFile, { force: true });
    }
  });

  test("reads instructions from --file", () => {
    const instrFile = join(tmpdir(), `refine-instr2-${process.pid}.txt`);
    writeFileSync(instrFile, "simplify to 3 steps");
    try {
      const args = parseRefineArgs([tmpFile, "--file", instrFile]);
      assert.equal(args.instructions, "simplify to 3 steps");
    } finally {
      rmSync(instrFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// streamRefine — end-to-end tests via mock claude binary
// ---------------------------------------------------------------------------

type MockResponse = { structured?: unknown; text?: string; exitCode?: number };

function installRefineMock(responses: MockResponse[]): {
  counterFile: string;
  originalPath: string;
} {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mockDir = join(tmpdir(), `executant-refine-mock-${id}`);
  const responsesDir = join(mockDir, "responses");
  const counterFile = join(mockDir, "counter");

  mkdirSync(responsesDir, { recursive: true });
  writeFileSync(counterFile, "0", "utf8");

  for (const [i, resp] of responses.entries()) {
    const lines: string[] = [];
    if (resp.text) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: resp.text }] },
        }),
      );
    }
    const result: Record<string, unknown> = {
      type: "result",
      total_cost_usd: 0.001,
    };
    if (resp.structured !== undefined)
      result["structured_output"] = resp.structured;
    lines.push(JSON.stringify(result));
    writeFileSync(
      join(responsesDir, `${i}.ndjson`),
      lines.join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      join(responsesDir, `${i}.exit`),
      String(resp.exitCode ?? 0),
      "utf8",
    );
  }

  const fallback = join(responsesDir, "fallback.ndjson");
  writeFileSync(
    fallback,
    JSON.stringify({ type: "result", total_cost_usd: 0 }) + "\n",
    "utf8",
  );

  const mockScript = join(mockDir, "claude");
  writeFileSync(
    mockScript,
    `#!/usr/bin/env bash
count=$(cat "${counterFile}")
echo $((count + 1)) > "${counterFile}"
f="${responsesDir}/$count.ndjson"
exitf="${responsesDir}/$count.exit"
[ -f "$f" ] && cat "$f" || cat "${fallback}"
exitcode=0
[ -f "$exitf" ] && exitcode=$(cat "$exitf")
exit $exitcode
`,
    "utf8",
  );
  chmodSync(mockScript, 0o755);

  const originalPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${mockDir}:${originalPath}`;
  return { counterFile, originalPath };
}

const ORIGINAL_YAML =
  "goal: Add user authentication\nsteps:\n  - name: implement\n    prompt: Implement user authentication with JWT.\n";

const REFINED_WORKFLOW = {
  goal: "Add user authentication",
  steps: [
    { name: "implement", prompt: "Implement user authentication with JWT." },
    { name: "test", type: "script", command: "npm test" },
  ],
};

const JUDGE_PASS = JSON.stringify({ pass: true, feedback: "" });
const JUDGE_FAIL = JSON.stringify({
  pass: false,
  feedback: "Missing verification steps.",
});

describe("streamRefine", () => {
  let tmpFile: string;
  let savedPath: string;
  let savedProvider: string | undefined;

  beforeEach(() => {
    savedPath = process.env["PATH"] ?? "";
    savedProvider = process.env["EXECUTANT_PROVIDER"];
    delete process.env["EXECUTANT_PROVIDER"];
    tmpFile = join(
      tmpdir(),
      `executant-refine-${process.pid}-${Date.now()}.yaml`,
    );
    writeFileSync(tmpFile, ORIGINAL_YAML);
  });

  afterEach(() => {
    process.env["PATH"] = savedPath;
    if (savedProvider === undefined) delete process.env["EXECUTANT_PROVIDER"];
    else process.env["EXECUTANT_PROVIDER"] = savedProvider;
    rmSync(tmpFile, { force: true });
  });

  function makeRefineArgs(opts: Partial<RefineArgs> = {}): RefineArgs {
    return {
      taskFile: tmpFile,
      existingYaml: ORIGINAL_YAML.trim(),
      instructions: "add a test step",
      description: "Add user authentication",
      ...opts,
    };
  }

  async function collectEvents(args: RefineArgs): Promise<PlanEvent[]> {
    const events: PlanEvent[] = [];
    for await (const e of streamRefine(args)) events.push(e);
    return events;
  }

  function stageEvents(events: PlanEvent[]) {
    return events.filter(
      (e): e is Extract<PlanEvent, { type: "plan:stage" }> =>
        e.type === "plan:stage",
    );
  }

  test("success: writes refined YAML in-place (2 invocations: refine, judge)", async () => {
    const { counterFile } = installRefineMock([
      { structured: REFINED_WORKFLOW, text: "Refining…" },
      { text: JUDGE_PASS },
    ]);

    const args = makeRefineArgs();
    const events = await collectEvents(args);

    assert.equal(
      readFileSync(counterFile, "utf8").trim(),
      "2",
      "Expected exactly 2 Claude invocations",
    );

    const complete = events.find((e) => e.type === "plan:complete") as
      | Extract<PlanEvent, { type: "plan:complete" }>
      | undefined;
    assert.ok(complete, "Expected plan:complete event");
    assert.equal(complete!.taskFile, tmpFile);

    assert.ok(existsSync(tmpFile), "Expected YAML file to still exist");
    const yaml = readFileSync(tmpFile, "utf8");
    assert.ok(
      yaml.includes("goal: Add user authentication"),
      "YAML missing goal",
    );
    assert.ok(yaml.includes("name: test"), "YAML missing new test step");

    assert.ok(
      !events.some((e) => e.type === "plan:error"),
      "Expected no plan:error",
    );
    assert.ok(
      !events.some((e) => e.type === "plan:retry"),
      "Expected no plan:retry",
    );
  });

  test("stage events emitted in correct order: Refine → Validate (2 stages only)", async () => {
    installRefineMock([{ structured: REFINED_WORKFLOW }, { text: JUDGE_PASS }]);

    const events = await collectEvents(makeRefineArgs());
    const stages = stageEvents(events);

    assert.equal(stages.length, 2, "Expected exactly 2 plan:stage events");
    assert.equal(stages[0]!.stage, 1);
    assert.equal(stages[0]!.name, "Refine");
    assert.equal(stages[0]!.total, 2);
    assert.equal(stages[1]!.stage, 2);
    assert.equal(stages[1]!.name, "Validate");
    assert.equal(stages[1]!.total, 2);
  });

  test("judge rejects on first attempt, refine retried with feedback", async () => {
    const { counterFile } = installRefineMock([
      { structured: REFINED_WORKFLOW },
      { text: JUDGE_FAIL },
      { structured: REFINED_WORKFLOW },
      { text: JUDGE_PASS },
    ]);

    const events = await collectEvents(makeRefineArgs());

    assert.equal(
      readFileSync(counterFile, "utf8").trim(),
      "4",
      "Expected exactly 4 invocations",
    );

    assert.ok(
      existsSync(tmpFile),
      "Expected YAML file written after judge-retry",
    );
    assert.ok(
      events.some((e) => e.type === "plan:retry"),
      "Expected plan:retry event",
    );
    assert.ok(
      events.some((e) => e.type === "plan:complete"),
      "Expected plan:complete",
    );
    assert.ok(
      !events.some((e) => e.type === "plan:error"),
      "Expected no plan:error",
    );

    const stage1Events = stageEvents(events).filter((e) => e.stage === 1);
    assert.equal(stage1Events.length, 2, "Expected stage 1 to appear twice");
  });

  test("refine pass returns no structured output: retries with schema error", async () => {
    const { counterFile } = installRefineMock([
      { text: "Not JSON…" },
      { structured: REFINED_WORKFLOW },
      { text: JUDGE_PASS },
    ]);

    const events = await collectEvents(makeRefineArgs());

    assert.equal(
      readFileSync(counterFile, "utf8").trim(),
      "3",
      "Expected exactly 3 invocations",
    );

    assert.ok(existsSync(tmpFile), "Expected YAML written after retry");
    assert.ok(
      events.some((e) => e.type === "plan:complete"),
      "Expected plan:complete",
    );
    assert.ok(
      events.some((e) => e.type === "plan:retry"),
      "Expected plan:retry",
    );
    assert.ok(
      !events.some((e) => e.type === "plan:error"),
      "Expected no plan:error",
    );
  });

  test("three consecutive refine failures: yields plan:error and original YAML preserved", async () => {
    const { counterFile } = installRefineMock([
      { text: "attempt 1" },
      { text: "attempt 2" },
      { text: "attempt 3" },
    ]);

    const events = await collectEvents(makeRefineArgs());

    assert.equal(
      readFileSync(counterFile, "utf8").trim(),
      "3",
      "Expected exactly 3 Claude invocations",
    );

    const errorEvent = events.find((e) => e.type === "plan:error") as
      | Extract<PlanEvent, { type: "plan:error" }>
      | undefined;
    assert.ok(errorEvent, "Expected plan:error event");
    assert.ok(
      errorEvent!.message.length > 0,
      "Error message must be non-empty",
    );

    assert.ok(
      !events.some((e) => e.type === "plan:complete"),
      "Expected no plan:complete",
    );

    const yaml = readFileSync(tmpFile, "utf8");
    assert.ok(
      yaml.includes("goal: Add user authentication"),
      "Original YAML should be preserved",
    );
    assert.ok(
      !yaml.includes("name: test"),
      "Refined content must not appear on failure",
    );

    const retryEvents = events.filter((e) => e.type === "plan:retry");
    assert.equal(retryEvents.length, 2, "Expected 2 plan:retry events");
  });

  test("judge rejects on all 3 attempts: YAML still written (non-blocking)", async () => {
    const { counterFile } = installRefineMock([
      { structured: REFINED_WORKFLOW },
      { text: JUDGE_FAIL },
      { structured: REFINED_WORKFLOW },
      { text: JUDGE_FAIL },
      { structured: REFINED_WORKFLOW },
      { text: JUDGE_FAIL },
    ]);

    const events = await collectEvents(makeRefineArgs());

    assert.equal(
      readFileSync(counterFile, "utf8").trim(),
      "6",
      "Expected exactly 6 invocations",
    );

    assert.ok(
      events.some((e) => e.type === "plan:complete"),
      "Expected plan:complete — judge is non-blocking",
    );
    assert.ok(
      existsSync(tmpFile),
      "Expected YAML written despite judge rejections",
    );
    assert.ok(
      !events.some((e) => e.type === "plan:error"),
      "Expected no plan:error",
    );

    const warnEvent = events.find(
      (e): e is Extract<PlanEvent, { type: "plan:warn" }> =>
        e.type === "plan:warn",
    );
    assert.ok(warnEvent, "Expected a plan:warn event about judge rejection");

    const retryEvents = events.filter((e) => e.type === "plan:retry");
    assert.equal(retryEvents.length, 2, "Expected 2 plan:retry events");
  });

  test("plan:start event emitted with workflow description", async () => {
    installRefineMock([{ structured: REFINED_WORKFLOW }, { text: JUDGE_PASS }]);

    const events = await collectEvents(makeRefineArgs());
    const start = events.find((e) => e.type === "plan:start") as
      | Extract<PlanEvent, { type: "plan:start" }>
      | undefined;
    assert.ok(start, "Expected plan:start event");
    assert.equal(start!.description, "Add user authentication");
  });

  test("plan:stages event emitted with correct names", async () => {
    installRefineMock([{ structured: REFINED_WORKFLOW }, { text: JUDGE_PASS }]);

    const events = await collectEvents(makeRefineArgs());
    const stagesEvent = events.find((e) => e.type === "plan:stages") as
      | Extract<PlanEvent, { type: "plan:stages" }>
      | undefined;
    assert.ok(stagesEvent, "Expected plan:stages event");
    assert.deepEqual(stagesEvent!.names, ["Refine", "Validate"]);
  });

  test("refined YAML preview is included in plan:complete event", async () => {
    installRefineMock([{ structured: REFINED_WORKFLOW }, { text: JUDGE_PASS }]);

    const events = await collectEvents(makeRefineArgs());
    const complete = events.find((e) => e.type === "plan:complete") as
      | Extract<PlanEvent, { type: "plan:complete" }>
      | undefined;
    assert.ok(complete, "Expected plan:complete event");
    assert.ok(complete!.preview.length > 0, "Preview must be non-empty");
    assert.ok(
      complete!.preview.includes("goal:"),
      "Preview should include YAML content",
    );
  });
});
