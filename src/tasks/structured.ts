// ============================================================================
// STRUCTURED OUTPUT — SHARED ACROSS PROVIDERS
// ============================================================================
// Every provider ends a structured call the same way: it has some raw text the
// agent emitted, and it needs one schema-valid object out of it. Claude gets a
// validated object handed to it by --json-schema and only falls back to this;
// OpenCode has no equivalent flag and lives here always. Keeping the recovery
// in one place is what lets a provider be swapped out without each one
// inventing its own idea of how forgiving to be.

import type { ZodType } from "zod";

/**
 * Every balanced top-level `{…}` span in `text`, in the order they appear.
 *
 * Deliberately not a regex and deliberately not "the outermost braces": when a
 * structured call fails its schema, the output holds *several* rejected
 * attempts back to back, and the span from the first `{` to the last `}` is
 * the one thing guaranteed not to parse. Quotes and escapes are tracked so a
 * brace inside a string literal — `{"feedback": "use {{VAR}} here"}` — does not
 * end the object early.
 */
export function findJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Pulls the best schema-valid object out of an agent's raw text, or undefined
 * when there isn't one.
 *
 * Candidates are tried newest-first because the text of a failed structured
 * call is a series of attempts at the *same* object, each one written after
 * seeing why the last was rejected — the final attempt is the model's best
 * answer, and the first is the one it already knows is wrong.
 *
 * A candidate that fails validation gets one second chance unwrapped: agents
 * intermittently nest the whole answer under a single key (`{"output": {…}}`)
 * instead of returning it at the root, which is a packaging mistake rather
 * than a wrong answer, and throwing away a correct verdict over it helps
 * nobody.
 */
export function salvageStructured<T>(
  text: string,
  schema: ZodType<T>,
): T | undefined {
  const candidates = findJsonObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    let value: unknown;
    try {
      value = JSON.parse(candidates[i]!);
    } catch {
      continue;
    }
    const direct = schema.safeParse(value);
    if (direct.success) return direct.data;

    const unwrapped = unwrapSingleKey(value);
    if (unwrapped !== undefined) {
      const nested = schema.safeParse(unwrapped);
      if (nested.success) return nested.data;
    }
  }
  return undefined;
}

/** The sole value of a one-key object wrapper, when that value is itself an object. */
function unwrapSingleKey(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return undefined;
  const inner = (value as Record<string, unknown>)[keys[0]!];
  return typeof inner === "object" && inner !== null && !Array.isArray(inner)
    ? inner
    : undefined;
}
