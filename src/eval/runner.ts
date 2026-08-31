import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { METHODOLOGY } from "../tasks/claude.js";
import { runAgent } from "../tasks/agent.js";
import { stripPromptHeader } from "../lib/utils.js";
import type { ModelTarget } from "./types.js";

/**
 * Substitutes {{PLACEHOLDER}} tokens in a template string with resolved values.
 */
export function substituteVars(
  template: string,
  vars: Record<string, string>,
): string {
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, v),
    template,
  );
}

/** Result of running a prompt template through a model. */
interface PromptRunResult {
  output: string;
  /** API cost in USD, when the provider reports it (Claude only — OpenCode/local models don't). */
  costUsd?: number;
}

/**
 * Runs a prompt template with substituted vars through the specified model (no tools).
 * Defaults to Claude/sonnet when no model target is provided.
 * Returns the full text output plus cost, when the provider reports one.
 */
export async function runPrompt(
  templatePath: string,
  vars: Record<string, string>,
  model?: ModelTarget,
): Promise<PromptRunResult> {
  const template = stripPromptHeader(readFileSync(templatePath, "utf8"));
  const prompt = substituteVars(template, vars);

  const provider = model?.provider ?? "claude";
  const isOpenCode = provider === "opencode";

  const lines: string[] = [];
  let costUsd: number | undefined;
  for await (const event of runAgent({
    type: "claude",
    name: `eval:${basename(templatePath, ".txt")}`,
    prompt,
    allowedTools: [],
    // Use default permission mode for all providers so that OPENCODE_PERMISSION
    // deny rules are respected. --dangerously-skip-permissions overrides
    // OPENCODE_PERMISSION and allows OpenCode to write files despite allowedTools: [].
    permissionMode: "default",
    timeoutSeconds: isOpenCode ? 1200 : undefined,
    provider,
    ...(model?.model ? { model: model.model } : {}),
    // METHODOLOGY is injected via --append-system-prompt (Claude only).
    // OpenCode doesn't support this flag — omit it for non-Claude providers.
    ...(!isOpenCode ? { appendSystemPrompt: METHODOLOGY } : {}),
  })) {
    if (event.type === "output:text") lines.push(event.text);
    else if (event.type === "output:cost") costUsd = event.usd;
  }

  return { output: lines.join(""), costUsd };
}
