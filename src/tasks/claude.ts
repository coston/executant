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
import type {
  ClaudeTask,
  Event,
  OutputRateLimitEvent,
  RateLimitStatus,
  RateLimitWindow,
  TokenUsage,
} from "../types.js";
import { resolveAgentModel } from "./agent.js";
import {
  mergeStreamsToLines,
  waitForExit,
  startTimeout,
  writePrompt,
} from "./stream.js";
import { salvageStructured } from "./structured.js";
import {
  extractJsonObject,
  getErrorMessage,
  loadPrompt,
  stripAnsi,
} from "../lib/utils.js";
import { traceparentEnv } from "../lib/trace-context.js";

/** Structured-output retries per CLI invocation. See {@link structuredRetryEnv}. */
const STRUCTURED_OUTPUT_RETRIES = 2;
import { contextTokens } from "../lib/statusline.js";

export const METHODOLOGY = loadPrompt("development-methodology");

/**
 * Constructs the CLI args array for a Claude invocation. Exported for testing.
 *
 * The prompt is NOT an argument. Linux caps a single argv string at 128 KiB
 * (MAX_ARG_STRLEN), and a prompt with a few `context:` files inlined clears
 * that easily — the spawn then dies with `E2BIG` before the CLI even starts.
 * `--print` with no value makes the CLI read the prompt from stdin, which has
 * no such limit; `runClaude` writes it there.
 */
export function buildClaudeArgs(
  task: ClaudeTask,
  interactive = false,
): string[] {
  const permissionMode = task.permissionMode ?? "bypassPermissions";
  const model = resolveAgentModel(task);
  return [
    ...(interactive ? [] : ["--print"]),
    "--output-format",
    "stream-json",
    "--verbose",
    // allowedTools undefined → omit flag entirely (Claude defaults to all tools).
    // allowedTools []       → "--allowedTools none" (no tools).
    // allowedTools [...]    → restrict to the listed tools.
    ...(task.allowedTools !== undefined
      ? [
          "--allowedTools",
          task.allowedTools.length ? task.allowedTools.join(",") : "none",
        ]
      : []),
    "--permission-mode",
    permissionMode,
    ...(model ? ["--model", model] : []),
    ...(task.appendSystemPrompt
      ? ["--append-system-prompt", task.appendSystemPrompt]
      : []),
    ...(task.sessionId ? ["--session-id", task.sessionId] : []),
    ...(task.resume ? ["--resume", task.resume] : []),
    ...(task.mcpConfig ? ["--mcp-config", task.mcpConfig] : []),
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
 * Caps how many times the CLI re-asks the model for output its grammar will
 * accept, for structured calls only.
 *
 * The CLI's own default is five, and a call that dies with
 * `error_max_structured_output_retries` has paid for all five. Those attempts
 * are near-identical — the same answer rewritten after the same rejection —
 * so the fifth rarely succeeds where the second did not, and each one costs a
 * full generation. Since a failed structured call now has its answer salvaged
 * from the text it already emitted, the later retries mostly buy latency and
 * tokens. An explicit value in the environment always wins.
 */
export function structuredRetryEnv(
  task: Pick<ClaudeTask, "jsonSchema">,
): Record<string, string> {
  if (task.jsonSchema === undefined) return {};
  if (process.env["MAX_STRUCTURED_OUTPUT_RETRIES"] !== undefined) return {};
  return { MAX_STRUCTURED_OUTPUT_RETRIES: String(STRUCTURED_OUTPUT_RETRIES) };
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
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...traceparentEnv(),
        ...structuredRetryEnv(task),
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn claude (${claudeBin}): ${getErrorMessage(err)}`,
    );
  }
  writePrompt(proc, task.prompt);

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
  // Carried across messages so per-call context is reported once per API
  // call rather than once per content block.
  const parseState: ParseState = {};

  try {
    // Merge stdout and stderr into a single line stream, parse each JSON line.
    for await (const line of mergeStreamsToLines(proc.stdout!, proc.stderr!)) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as unknown;
        yield* parseClaudeMessage(msg, parseState);
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
    if (code !== 0)
      throw buildExitError(code, plainLines, parseState.resultError);
  } finally {
    timeout.cancel();
    process.off("SIGTERM", cleanup);
    process.off("SIGHUP", cleanup);
  }
}

// ----------------------------------------------------------------------------
// Claude stream-json message parsing
// ----------------------------------------------------------------------------

/**
 * Cross-message state for parseClaudeMessage. The CLI emits one `assistant`
 * event per content block — thinking, text, each tool_use — all carrying the
 * same message id and the same usage, so without this the same API call's
 * context would be reported several times over.
 */
interface ParseState {
  lastContextMessageId?: string;
  /**
   * Human-readable failure detail from an error `result` message. In
   * stream-json mode this is the only place the CLI explains a failure —
   * stderr stays silent — so runClaude folds it into the exit error.
   */
  resultError?: string;
}

function* parseClaudeMessage(
  msg: unknown,
  state: ParseState = {},
): Generator<Event> {
  if (!isObject(msg)) return;

  if (msg["type"] === "assistant") {
    // Per-call context occupancy. Unlike the result message's cumulative
    // usage, this is the number a context gauge can actually divide by a
    // window: it's what this one call sent to the model.
    const message = isObject(msg["message"]) ? msg["message"] : undefined;
    const id = message ? getString(message, "id") : undefined;
    if (message && id !== state.lastContextMessageId) {
      const usage = parseUsage(message["usage"]);
      if (usage) {
        state.lastContextMessageId = id;
        // index: -1 here — runWorkflow patches it to the real step index
        yield {
          type: "output:context",
          index: -1,
          tokens: contextTokens(usage),
        };
      }
    }
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
      // index: -1 here — runWorkflow patches it to the real step index
      yield { type: "output:cost", index: -1, usd: cost };
    }
    const usage = parseUsage(msg["usage"]);
    if (usage) {
      // index: -1 here — runWorkflow patches it to the real step index
      yield { type: "output:usage", index: -1, usage };
    }
    if (msg["structured_output"] != null) {
      yield { type: "output:structured", data: msg["structured_output"] };
    }
    const subtype = getString(msg, "subtype");
    if (msg["is_error"] === true || subtype?.startsWith("error")) {
      const detail =
        getString(msg, "result") ??
        getString(msg, "error") ??
        (isObject(msg["error"])
          ? getString(msg["error"], "message")
          : undefined) ??
        // `errors`, last, because only some refusals use it — and one of them
        // is the only account of WHY a schema-shaped answer failed. When
        // `--json-schema` exhausts its retries the CLI reports
        // `error_max_structured_output_retries` with every other field empty
        // and the reason (including the last validation failure) in here, so
        // reading the other three alone reduced a diagnosable failure to a
        // bare subtype and left the operator with nothing to act on.
        errorList(msg["errors"]);
      const resultError = [subtype, detail].filter(Boolean).join(": ");
      if (resultError) state.resultError = resultError;
    }
  } else if (msg["type"] === "rate_limit_event") {
    // The account's usage-limit state, forwarded so an orchestrator can act
    // before the run hard-stops with "usage limit reached". Pure relay:
    // nothing here pauses or switches anything.
    const rateLimit = parseRateLimit(msg["rate_limit_info"]);
    // index: -1 here — runWorkflow patches it to the real step index
    if (rateLimit) yield { type: "output:rate-limit", index: -1, ...rateLimit };
  }
}

/**
 * Reads the result message's `usage` object. Missing or malformed usage
 * (older CLI versions, mocked test output) yields undefined rather than
 * throwing — token reporting is best-effort, never load-bearing for a step's
 * success.
 */
function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!isObject(raw)) return undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    inputTokens: num(raw["input_tokens"]),
    outputTokens: num(raw["output_tokens"]),
    cacheCreationTokens: num(raw["cache_creation_input_tokens"]),
    cacheReadTokens: num(raw["cache_read_input_tokens"]),
  };
}

const RATE_LIMIT_STATUSES: readonly RateLimitStatus[] = [
  "allowed",
  "allowed_warning",
  "rejected",
];

/**
 * Reads a `rate_limit_event`'s `rate_limit_info` object. Anything other than
 * a known `status` yields undefined rather than throwing — the CLI adds
 * statuses over time, and a limit report is never load-bearing for a step.
 * Optional fields are copied only when well-typed, and a window only when it
 * carries both numbers; unknown window keys are dropped.
 */
function parseRateLimit(
  raw: unknown,
): Omit<OutputRateLimitEvent, "type" | "index"> | undefined {
  if (!isObject(raw)) return undefined;
  const status = RATE_LIMIT_STATUSES.find((s) => s === raw["status"]);
  if (!status) return undefined;
  const resetsAt = getFiniteNumber(raw, "resetsAt");
  const rateLimitType = getString(raw, "rateLimitType");
  const utilization = getFiniteNumber(raw, "utilization");
  const unified = isObject(raw["unifiedWindows"]) ? raw["unifiedWindows"] : {};
  const windows = Object.fromEntries(
    (["five_hour", "seven_day"] as const).flatMap((key) => {
      const window = parseRateLimitWindow(unified[key]);
      return window ? [[key, window]] : [];
    }),
  );
  return {
    status,
    ...(resetsAt !== undefined && { resetsAt }),
    ...(rateLimitType !== undefined && { rateLimitType }),
    ...(utilization !== undefined && { utilization }),
    ...(Object.keys(windows).length > 0 && { windows }),
  };
}

function parseRateLimitWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isObject(raw)) return undefined;
  const utilization = getFiniteNumber(raw, "utilization");
  const resetsAt = getFiniteNumber(raw, "resetsAt");
  return utilization !== undefined && resetsAt !== undefined
    ? { utilization, resetsAt }
    : undefined;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

export function buildExitError(
  code: number,
  plainLines: string[],
  resultError?: string,
): Error {
  const parts = [...(resultError ? [resultError] : []), ...plainLines];
  const detail = parts.length > 0 ? `\n${parts.join("\n")}` : "";
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

/**
 * The strings out of a result message's `errors` array, joined.
 *
 * Tolerant of the array holding non-strings, or of `errors` not being an array
 * at all: this runs on output from a CLI whose shape is not ours, at the exact
 * moment that CLI has already failed, so anything unreadable here has to
 * degrade to "no detail" rather than throw over a failure it is only trying to
 * describe.
 */
function errorList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter(
    (v): v is string => typeof v === "string" && v !== "",
  );
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function getString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function getFiniteNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Strips JSON Schema metadata the CLI has no use for.
 *
 * zod-to-json-schema stamps a `$schema` dialect URL on everything it emits.
 * It describes the document rather than the shape being asked for, it is not
 * one of the keywords structured output honours, and it rides along on every
 * structured call — so it is dropped before the schema goes over the wire.
 */
export function toAgentJsonSchema(
  schema: ZodType<unknown>,
): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = zodToJsonSchema(schema) as Record<
    string,
    unknown
  >;
  return rest;
}

/**
 * Runs a Claude task and returns a schema-validated typed result.
 * Passes the Zod schema as --json-schema so the CLI enforces structure.
 *
 * The flag is the reliable path and stays the primary one — but it can fail,
 * and when it does the CLI exits non-zero and `runClaude` throws. The most
 * common way is `error_max_structured_output_retries`: the model wrote an
 * answer, the grammar rejected it, and after the CLI's own retry budget ran
 * out the whole call died. Every one of those attempts is sitting in the text
 * we already collected, and the prompt asked for the same object the schema
 * describes, so the attempts are searched for a valid one before the error is
 * allowed to propagate. A grader that answered correctly five times in a row
 * should not read as a grader that never answered.
 *
 * Text parsing also covers environments with no --json-schema support at all
 * (mock CLIs in tests, older builds), which is why it runs on the clean path too.
 */
export async function runClaudeStructured<T>(
  task: Omit<ClaudeTask, "jsonSchema">,
  schema: ZodType<T>,
  onEvent?: (event: Event) => void,
): Promise<T> {
  const jsonSchema = toAgentJsonSchema(schema);
  let structuredOutput: unknown;
  const lines: string[] = [];
  let runError: unknown;

  try {
    for await (const event of runClaude({ ...task, jsonSchema })) {
      onEvent?.(event);
      if (event.type === "output:structured") structuredOutput = event.data;
      else if (event.type === "output:text") lines.push(event.text);
    }
  } catch (err) {
    runError = err;
  }

  if (structuredOutput !== undefined) return schema.parse(structuredOutput);

  const salvaged = salvageStructured(lines.join(""), schema);
  if (salvaged !== undefined) {
    if (process.env["NODE_ENV"] !== "test") {
      console.warn(
        `[executant] runClaudeStructured: recovered "${task.name}" from text output` +
          (runError === undefined
            ? " — no output:structured event"
            : ` after the CLI failed (${getErrorMessage(runError)})`),
      );
    }
    return salvaged;
  }

  // Nothing usable. A non-zero exit is the more informative failure — it
  // carries the CLI's own reason — so it wins over a parse error about text
  // that was never going to be a verdict.
  if (runError !== undefined) throw runError;
  return schema.parse(JSON.parse(extractJsonObject(lines.join("").trim())));
}
