// ============================================================================
// WORKFLOW RESOLUTION
// ============================================================================
// Eagerly fetches and parses every `workflow:` step's referenced taskfile,
// however deep and however many hosts the chain crosses, before execution
// starts — so a bad reference anywhere fails fast, before any step runs or
// any API cost is spent. `loadWorkflow`/`parseWorkflow` (load-workflow.ts)
// produce WorkflowTasks with `workflow: null`; this module is the only place
// that turns them into fully resolved sub-workflows.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  fetchWorkflowSource,
  resolveWorkflowRef,
} from "./lib/remote-workflow.js";
import { parseWorkflow } from "./load-workflow.js";
import { getErrorMessage } from "./lib/utils.js";
import type { Origin, Task, Workflow, WorkflowTask } from "./types.js";

/** Chain length guard — a misconfigured deep chain fails with a clear error instead of hanging. */
export const MAX_WORKFLOW_NESTING_DEPTH = 10;

/** Total resolved-workflow guard, independent of depth — bounds a shallow-but-wide reference tree. */
export const MAX_RESOLVED_WORKFLOWS = 50;

interface Budget {
  remaining: number;
}

/**
 * Recursively resolves every `workflow:` step in `workflow`, returning a new
 * Workflow whose WorkflowTasks all carry a non-null `workflow`. A workflow
 * with no `workflow:` steps resolves immediately with its tasks unchanged.
 */
export async function resolveWorkflow(workflow: Workflow): Promise<Workflow> {
  return resolveInner(workflow, [], { remaining: MAX_RESOLVED_WORKFLOWS });
}

async function resolveInner(
  workflow: Workflow,
  chain: readonly string[],
  budget: Budget,
): Promise<Workflow> {
  const tasks = await Promise.all(
    workflow.tasks.map((task) =>
      resolveTask(task, workflow.origin, chain, budget),
    ),
  );
  return { ...workflow, tasks };
}

async function resolveTask(
  task: Task,
  origin: Origin | undefined,
  chain: readonly string[],
  budget: Budget,
): Promise<Task> {
  if (task.type !== "workflow" || task.workflow !== null) return task;
  return {
    ...task,
    workflow: await resolveReference(task, origin, chain, budget),
  };
}

async function resolveReference(
  task: WorkflowTask,
  origin: Origin | undefined,
  chain: readonly string[],
  budget: Budget,
): Promise<Workflow> {
  const { key, kind } = resolveWorkflowRef(origin, task.ref);

  if (chain.includes(key)) {
    throw new Error(
      `Circular workflow reference: ${[...chain, key].join(" → ")}`,
    );
  }
  if (chain.length >= MAX_WORKFLOW_NESTING_DEPTH) {
    throw new Error(
      `Workflow nesting exceeds max depth of ${MAX_WORKFLOW_NESTING_DEPTH} (at "${key}")`,
    );
  }
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    throw new Error(
      `Workflow reference tree exceeds max of ${MAX_RESOLVED_WORKFLOWS} resolved workflows (at "${key}")`,
    );
  }

  let text: string;
  try {
    text =
      kind === "remote"
        ? await fetchWorkflowSource(key)
        : readFileSync(key, "utf8");
  } catch (err) {
    throw new Error(
      `Step "${task.name}" references workflow "${task.ref}" which could not be loaded: ${getErrorMessage(err)}`,
    );
  }

  const childOrigin: Origin =
    kind === "remote"
      ? { kind: "remote", url: key }
      : { kind: "local", dir: dirname(key) };
  const parsed = parseWorkflow(text, key, task.refVars ?? {}, childOrigin);
  return resolveInner(parsed, [...chain, key], budget);
}
