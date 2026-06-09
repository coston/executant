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

/**
 * Runs a prompt template with substituted vars through the specified model (no tools).
 * Defaults to Claude/sonnet when no model target is provided.
 * Returns the full text output as a string.
 */
export async function runPrompt(
  templatePath: string,
  vars: Record<string, string>,
  model?: ModelTarget,
): Promise<string> {
  const template = stripPromptHeader(readFileSync(templatePath, "utf8"));
  const prompt = substituteVars(template, vars);

  const provider = model?.provider ?? "claude";
  const isOpenCode = provider === "opencode";

  const lines: string[] = [];
  for await (const event of runAgent({
    type: "claude",
    name: `eval:${basename(templatePath, ".txt")}`,
    prompt,
    allowedTools: [],
    // OpenCode: bypass permissions so tool-call permission prompts don't block
    // headless eval runs indefinitely. Timeout as a secondary safety net.
    permissionMode: isOpenCode ? "bypassPermissions" : "default",
    timeoutSeconds: isOpenCode ? 1200 : undefined,
    provider,
    ...(model?.model ? { model: model.model } : {}),
    // METHODOLOGY is injected via --append-system-prompt (Claude only).
    // OpenCode doesn't support this flag — omit it for non-Claude providers.
    ...(!isOpenCode ? { appendSystemPrompt: METHODOLOGY } : {}),
  })) {
    if (event.type === "output:text") lines.push(event.text);
  }

  return lines.join("");
}
