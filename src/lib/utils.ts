import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// In dev: __dir = src/lib  → prompts are at src/prompts  (go up one)
// Bundled: __dir = dist     → prompts are at dist/prompts (stay)
const __dir = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR =
  basename(__dir) === "lib"
    ? join(__dir, "..", "prompts")
    : join(__dir, "prompts");

/**
 * Default Claude model for all steps. Uses the "sonnet" alias so it
 * automatically resolves to the latest Sonnet when the CLI is updated.
 */
export const DEFAULT_MODEL = "sonnet";

/** Strips the leading `# comment block` documentation header from a prompt file. */
export function stripPromptHeader(raw: string): string {
  return raw.replace(/^(#[^\n]*\n)+\n?/, "").trim();
}

/** Loads a prompt by name from the prompts directory, stripping its doc header. */
export function loadPrompt(name: string): string {
  return stripPromptHeader(
    readFileSync(join(PROMPTS_DIR, `${name}.txt`), "utf8"),
  );
}

function findOutermostBraces(
  text: string,
): { start: number; end: number } | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return { start, end: i };
  }
  return null;
}

/**
 * Extracts the first complete JSON object from text that may contain leading
 * prose, trailing prose, or markdown code fences.
 */
export function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const bounds = findOutermostBraces(text);
  return bounds ? text.slice(bounds.start, bounds.end + 1) : text.trim();
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return Object.entries(vars).reduce(
    (acc, [key, val]) => acc.replaceAll(`{{${key}}}`, val),
    template,
  );
}

export function formatZodIssues(
  issues: Array<{ path: Array<string | number>; message: string }>,
): string {
  return issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
}

export function slugify(text: string, maxLen = 20): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}

export function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function timestamp(): string {
  return formatTimestamp(new Date());
}

// Matches ANSI CSI sequences (including ?-prefixed like cursor-hide ESC[?25l),
// OSC sequences (ESC]...\x07), and bare carriage returns.
const ANSI_RE = /\x1B(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07)|[\r]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const TOOL_ARG: Record<string, (i: Record<string, unknown>) => string> = {
  Read: (i) => String(i["file_path"] ?? i["path"] ?? ""),
  Edit: (i) => String(i["file_path"] ?? ""),
  Write: (i) => String(i["file_path"] ?? ""),
  Bash: (i) => String(i["command"] ?? ""),
  Glob: (i) => String(i["pattern"] ?? ""),
  Grep: (i) => String(i["pattern"] ?? ""),
};

/** Returns the key argument for a tool call (e.g. file path, command). Used for log lines. */
export function getToolArg(
  tool: string,
  input: Record<string, unknown>,
): string {
  const fn = TOOL_ARG[tool];
  return fn ? fn(input) : JSON.stringify(input);
}

/** Returns "Tool(arg)" form for tool call summaries and fix histories. */
export function formatToolCall(
  tool: string,
  input: Record<string, unknown>,
): string {
  const fn = TOOL_ARG[tool];
  return fn ? `${tool}(${fn(input)})` : JSON.stringify({ tool, ...input });
}

export function normalizeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Silences EPIPE errors on a writable stream. Node treats a write to a
 * closed pipe as an unhandled 'error' event — a fatal, uncaught exception —
 * unless something is listening. Ink's TUI writes to stdout on every render
 * tick for the life of a run, so a long session that outlives its terminal's
 * pipe (a VS Code integrated terminal recycling its pty on reconnect/reload,
 * or output piped into a command that exits early) crashes the whole
 * process on the next tick. Swallowing EPIPE lets the run continue instead;
 * any other error is rethrown so real stream failures still surface.
 */
export function ignoreBrokenPipe(stream: NodeJS.WritableStream): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}
