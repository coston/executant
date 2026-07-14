// ============================================================================
// OPENCODE RUNNER
// ============================================================================
// Invokes the OpenCode CLI with --format json and streams its output as typed
// Events. Mirrors the interface of claude.ts so agent.ts can dispatch to either.
//
// Full implementation in PR 2. This stub is present so agent.ts compiles and
// all existing tests pass with the Claude default.

import { execSync, spawn } from "node:child_process";
import type { ZodType } from "zod";
import type { ClaudeTask, Event } from "../types.js";
import { resolveAgentModel } from "./agent.js";
import { mergeStreamsToLines, waitForExit, startTimeout } from "./stream.js";
import { extractJsonObject, getErrorMessage, stripAnsi } from "../lib/utils.js";
import { traceparentEnv } from "../lib/trace-context.js";

/**
 * Resolves the absolute path to the opencode binary.
 * Throws with install instructions if not found.
 */
export function resolveOpenCodePath(): string {
  try {
    return execSync("which opencode", { env: process.env }).toString().trim();
  } catch {
    throw new Error(
      "opencode CLI not found. Ensure it is installed and in PATH.\n" +
        "  npm install -g opencode-ai  OR  see https://opencode.ai/docs/cli",
    );
  }
}

const OPENCODE_ALL_TOOLS = [
  "bash",
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "task",
  "skill",
  "lsp",
  "todowrite",
  "question",
  "external_directory",
  "doom_loop",
];

/**
 * Builds the OPENCODE_PERMISSION env var value from allowedTools:
 *   undefined        → no env set (unrestricted, default behavior)
 *   []               → deny all tools (text-only mode)
 *   ['bash','read']  → deny every tool NOT in the list
 *
 * Tool names are matched case-insensitively so Claude names ('Bash', 'Read')
 * and opencode names ('bash', 'read') both work.
 */
export function buildOpenCodePermissionEnv(
  allowedTools: string[] | undefined,
): string | undefined {
  if (!allowedTools) return undefined;
  const allowed = new Set(allowedTools.map((t) => t.toLowerCase()));
  const denied = OPENCODE_ALL_TOOLS.filter((t) => !allowed.has(t));
  if (denied.length === 0) return undefined;
  return JSON.stringify(
    denied.map((t) => ({ permission: t, action: "deny", pattern: "*" })),
  );
}

/** Constructs the CLI args array for an OpenCode invocation. Exported for testing. */
export function buildOpenCodeArgs(task: ClaudeTask): string[] {
  const model = resolveAgentModel(task);
  const agent = task.agent ?? process.env["EXECUTANT_AGENT"];
  const permissionMode = task.permissionMode ?? "bypassPermissions";

  return [
    "run",
    "--format",
    "json",
    ...(model ? ["--model", model] : []),
    ...(agent ? ["--agent", agent] : []),
    ...(permissionMode === "bypassPermissions"
      ? ["--dangerously-skip-permissions"]
      : []),
    task.prompt,
  ];
}

/**
 * Runs an OpenCode task via child_process.spawn.
 * Throws if opencode exits with a non-zero exit code.
 * Yields output:text, output:tool, and log events.
 */
export async function* runOpenCode(task: ClaudeTask): AsyncGenerator<Event> {
  yield {
    type: "log",
    level: "info",
    text: `opencode run "${task.prompt.slice(0, 60).replace(/\n/g, " ")}…"`,
  };

  const opencodeBin = resolveOpenCodePath();
  const args = buildOpenCodeArgs(task);

  let proc: ReturnType<typeof spawn>;
  try {
    const permissionEnv = buildOpenCodePermissionEnv(task.allowedTools);
    proc = spawn(opencodeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...traceparentEnv(),
        ...(permissionEnv ? { OPENCODE_PERMISSION: permissionEnv } : {}),
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn opencode (${opencodeBin}): ${getErrorMessage(err)}`,
    );
  }

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
    for await (const line of mergeStreamsToLines(proc.stdout!, proc.stderr!)) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as unknown;
        yield* parseOpenCodeMessage(msg);
      } catch {
        const clean = stripAnsi(line);
        if (clean.trim()) {
          plainLines.push(clean);
          yield { type: "output:text", index: -1, text: clean };
        }
      }
    }

    const code = await waitForExit(proc);
    timeout.check();
    if (code !== 0) {
      const detail = plainLines.length ? `\n${plainLines.join("\n")}` : "";
      throw new Error(`opencode exited with code ${code}${detail}`);
    }
  } finally {
    timeout.cancel();
    process.off("SIGTERM", cleanup);
    process.off("SIGHUP", cleanup);
  }
}

// ----------------------------------------------------------------------------
// OpenCode JSON event parsing
// ----------------------------------------------------------------------------

function* parseOpenCodeMessage(msg: unknown): Generator<Event> {
  if (!isObject(msg)) return;

  const type = stringValue(msg["type"]);

  if (type === "text") {
    const text =
      nestedString(msg, ["part", "text"]) ??
      nestedString(msg, ["part", "content"]) ??
      stringValue(msg["text"]);
    if (text) yield { type: "output:text", index: -1, text };
    return;
  }

  if (type === "tool_use") {
    const tool =
      nestedString(msg, ["part", "tool"]) ??
      stringValue(msg["tool"]) ??
      "Unknown";
    const input =
      nestedObject(msg, ["part", "state", "input"]) ??
      nestedObject(msg, ["input"]) ??
      {};
    yield {
      type: "output:tool",
      index: -1,
      tool: normalizeToolName(tool),
      input,
    };
    return;
  }

  if (type === "error") {
    const text =
      nestedString(msg, ["error", "message"]) ??
      stringValue(msg["message"]) ??
      JSON.stringify(msg);
    yield { type: "output:text", index: -1, text };
  }
  // Unknown event types are silently ignored.
}

/**
 * Runs an OpenCode task and returns a schema-validated typed result.
 * Appends a JSON-only instruction since OpenCode has no native --json-schema.
 * Falls back to text parsing via extractJsonObject + schema.parse.
 */
export async function runOpenCodeStructured<T>(
  task: Omit<ClaudeTask, "jsonSchema">,
  schema: ZodType<T>,
): Promise<T> {
  const prompt = `${task.prompt}\n\nReturn only one valid JSON object matching the required schema. Do not wrap it in markdown code fences.`;

  const lines: string[] = [];
  for await (const event of runOpenCode({ ...task, prompt })) {
    if (event.type === "output:text") lines.push(event.text);
  }

  const combined = lines.join("\n").trim();
  if (!combined) {
    throw new Error(
      `opencode returned no output for structured task "${task.name}". ` +
        `Check the model and prompt.`,
    );
  }

  const raw = extractJsonObject(combined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `opencode did not return a JSON object for task "${task.name}".\n` +
        `Output was:\n${combined.slice(0, 500)}`,
    );
  }

  return schema.parse(parsed);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function normalizeToolName(tool: string): string {
  const lower = tool.toLowerCase();
  const map: Record<string, string> = {
    bash: "Bash",
    read: "Read",
    edit: "Edit",
    write: "Write",
    glob: "Glob",
    grep: "Grep",
  };
  return map[lower] ?? tool;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function nestedString(
  obj: Record<string, unknown>,
  path: string[],
): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return stringValue(cur);
}

function nestedObject(
  obj: Record<string, unknown>,
  path: string[],
): Record<string, unknown> | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return isObject(cur) ? cur : undefined;
}
