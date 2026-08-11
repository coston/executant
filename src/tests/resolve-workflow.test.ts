// ============================================================================
// RESOLVE-WORKFLOW — eager resolution of nested `workflow:` steps
// ============================================================================
// Local chains use real tmp files (readFileSync is exercised for real).
// Remote chains stub globalThis.fetch, keyed by URL, so sibling/grandchild
// references that resolve concurrently each get the right response.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadWorkflow } from "../load-workflow.js";
import {
  MAX_RESOLVED_WORKFLOWS,
  MAX_WORKFLOW_NESTING_DEPTH,
  resolveWorkflow,
} from "../resolve-workflow.js";
import type { CommandTask, WorkflowTask } from "../types.js";
import { tmpDir, tmpYaml } from "./helpers.js";

function writeYaml(dir: string, name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

function stubFetch(responses: Record<string, string>): {
  captured: string[];
  restore: () => void;
} {
  const captured: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    captured.push(String(url));
    const body = responses[String(url)];
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "",
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { captured, restore: () => (globalThis.fetch = original) };
}

// ----------------------------------------------------------------------------
// Local chains
// ----------------------------------------------------------------------------

describe("resolveWorkflow — local references", () => {
  test("resolves a sibling local workflow", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nsteps:\n  - name: build\n    command: echo build\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n",
    );

    const resolved = await resolveWorkflow(loadWorkflow(parentPath));
    const task = resolved.tasks[0] as WorkflowTask;
    assert.equal(task.workflow?.goal, "child");
    assert.equal(task.workflow?.tasks[0].name, "build");
  });

  test("resolves a 3-level nested chain", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "c.yaml",
      "goal: c\nsteps:\n  - name: leaf\n    command: echo leaf\n",
    );
    writeYaml(
      dir,
      "b.yaml",
      "goal: b\nsteps:\n  - name: mid\n    workflow: ./c.yaml\n",
    );
    const aPath = writeYaml(
      dir,
      "a.yaml",
      "goal: a\nsteps:\n  - name: top\n    workflow: ./b.yaml\n",
    );

    const resolved = await resolveWorkflow(loadWorkflow(aPath));
    const b = (resolved.tasks[0] as WorkflowTask).workflow;
    const c = (b?.tasks[0] as WorkflowTask).workflow;
    assert.equal(b?.goal, "b");
    assert.equal(c?.goal, "c");
    assert.equal(c?.tasks[0].name, "leaf");
  });

  test("detects a circular reference with a clear chain message", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "a.yaml",
      "goal: a\nsteps:\n  - name: to-b\n    workflow: ./b.yaml\n",
    );
    const bPath = writeYaml(
      dir,
      "b.yaml",
      "goal: b\nsteps:\n  - name: to-a\n    workflow: ./a.yaml\n",
    );

    // The root's own path isn't tracked in the chain (only resolved
    // references are), so the cycle is reported one hop later than the
    // entry point — the chain names both files and repeats one of them.
    await assert.rejects(
      () => resolveWorkflow(loadWorkflow(bPath)),
      (err: Error) =>
        /^Circular workflow reference: /.test(err.message) &&
        err.message.includes("a.yaml") &&
        err.message.includes("b.yaml"),
    );
  });

  test("throws once the chain exceeds the max nesting depth", async () => {
    const dir = tmpDir();
    const depth = MAX_WORKFLOW_NESTING_DEPTH + 2;
    // file[i] references file[i+1]; file[depth-1] is a plain leaf.
    for (let i = depth - 1; i >= 0; i--) {
      const content =
        i === depth - 1
          ? "goal: leaf\nsteps:\n  - name: leaf\n    command: echo leaf\n"
          : `goal: level-${i}\nsteps:\n  - name: next\n    workflow: ./file-${i + 1}.yaml\n`;
      writeYaml(dir, `file-${i}.yaml`, content);
    }
    await assert.rejects(
      () => resolveWorkflow(loadWorkflow(join(dir, "file-0.yaml"))),
      /exceeds max depth of \d+/,
    );
  });

  test("throws once the total resolved-workflow budget is exceeded", async () => {
    const dir = tmpDir();
    const count = MAX_RESOLVED_WORKFLOWS + 1;
    const steps: string[] = [];
    for (let i = 0; i < count; i++) {
      writeYaml(
        dir,
        `child-${i}.yaml`,
        `goal: child-${i}\nsteps:\n  - name: leaf\n    command: echo ${i}\n`,
      );
      steps.push(`  - name: step-${i}\n    workflow: ./child-${i}.yaml\n`);
    }
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      `goal: parent\nsteps:\n${steps.join("")}`,
    );

    await assert.rejects(
      () => resolveWorkflow(loadWorkflow(parentPath)),
      /exceeds max of \d+ resolved workflows/,
    );
  });

  test("vars on the workflow step reach the child's rendered command", async () => {
    const dir = tmpDir();
    writeYaml(
      dir,
      "child.yaml",
      "goal: child\nvars:\n  region: default-region\nsteps:\n  - name: deploy\n    command: deploy --region {{region}}\n",
    );
    const parentPath = writeYaml(
      dir,
      "parent.yaml",
      "goal: parent\nsteps:\n  - name: deploy\n    workflow: ./child.yaml\n    vars:\n      region: us-east-1\n",
    );

    const resolved = await resolveWorkflow(loadWorkflow(parentPath));
    const child = (resolved.tasks[0] as WorkflowTask).workflow;
    const command = (child?.tasks[0] as CommandTask).command;
    assert.equal(command, "deploy --region us-east-1");
  });

  test("a workflow with no workflow: steps passes through with tasks unchanged", async () => {
    const wf = loadWorkflow(
      tmpYaml("goal: plain\nsteps:\n  - name: only\n    command: echo hi\n"),
    );
    const resolved = await resolveWorkflow(wf);
    assert.deepEqual(resolved.tasks, wf.tasks);
  });
});

// ----------------------------------------------------------------------------
// Remote references (fetch stubbed)
// ----------------------------------------------------------------------------

describe("resolveWorkflow — remote references", () => {
  test("resolves a sibling reference under a remote parent", async () => {
    const parentUrl =
      "https://raw.githubusercontent.com/o/r/main/tasks/parent.yaml";
    const childUrl =
      "https://raw.githubusercontent.com/o/r/main/tasks/child.yaml";
    const { captured, restore } = stubFetch({
      [childUrl]:
        "goal: child\nsteps:\n  - name: build\n    command: echo build\n",
    });
    try {
      const parent = {
        goal: "parent",
        tasks: [
          {
            type: "workflow" as const,
            name: "deploy",
            ref: "./child.yaml",
            workflow: null,
          },
        ],
        origin: { kind: "remote" as const, url: parentUrl },
      };
      const resolved = await resolveWorkflow(parent);
      const task = resolved.tasks[0] as WorkflowTask;
      assert.equal(task.workflow?.goal, "child");
      assert.deepEqual(captured, [childUrl]);
    } finally {
      restore();
    }
  });

  test("resolves a ../ reference under a remote parent", async () => {
    const parentUrl =
      "https://raw.githubusercontent.com/o/r/main/tasks/parent.yaml";
    const childUrl =
      "https://raw.githubusercontent.com/o/r/main/shared/child.yaml";
    const { restore } = stubFetch({
      [childUrl]: "goal: child\nsteps: []\n",
    });
    try {
      const parent = {
        goal: "parent",
        tasks: [
          {
            type: "workflow" as const,
            name: "deploy",
            ref: "../shared/child.yaml",
            workflow: null,
          },
        ],
        origin: { kind: "remote" as const, url: parentUrl },
      };
      const resolved = await resolveWorkflow(parent);
      assert.equal((resolved.tasks[0] as WorkflowTask).workflow?.goal, "child");
    } finally {
      restore();
    }
  });

  test("local parent can reference an absolute remote child", async () => {
    const dir = tmpDir();
    const childUrl = "https://example.com/deploy.yaml";
    const { restore } = stubFetch({
      [childUrl]: "goal: remote-child\nsteps: []\n",
    });
    try {
      const parentPath = writeYaml(
        dir,
        "parent.yaml",
        `goal: parent\nsteps:\n  - name: deploy\n    workflow: ${childUrl}\n`,
      );
      const resolved = await resolveWorkflow(loadWorkflow(parentPath));
      assert.equal(
        (resolved.tasks[0] as WorkflowTask).workflow?.goal,
        "remote-child",
      );
    } finally {
      restore();
    }
  });

  test("remote parent + relative reference resolves via URL, never the local filesystem", async () => {
    // No local file named this way exists anywhere relevant — if resolution
    // fell back to readFileSync it would throw ENOENT instead of fetching.
    const parentUrl =
      "https://raw.githubusercontent.com/o/r/main/tasks/parent.yaml";
    const childUrl =
      "https://raw.githubusercontent.com/o/r/main/tasks/definitely-not-a-local-file.yaml";
    const { captured, restore } = stubFetch({
      [childUrl]: "goal: child\nsteps: []\n",
    });
    try {
      const parent = {
        goal: "parent",
        tasks: [
          {
            type: "workflow" as const,
            name: "deploy",
            ref: "./definitely-not-a-local-file.yaml",
            workflow: null,
          },
        ],
        origin: { kind: "remote" as const, url: parentUrl },
      };
      const resolved = await resolveWorkflow(parent);
      assert.equal((resolved.tasks[0] as WorkflowTask).workflow?.goal, "child");
      assert.deepEqual(captured, [childUrl]);
    } finally {
      restore();
    }
  });
});
