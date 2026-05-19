// ============================================================================
// LOAD-WORKFLOW — extended coverage
// ============================================================================
// Tests for substituteVars, type inference, validation errors, and edge cases
// not covered by the existing context/forEach/output/self-healing test files.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadWorkflow } from "../load-workflow.js";
import type { ClaudeTask, CommandTask, LogTask } from "../types.js";
import { tmpYaml } from "./helpers.js";

// ----------------------------------------------------------------------------
// Variable substitution
// ----------------------------------------------------------------------------

describe("loadWorkflow — variable substitution", () => {
  test("substitutes a single var in a command", () => {
    const file = tmpYaml(`
goal: test
vars:
  env: production
steps:
  - name: deploy
    command: deploy --env {{env}}
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;
    assert.equal(task.command, "deploy --env production");
  });

  test("substitutes multiple vars in a single prompt", () => {
    const file = tmpYaml(`
goal: test
vars:
  file: src/app.ts
  lang: TypeScript
steps:
  - name: review
    prompt: "Review {{file}} which is written in {{lang}}"
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as ClaudeTask;
    assert.equal(
      task.prompt,
      "Review src/app.ts which is written in TypeScript",
    );
  });

  test("leaves {{item}} unreplaced for runner-time substitution", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: process
    forEach: [a, b]
    command: echo {{item}}
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0];
    assert.equal(task.type, "forEach");
    if (task.type === "forEach") {
      assert.equal((task.inner[0] as CommandTask).command, "echo {{item}}");
    }
  });

  test("throws at load time for unknown placeholder in command", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: deploy
    command: echo {{unknown}}
`);
    assert.throws(
      () => loadWorkflow(file),
      /Step "deploy" command contains unknown placeholder "\{\{unknown\}\}"/,
    );
  });

  test("throws at load time for unknown placeholder in prompt", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: review
    prompt: Review {{missing_var}} for issues
`);
    assert.throws(
      () => loadWorkflow(file),
      /Step "review" prompt contains unknown placeholder "\{\{missing_var\}\}"/,
    );
  });

  test("{{item}} in forEach inner step does not throw", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: process
    forEach: [a, b]
    command: echo {{item}}
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, "forEach");
  });

  test("vars map defaults to empty when not specified", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: simple
    command: echo hi
`);
    const wf = loadWorkflow(file);
    assert.deepEqual(wf.vars, {});
  });

  test("vars are accessible on the returned workflow", () => {
    const file = tmpYaml(`
goal: test
vars:
  key: value
steps:
  - name: s
    command: echo {{key}}
`);
    const wf = loadWorkflow(file);
    assert.deepEqual(wf.vars, { key: "value" });
  });
});

// ----------------------------------------------------------------------------
// Type inference
// ----------------------------------------------------------------------------

describe("loadWorkflow — type inference", () => {
  test("step with command field and no type is inferred as CommandTask", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: build
    command: npm run build
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, "command");
  });

  test("step with prompt field and no type is inferred as ClaudeTask", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: review
    prompt: Please review this code
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, "claude");
  });

  test("step with message and no prompt is inferred as LogTask", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: marker
    message: Starting phase 2
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, "log");
  });

  test("explicit type: prompt takes precedence", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: explicit
    type: prompt
    prompt: Do something
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, "claude");
  });

  test("explicit type: script creates CommandTask", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: run
    type: script
    command: npm test
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, "command");
  });

  test("explicit type: log creates LogTask", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: info
    type: log
    message: Done
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].type, "log");
  });

  test("log step uses name as message when message is absent", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: Phase complete
    type: log
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as LogTask;
    assert.equal(task.message, "Phase complete");
  });
});

// ----------------------------------------------------------------------------
// Validation errors
// ----------------------------------------------------------------------------

describe("loadWorkflow — validation errors", () => {
  test("throws when goal field is missing", () => {
    const file = tmpYaml(`
steps:
  - name: s
    command: echo hi
`);
    assert.throws(() => loadWorkflow(file), /goal.*required/i);
  });

  test("throws when steps array is missing", () => {
    const file = tmpYaml(`
goal: something
`);
    assert.throws(() => loadWorkflow(file), /steps.*required/i);
  });

  test("throws for prompt step without prompt field", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    type: prompt
`);
    assert.throws(() => loadWorkflow(file), /no prompt field/i);
  });

  test("throws for script step without command field", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    type: script
`);
    assert.throws(() => loadWorkflow(file), /no command/i);
  });

  test("throws for unknown explicit type", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: bad
    type: invalid_type
    command: echo hi
`);
    assert.throws(() => loadWorkflow(file), /invalid enum value/i);
  });

  test("throws when file cannot be read", () => {
    assert.throws(
      () => loadWorkflow("/nonexistent/path/workflow.yaml"),
      /Cannot read/i,
    );
  });
});

// ----------------------------------------------------------------------------
// self_improve field
// ----------------------------------------------------------------------------

describe("loadWorkflow — self_improve", () => {
  test("selfImprove is true when self_improve: true", () => {
    const file = tmpYaml(`
goal: test
self_improve: true
steps:
  - name: s
    command: echo hi
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.selfImprove, true);
  });

  test("selfImprove is undefined when not specified", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: s
    command: echo hi
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.selfImprove, undefined);
  });
});

// ----------------------------------------------------------------------------
// continueOnError field
// ----------------------------------------------------------------------------

describe("loadWorkflow — continueOnError", () => {
  test("continueOnError is false by default", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: s
    command: echo hi
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].continueOnError, false);
  });

  test("continueOnError: true is parsed", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: s
    command: echo hi
    continue_on_error: true
`);
    const wf = loadWorkflow(file);
    assert.equal(wf.tasks[0].continueOnError, true);
  });
});

// ----------------------------------------------------------------------------
// Zod schema validation — new coverage
// ----------------------------------------------------------------------------

describe("loadWorkflow — Zod schema new coverage", () => {
  test("throws a descriptive error when vars is not an object", () => {
    const file = tmpYaml(`
goal: test
vars: "not-an-object"
steps:
  - name: s
    command: echo hi
`);
    assert.throws(() => loadWorkflow(file), /vars/);
  });

  test("throws a descriptive error when command is not a string", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: build
    command: 42
`);
    assert.throws(() => loadWorkflow(file), /command/i);
  });

  test("throws a descriptive error when steps is null", () => {
    const file = tmpYaml(`
goal: test
steps: null
`);
    assert.throws(() => loadWorkflow(file), /steps/i);
  });

  test("unknown placeholder error names both step name and field", () => {
    const file = tmpYaml(`
goal: test
steps:
  - name: my-step
    prompt: Fix {{missing_var}} please
`);
    assert.throws(
      () => loadWorkflow(file),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("my-step"),
          "error should name the step",
        );
        assert.ok(
          err.message.includes("prompt"),
          "error should name the field",
        );
        assert.ok(
          err.message.includes("{{missing_var}}"),
          "error should name the placeholder",
        );
        return true;
      },
    );
  });

  test("valid workflow with vars loads without error", () => {
    const file = tmpYaml(`
goal: Run tests
vars:
  env: ci
steps:
  - name: test
    command: npm test --env {{env}}
`);
    assert.doesNotThrow(() => loadWorkflow(file));
    const wf = loadWorkflow(file);
    assert.equal(wf.goal, "Run tests");
    assert.equal(wf.tasks.length, 1);
  });
});

// ----------------------------------------------------------------------------
// substituteVars regression — P2-7 ($1, $2, \n in replacement values)
// ----------------------------------------------------------------------------

describe("loadWorkflow — substituteVars regression (P2-7)", () => {
  test("var value containing $1 is substituted literally", () => {
    const file = tmpYaml(`
goal: test
vars:
  arg: "$1"
steps:
  - name: run
    command: echo {{arg}}
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;
    assert.equal(task.command, "echo $1");
  });

  test("var value containing $2 is substituted literally", () => {
    const file = tmpYaml(`
goal: test
vars:
  arg: "$2"
steps:
  - name: run
    command: echo {{arg}}
`);
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;
    assert.equal(task.command, "echo $2");
  });

  test("var value containing a newline is substituted as-is", () => {
    const file = tmpYaml(`
goal: test
vars:
  msg: "before\\nafter"
steps:
  - name: run
    command: show {{msg}}
`);
    // JS template \\n → YAML file has "before\nafter"; YAML double-quote \n → actual newline
    const wf = loadWorkflow(file);
    const task = wf.tasks[0] as CommandTask;
    assert.equal(task.command, "show before\nafter");
  });
});
