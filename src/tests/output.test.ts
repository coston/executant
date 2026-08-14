// ============================================================================
// OUTPUT CAPTURE TESTS
// ============================================================================
// Verifies that `output:` resolves var names → file paths in load-workflow
// for both step types that support it, and that the runner applies the
// right semantics per type: a script step's stdout is captured to that file;
// a claude/prompt step's file is only checked for existence afterward (its
// real artifact is whatever it wrote via tool calls, not narration text).
// Also verifies `output:` is rejected at load time on step types that have
// nothing to produce (log, workflow).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { loadWorkflow } from "../load-workflow.js";
import type { ClaudeTask, CommandTask, Workflow } from "../types.js";
import {
  tmpDir,
  tmpYaml,
  collectEvents,
  collectEventsUntilError,
  installMockClaude,
} from "./helpers.js";

// ----------------------------------------------------------------------------
// load-workflow: output var resolution
// ----------------------------------------------------------------------------

describe("loadWorkflow — output", () => {
  test("resolves output var name to file path on CommandTask", () => {
    const dir = tmpDir();
    const outputPath = join(dir, "coverage.txt");

    const file = tmpYaml(`
goal: test
vars:
  coverage_out: "${outputPath}"
steps:
  - name: run_coverage
    type: script
    command: echo "coverage data"
    output: coverage_out
`);

    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.type, "command");
    assert.equal(task.output, outputPath);
  });

  test("output is absent when not set", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: no_output
    type: script
    command: echo hi
`);

    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.output, undefined);
  });

  test("throws when output references an undefined var", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad_ref
    type: script
    command: echo oops
    output: missing_var
`);

    assert.throws(
      () => loadWorkflow(file),
      (err: Error) => {
        assert.ok(
          err.message.includes("missing_var"),
          `expected "missing_var" in: ${err.message}`,
        );
        assert.ok(
          err.message.includes('"bad_ref"'),
          `expected step name in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("resolves an output var whose own value nests another var placeholder", () => {
    const dir = tmpDir();
    // coverage_out's raw value nests {{docs_dir}} — the same pattern real
    // workflows use (e.g. ticket_file: "{{docs_dir}}/ticket.md"). A prior bug
    // returned this raw, unresolved (a literal "{{docs_dir}}" path segment)
    // because output resolution was a plain lookup, not a substitution.
    const file = tmpYaml(`
goal: test
vars:
  coverage_out: "{{docs_dir}}/coverage.txt"
  docs_dir: "${dir}"
steps:
  - name: run_coverage
    type: script
    command: echo "coverage data"
    output: coverage_out
`);

    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.output, join(dir, "coverage.txt"));
  });

  test("output works alongside self_healing and max_healing_attempts", () => {
    const dir = tmpDir();
    const outputPath = join(dir, "out.txt");

    const file = tmpYaml(`
goal: test
vars:
  out_file: "${outputPath}"
steps:
  - name: combo
    type: script
    command: echo ok
    output: out_file
    self_healing: true
    max_healing_attempts: 3
`);

    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;

    assert.equal(task.output, outputPath);
    assert.equal(task.selfHealing, true);
    assert.equal(task.maxHealingAttempts, 3);
  });

  test("resolves output var name to file path on ClaudeTask", () => {
    const dir = tmpDir();
    const outputPath = join(dir, "diagnostic.md");

    const file = tmpYaml(`
goal: test
vars:
  diagnostic_file: "${outputPath}"
steps:
  - name: diagnose
    prompt: Write findings.
    output: diagnostic_file
`);

    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ClaudeTask;

    assert.equal(task.type, "claude");
    assert.equal(task.output, outputPath);
  });

  test("throws when output is set on a log step", () => {
    const file = tmpYaml(`
goal: test
vars:
  out_file: /tmp/whatever.txt
steps:
  - name: bad_log
    type: log
    message: hello
    output: out_file
`);

    assert.throws(
      () => loadWorkflow(file),
      (err: Error) => {
        assert.ok(
          err.message.includes('"bad_log"'),
          `expected step name in: ${err.message}`,
        );
        assert.ok(
          err.message.includes("log"),
          `expected mention of log step in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("throws when output is set on a workflow step", () => {
    const nested = tmpYaml(`
goal: nested
steps:
  - name: inner
    type: log
    message: hi
`);
    const file = tmpYaml(`
goal: test
vars:
  out_file: /tmp/whatever.txt
steps:
  - name: bad_workflow
    workflow: "${nested}"
    output: out_file
`);

    assert.throws(
      () => loadWorkflow(file),
      (err: Error) => {
        assert.ok(
          err.message.includes('"bad_workflow"'),
          `expected step name in: ${err.message}`,
        );
        assert.ok(
          err.message.includes("workflow"),
          `expected mention of workflow step in: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ----------------------------------------------------------------------------
// runner: output postcondition check on prompt (claude) steps
// ----------------------------------------------------------------------------

describe("runWorkflow — output check on claude steps", () => {
  let originalPath: string;
  let originalProvider: string | undefined;

  beforeEach(() => {
    originalProvider = process.env["EXECUTANT_PROVIDER"];
    delete process.env["EXECUTANT_PROVIDER"];
    const mock = installMockClaude();
    originalPath = mock.originalPath;
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    if (originalProvider === undefined)
      delete process.env["EXECUTANT_PROVIDER"];
    else process.env["EXECUTANT_PROVIDER"] = originalProvider;
  });

  test("claude step succeeds when its expected output file exists after the run", async () => {
    const dir = tmpDir();
    const outputPath = join(dir, "diagnostic.md");
    // Simulates the agent having already written the file via its own
    // Write/Edit tool calls during the turn — this test exercises the
    // runner's postcondition check, not whether an LLM actually writes files.
    writeFileSync(outputPath, "# findings", "utf8");

    const wf: Workflow = {
      goal: "test",
      tasks: [
        {
          type: "claude",
          name: "diagnose",
          prompt: "Write findings.",
          output: outputPath,
        },
      ],
    };

    const events = await collectEvents(wf);

    assert.ok(events.some((e) => e.type === "workflow:complete"));
  });

  test("claude step fails when its expected output file is missing after the run", async () => {
    const dir = tmpDir();
    const outputPath = join(dir, "never-written.md");

    const wf: Workflow = {
      goal: "test",
      tasks: [
        {
          type: "claude",
          name: "diagnose",
          prompt: "Write findings.",
          output: outputPath,
        },
      ],
    };

    const { error } = await collectEventsUntilError(wf);

    assert.ok(error, "Expected the step to fail");
    assert.ok(
      error!.message.includes('"diagnose"'),
      `expected step name in: ${error!.message}`,
    );
    assert.ok(
      error!.message.includes(outputPath),
      `expected output path in: ${error!.message}`,
    );
  });
});

// ----------------------------------------------------------------------------
// runner: output file capture
// ----------------------------------------------------------------------------

describe("runWorkflow — output capture", () => {
  test("writes command stdout to output file", async () => {
    const dir = tmpDir();
    const outputPath = join(dir, "result.txt");

    const wf: Workflow = {
      goal: "test",
      tasks: [
        {
          type: "command",
          name: "echo_test",
          command: 'echo "line one" && echo "line two"',
          selfHealing: false,
          output: outputPath,
        },
      ],
    };

    await collectEvents(wf);

    assert.ok(existsSync(outputPath), "Output file should exist");
    const contents = readFileSync(outputPath, "utf8");
    assert.ok(
      contents.includes("line one"),
      `Expected "line one" in: ${contents}`,
    );
    assert.ok(
      contents.includes("line two"),
      `Expected "line two" in: ${contents}`,
    );
  });

  test("creates parent directories for output file", async () => {
    const dir = tmpDir();
    const outputPath = join(dir, "nested", "deep", "output.txt");

    const wf: Workflow = {
      goal: "test",
      tasks: [
        {
          type: "command",
          name: "nested_out",
          command: 'echo "nested output"',
          selfHealing: false,
          output: outputPath,
        },
      ],
    };

    await collectEvents(wf);

    assert.ok(existsSync(outputPath), "Output file in nested dir should exist");
    const contents = readFileSync(outputPath, "utf8");
    assert.ok(contents.includes("nested output"));
  });

  test("does not create output file when output is not set", async () => {
    const dir = tmpDir();

    const wf: Workflow = {
      goal: "test",
      tasks: [
        {
          type: "command",
          name: "no_output",
          command: 'echo "invisible"',
          selfHealing: false,
        },
      ],
    };

    const events = await collectEvents(wf);

    // Verify workflow completed but no extra files written
    assert.ok(events.some((e) => e.type === "workflow:complete"));
    // No files should be created in our temp dir (it was empty)
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dir);
    assert.equal(
      files.length,
      0,
      `Expected empty dir, found: ${files.join(", ")}`,
    );
  });

  test("captures stderr in output file", async () => {
    const dir = tmpDir();
    const outputPath = join(dir, "stderr-test.txt");

    const wf: Workflow = {
      goal: "test",
      tasks: [
        {
          type: "command",
          name: "stderr_test",
          command: 'echo "stdout line" && echo "stderr line" >&2',
          selfHealing: false,
          output: outputPath,
        },
      ],
    };

    await collectEvents(wf);

    const contents = readFileSync(outputPath, "utf8");
    assert.ok(
      contents.includes("stdout line"),
      `Expected stdout in output: ${contents}`,
    );
    assert.ok(
      contents.includes("stderr line"),
      `Expected stderr in output: ${contents}`,
    );
  });

  test("does not write output file when command fails", async () => {
    const dir = tmpDir();
    const outputPath = join(dir, "should-not-exist.txt");

    const wf: Workflow = {
      goal: "test",
      tasks: [
        {
          type: "command",
          name: "failing",
          command: 'echo "partial" && exit 1',
          selfHealing: false,
          output: outputPath,
          continueOnError: true,
        },
      ],
    };

    await collectEventsUntilError(wf);

    assert.ok(
      !existsSync(outputPath),
      "Output file should not be created on failure",
    );
  });
});

// ----------------------------------------------------------------------------
// runner: output + self-healing interaction
// ----------------------------------------------------------------------------

describe("runWorkflow — output with self-healing", () => {
  let originalPath: string;
  let originalProvider: string | undefined;

  beforeEach(() => {
    originalProvider = process.env["EXECUTANT_PROVIDER"];
    delete process.env["EXECUTANT_PROVIDER"];
    const mock = installMockClaude();
    originalPath = mock.originalPath;
  });

  afterEach(() => {
    process.env["PATH"] = originalPath;
    if (originalProvider === undefined)
      delete process.env["EXECUTANT_PROVIDER"];
    else process.env["EXECUTANT_PROVIDER"] = originalProvider;
  });

  test("captures final successful output after healing", async () => {
    const dir = tmpDir();
    const counterFile = join(dir, "counter");
    writeFileSync(counterFile, "0", "utf8");
    const outputPath = join(dir, "healed-output.txt");

    // Command fails first time (count=0), succeeds on second (count=1)
    const cmd = `count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; echo "attempt $count"; test "$count" -gt 0`;

    const wf: Workflow = {
      goal: "test",
      tasks: [
        {
          type: "command",
          name: "heals_then_passes",
          command: cmd,
          selfHealing: true,
          maxHealingAttempts: 3,
          output: outputPath,
        },
      ],
    };

    await collectEvents(wf);

    assert.ok(existsSync(outputPath), "Output file should exist after healing");
    const contents = readFileSync(outputPath, "utf8");
    // The successful run outputs "attempt 1" (count was 1 on second run)
    assert.ok(
      contents.includes("attempt 1"),
      `Expected successful attempt output. Got: ${contents}`,
    );
  });
});

// ----------------------------------------------------------------------------
// Integration: output + context round-trip via load-workflow
// ----------------------------------------------------------------------------

describe("output + context round-trip", () => {
  test("output var and context var reference the same file path", () => {
    const dir = tmpDir();
    const sharedPath = join(dir, "shared.txt");

    const file = tmpYaml(`
goal: test
vars:
  report: "${sharedPath}"
steps:
  - name: produce
    type: script
    command: echo "data"
    output: report
  - name: consume
    prompt: Analyze the report.
    context: [report]
`);

    const wf = loadWorkflow(file);
    const producer = wf.tasks[0] as CommandTask;
    const consumer = wf.tasks[1] as { type: string; contextFiles?: string[] };

    assert.equal(producer.output, sharedPath);
    assert.deepEqual(consumer.contextFiles, [sharedPath]);
  });
});
