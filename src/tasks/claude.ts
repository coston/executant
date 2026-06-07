// ============================================================================
// CLAUDE RUNNER
// ============================================================================
// Invokes the Claude CLI with --output-format stream-json and streams its
// output as typed Events. Uses child_process.spawn with pipes — a PTY is not
// needed because --print + stream-json fully controls output formatting
// regardless of TTY detection.

import { execSync, spawn } from "node:child_process";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod";
import type { ClaudeTask, Event } from "../types.js";
import { mergeStreamsToLines, waitForExit, startTimeout } from "./stream.js";
import {
  extractJsonObject,
  getErrorMessage,
  loadPrompt,
  stripAnsi,
} from "../lib/utils.js";

export const METHODOLOGY = loadPrompt("development-methodology");

const DEFAULT_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

/** Constructs the CLI args array for a Claude invocation. Exported for testing. */
export function buildClaudeArgs(
  task: ClaudeTask,
  interactive = false,
): string[] {
  const allowedTools = task.allowedTools ?? DEFAULT_TOOLS;
  const permissionMode = task.permissionMode ?? "bypassPermissions";
  return [
    ...(interactive ? [] : ["--print", task.prompt]),
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    allowedTools.join(","),
    "--permission-mode",
    permissionMode,
    ...(task.model ? ["--model", task.model] : []),
    ...(task.appendSystemPrompt
      ? ["--append-system-prompt", task.appendSystemPrompt]
      : []),
    ...(task.jsonSchema
      ? ["--json-schema", JSON.stringify(task.jsonSchema)]
      : []),
  ];
}

/**
 * Resolves the absolute path to the claude binary.
 * Using the full path avoids PATH lookup issues when launched via npx/tsx.
 */
export function resolveClaudePath(): string {
  try {
    return execSync("which claude", { env: process.env }).toString().trim();
  } catch {
    throw new Error(
      "claude CLI not found. Ensure it is installed and in PATH.\n" +
        "  brew install claude  OR  npm install -g @anthropic-ai/claude-code",
    );
  }
}

/**
 * Runs a Claude task via child_process.spawn.
 * Throws if Claude exits with a non-zero exit code.
 * Yields output:text, output:tool, output:cost, and log events.
 */
export async function* runClaude(task: ClaudeTask): AsyncGenerator<Event> {
  yield {
    type: "log",
    level: "info",
    text: `claude -p "${task.prompt.slice(0, 60).replace(/\n/g, " ")}…"`,
  };

  const args = buildClaudeArgs(task);

  const claudeBin = resolveClaudePath();
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(claudeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn claude (${claudeBin}): ${getErrorMessage(err)}`,
    );
  }

  // Kill the subprocess if the parent process is signalled.
  const cleanup = () => {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGHUP", cleanup);

  const timeout = startTimeout(proc, task.name, task.timeoutSeconds);
  const plainLines: string[] = [];

  try {
    // Merge stdout and stderr into a single line stream, parse each JSON line.
    for await (const line of mergeStreamsToLines(proc.stdout!, proc.stderr!)) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as unknown;
        yield* parseClaudeMessage(msg);
      } catch {
        // Non-JSON lines (warnings, debug output) — pass through as text.
        const clean = stripAnsi(line);
        if (clean.trim()) {
          plainLines.push(clean);
          // index: -1 here — runWorkflow patches it to the real step index
          yield { type: "output:text", index: -1, text: clean };
        }
      }
    }

    const code = await waitForExit(proc);
    timeout.check();
    if (code !== 0) throw buildExitError(code, plainLines);
  } finally {
    timeout.cancel();
    process.off("SIGTERM", cleanup);
    process.off("SIGHUP", cleanup);
  }
}

// ----------------------------------------------------------------------------
// Claude stream-json message parsing
// ----------------------------------------------------------------------------

function* parseClaudeMessage(msg: unknown): Generator<Event> {
  if (!isObject(msg)) return;

  if (msg["type"] === "assistant") {
    const content = getArray(msg, "message", "content");
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block["type"] === "text") {
        const text = getString(block, "text");
        // index: -1 here — runWorkflow patches it to the real step index
        if (text) yield { type: "output:text", index: -1, text };
      } else if (block["type"] === "tool_use") {
        const tool = getString(block, "name") ?? "Unknown";
        const input = (
          isObject(block["input"]) ? block["input"] : {}
        ) as Record<string, unknown>;
        // index: -1 here — runWorkflow patches it to the real step index
        yield { type: "output:tool", index: -1, tool, input };
      }
    }
  } else if (msg["type"] === "result") {
    const cost = msg["total_cost_usd"];
    if (typeof cost === "number") {
      yield { type: "output:cost", usd: cost };
    }
    if (msg["structured_output"] != null) {
      yield { type: "output:structured", data: msg["structured_output"] };
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

export function buildExitError(code: number, plainLines: string[]): Error {
  const detail = plainLines.length > 0 ? `\n${plainLines.join("\n")}` : "";
  return new Error(`claude exited with code ${code}${detail}`);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getArray(
  obj: Record<string, unknown>,
  ...keys: string[]
): unknown[] {
  const result = keys.reduce<unknown>(
    (cur, k) => (isObject(cur) ? cur[k] : null),
    obj,
  );
  return Array.isArray(result) ? result : [];
}

function getString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Runs a Claude task and returns a schema-validated typed result.
 * Passes the Zod schema as --json-schema so the CLI enforces structure.
 * Falls back to text parsing for environments that don't support --json-schema
 * (e.g. mock CLIs in tests).
 */
export async function runClaudeStructured<T>(
  task: Omit<ClaudeTask, "jsonSchema">,
  schema: ZodType<T>,
): Promise<T> {
  const jsonSchema = zodToJsonSchema(schema) as Record<string, unknown>;
  let structuredOutput: unknown;
  const lines: string[] = [];
  for await (const event of runClaude({ ...task, jsonSchema })) {
    if (event.type === "output:structured") structuredOutput = event.data;
    else if (event.type === "output:text") lines.push(event.text);
  }
  if (structuredOutput === undefined && process.env["NODE_ENV"] !== "test") {
    console.warn(
      "[executant] runClaudeStructured: no output:structured event — falling back to text parsing",
    );
  }
  const data =
    structuredOutput ?? JSON.parse(extractJsonObject(lines.join("").trim()));
  return schema.parse(data);
}
