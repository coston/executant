// ============================================================================
// WORKFLOW LOADER
// ============================================================================
// Converts a YAML file into a typed Workflow object.
//
// Mapping:
//   type: prompt  → ClaudeTask  (step has a `prompt` field)
//   type: script  → CommandTask (step has a `command` field)
//   type: log     → LogTask     (step has a `message` field)
//   (no type)     → inferred from presence of prompt/command/message

import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { getErrorMessage, fillTemplate, formatZodIssues } from "./lib/utils.js";
import { z } from "zod";
import type {
  ClaudeTask,
  CommandTask,
  ForEachTask,
  LogTask,
  RawStep,
  Task,
  Workflow,
} from "./types.js";

export const RawStepSchema: z.ZodType<RawStep> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.enum(["prompt", "script", "log", "command"]).optional(),
    prompt: z.string().optional(),
    command: z.string().optional(),
    message: z.string().optional(),
    continue_on_error: z.boolean().optional(),
    self_healing: z.boolean().optional(),
    max_healing_attempts: z.number().int().positive().optional(),
    output: z.string().optional(),
    llm_as_judge: z.boolean().optional(),
    allowed_tools: z.array(z.string()).optional(),
    forEach: z.union([z.array(z.string()), z.string()]).optional(),
    repeat: z.number().int().positive().optional(),
    context: z.array(z.string()).optional(),
    steps: z.array(RawStepSchema).min(1).optional(),
  }),
);

const RawWorkflowSchema = z.object({
  goal: z.string(),
  steps: z.array(RawStepSchema),
  vars: z.record(z.string(), z.string()).optional(),
  self_improve: z.boolean().optional(),
});

export function loadWorkflow(filePath: string): Workflow {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read workflow file "${filePath}": ${getErrorMessage(err)}`,
    );
  }

  let doc: z.infer<typeof RawWorkflowSchema>;
  try {
    doc = RawWorkflowSchema.parse(parseYaml(raw));
  } catch (err) {
    const detail =
      err instanceof z.ZodError ? formatZodIssues(err.errors) : String(err);
    throw new Error(`Invalid workflow file "${filePath}":\n${detail}`);
  }

  const vars = doc.vars ?? {};

  const seen = new Set<string>();
  for (const step of doc.steps) {
    if (seen.has(step.name)) {
      throw new Error(
        `Duplicate step name "${step.name}" — step names must be unique within a workflow`,
      );
    }
    seen.add(step.name);
  }

  return {
    goal: doc.goal,
    vars,
    selfImprove: doc.self_improve,
    tasks: doc.steps.map((step) => convertStep(step, vars)),
  };
}

// ----------------------------------------------------------------------------
// Step conversion
// ----------------------------------------------------------------------------

function convertStep(step: RawStep, vars: Record<string, string>): Task {
  const { name, continue_on_error: continueOnError = false } = step;

  // forEach/repeat wraps inner steps — detect before type switch.
  // NOTE: substituteVars is called inside convertInnerStep, which means only
  // workflow vars are substituted. {{item}} is intentionally left as-is here
  // because it is a runtime placeholder resolved by the runner per iteration.
  if (step.repeat !== undefined && step.forEach !== undefined) {
    throw new Error(`Step "${name}" cannot have both repeat and forEach`);
  }
  if (step.repeat !== undefined || step.forEach !== undefined) {
    if (step.steps && (step.command || step.prompt || step.message)) {
      throw new Error(
        `Step "${name}" cannot have both steps and command/prompt/message`,
      );
    }
    const forEachValue =
      step.repeat !== undefined
        ? Array.from({ length: step.repeat }, (_, i) => String(i + 1))
        : step.forEach!;
    const stepWithoutLoop = {
      ...step,
      repeat: undefined,
      forEach: undefined,
      steps: undefined,
    };
    const inner: Task[] = step.steps
      ? step.steps.map((s) => convertStep(s, vars))
      : [convertInnerStep(stepWithoutLoop, vars, name, continueOnError)];
    return {
      type: "forEach",
      name,
      continueOnError,
      forEach: forEachValue,
      inner,
    } satisfies ForEachTask;
  }

  if (step.steps) {
    throw new Error(`Step "${name}" has steps but no forEach or repeat`);
  }

  return convertInnerStep(step, vars, name, continueOnError);
}

function convertInnerStep(
  step: RawStep,
  vars: Record<string, string>,
  name: string,
  continueOnError: boolean,
): Task {
  // Resolve effective type from explicit field or infer from content.
  const effectiveType = step.type ?? inferType(step);

  switch (effectiveType) {
    case "script":
    case "command": {
      if (!step.command)
        throw new Error(`Step "${name}" has type script but no command`);
      return {
        type: "command",
        name,
        command: substituteVars(step.command, vars, name, "command"),
        continueOnError,
        selfHealing: step.self_healing === true,
        maxHealingAttempts: step.max_healing_attempts,
        ...(step.output && {
          output: resolveOutputFile(step.output, vars, name),
        }),
      } satisfies CommandTask;
    }

    case "log": {
      const message = step.message ?? step.prompt ?? name;
      return {
        type: "log",
        name,
        message: substituteVars(message, vars, name, "message"),
        continueOnError,
      } satisfies LogTask;
    }

    case "prompt": {
      if (!step.prompt)
        throw new Error(`Step "${name}" has type prompt but no prompt field`);
      const contextFiles = resolveContextFiles(step.context, vars, name);
      return {
        type: "claude",
        name,
        prompt: substituteVars(step.prompt, vars, name, "prompt"),
        continueOnError,
        llmAsJudge: step.llm_as_judge,
        allowedTools: step.allowed_tools,
        model: "sonnet",
        ...(contextFiles.length > 0 && { contextFiles }),
      } satisfies ClaudeTask;
    }

    default:
      throw new Error(`Step "${name}" has unknown type: "${effectiveType}"`);
  }
}

function inferType(step: RawStep): string {
  if (step.command) return "script";
  if (step.message && !step.prompt) return "log";
  return "prompt";
}

function resolveVarPath(
  varName: string,
  vars: Record<string, string>,
  stepName: string,
  label: string,
): string {
  if (!(varName in vars)) {
    throw new Error(
      `Step "${stepName}" ${label} references undefined var "${varName}" — add it to the vars section`,
    );
  }
  return vars[varName];
}

function resolveContextFiles(
  contextVarNames: string[] | undefined,
  vars: Record<string, string>,
  stepName: string,
): string[] {
  if (!contextVarNames || contextVarNames.length === 0) return [];
  return contextVarNames.map((varName) =>
    resolveVarPath(varName, vars, stepName, "context"),
  );
}

function resolveOutputFile(
  varName: string,
  vars: Record<string, string>,
  stepName: string,
): string {
  return resolveVarPath(varName, vars, stepName, "output");
}

/** Replaces {{var_name}} placeholders using the vars map.
 * Throws at load time if any unknown placeholder (other than {{item}}) remains. */
function substituteVars(
  text: string,
  vars: Record<string, string>,
  stepName: string,
  field: string,
): string {
  const result = fillTemplate(text, vars);

  const unknownTokens = [...result.matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1])
    .filter((key) => key !== "item");
  if (unknownTokens.length > 0) {
    throw new Error(
      `Step "${stepName}" ${field} contains unknown placeholder "{{${unknownTokens[0]}}}" — add it to the vars section`,
    );
  }

  return result;
}
