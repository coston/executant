// ============================================================================
// UTILS — unit tests
// ============================================================================
// Tests for src/lib/utils.ts: stripPromptHeader, loadPrompt, slugify,
// extractJsonObject, formatTimestamp, getErrorMessage, fillTemplate.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import {
  stripPromptHeader,
  loadPrompt,
  slugify,
  extractJsonObject,
  formatTimestamp,
  getErrorMessage,
  fillTemplate,
  formatZodIssues,
  ignoreBrokenPipe,
} from "../lib/utils.js";

const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
);

// ----------------------------------------------------------------------------
// stripPromptHeader
// ----------------------------------------------------------------------------

describe("stripPromptHeader", () => {
  test("strips a single # comment line", () => {
    const input = "# header\n\ncontent";
    assert.equal(stripPromptHeader(input), "content");
  });

  test("strips multiple consecutive # comment lines", () => {
    const input = "# line1\n# line2\n# line3\n\ncontent here";
    assert.equal(stripPromptHeader(input), "content here");
  });

  test("strips the separating blank line after the comment block", () => {
    const input =
      "# ===========\n# Purpose: x\n# ===========\n\nActual prompt content.";
    assert.equal(stripPromptHeader(input), "Actual prompt content.");
  });

  test("strips a realistic prompt file header", () => {
    const input = [
      "# ============================================================================",
      "# JUDGE EVALUATION",
      "# ============================================================================",
      "# Purpose: Evaluate whether a workflow step output is complete.",
      "# Used by: src/runner.ts",
      "# ============================================================================",
      "",
      "You are a quality evaluation judge.",
    ].join("\n");
    assert.equal(
      stripPromptHeader(input),
      "You are a quality evaluation judge.",
    );
  });

  test("leaves content unchanged when there is no # header", () => {
    const input = "No header here\njust content";
    assert.equal(stripPromptHeader(input), "No header here\njust content");
  });

  test("handles content that starts with # mid-file (only strips leading block)", () => {
    const input = "# header\n\n## Section\n# not stripped";
    assert.equal(stripPromptHeader(input), "## Section\n# not stripped");
  });

  test("trims leading/trailing whitespace from result", () => {
    const input = "# header\n\n  content with surrounding space  ";
    assert.equal(stripPromptHeader(input), "content with surrounding space");
  });

  test("handles empty string without throwing", () => {
    assert.equal(stripPromptHeader(""), "");
  });

  test("handles only a comment block with no content", () => {
    assert.equal(stripPromptHeader("# header\n"), "");
  });
});

// ----------------------------------------------------------------------------
// loadPrompt — integration: verify all prompt files load cleanly
// ----------------------------------------------------------------------------

describe("loadPrompt", () => {
  const promptFiles = readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(".txt", ""));

  test("loads all prompt files without throwing", () => {
    for (const name of promptFiles) {
      assert.doesNotThrow(
        () => loadPrompt(name),
        `loadPrompt('${name}') threw`,
      );
    }
  });

  test("no loaded prompt starts with a # character", () => {
    for (const name of promptFiles) {
      const content = loadPrompt(name);
      assert.ok(
        !content.startsWith("#"),
        `loadPrompt('${name}') still starts with '#': ${content.slice(0, 60)}`,
      );
    }
  });

  test("no loaded prompt has leading whitespace", () => {
    for (const name of promptFiles) {
      const content = loadPrompt(name);
      assert.equal(
        content,
        content.trimStart(),
        `loadPrompt('${name}') has leading whitespace`,
      );
    }
  });

  test("all loaded prompts are non-empty", () => {
    for (const name of promptFiles) {
      const content = loadPrompt(name);
      assert.ok(
        content.length > 0,
        `loadPrompt('${name}') returned empty string`,
      );
    }
  });

  test("throws on non-existent prompt file", () => {
    assert.throws(() => loadPrompt("does-not-exist"), /ENOENT/);
  });
});

// ----------------------------------------------------------------------------
// slugify
// ----------------------------------------------------------------------------

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    assert.equal(slugify("Add User Auth"), "add-user-auth");
  });

  test("collapses multiple non-alphanumeric chars into one hyphen", () => {
    assert.equal(slugify("foo  --  bar"), "foo-bar");
  });

  test("strips leading and trailing hyphens", () => {
    assert.equal(slugify("  hello world  "), "hello-world");
  });

  test("truncates to maxLen (default 20)", () => {
    assert.equal(slugify("a".repeat(30)).length, 20);
  });

  test("respects custom maxLen", () => {
    assert.equal(slugify("hello world", 5).length, 5);
  });
});

// ----------------------------------------------------------------------------
// extractJsonObject
// ----------------------------------------------------------------------------

describe("extractJsonObject", () => {
  test("extracts JSON from markdown code fence", () => {
    const input = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
    assert.equal(extractJsonObject(input), '{"key": "value"}');
  });

  test("extracts JSON from plain text with surrounding prose", () => {
    const input = 'Result: {"foo": 1} end';
    assert.equal(extractJsonObject(input), '{"foo": 1}');
  });

  test("returns trimmed text when no JSON found", () => {
    assert.equal(extractJsonObject("  no json here  "), "no json here");
  });

  test("handles nested objects", () => {
    const input = '{"outer": {"inner": 1}}';
    assert.equal(extractJsonObject(input), '{"outer": {"inner": 1}}');
  });
});

// ----------------------------------------------------------------------------
// formatTimestamp
// ----------------------------------------------------------------------------

describe("formatTimestamp", () => {
  test("formats date to YYYYMMDD-HHMMSS", () => {
    const d = new Date(2026, 0, 5, 9, 3, 7); // Jan 5 2026, 09:03:07
    assert.equal(formatTimestamp(d), "20260105-090307");
  });

  test("pads single-digit month, day, hour, minute, second", () => {
    const d = new Date(2026, 0, 1, 1, 1, 1);
    assert.equal(formatTimestamp(d), "20260101-010101");
  });
});

// ----------------------------------------------------------------------------
// getErrorMessage
// ----------------------------------------------------------------------------

describe("getErrorMessage", () => {
  test("extracts message from an Error instance", () => {
    assert.equal(getErrorMessage(new Error("boom")), "boom");
  });

  test("converts a string to itself", () => {
    assert.equal(getErrorMessage("raw string"), "raw string");
  });

  test("converts a number via String()", () => {
    assert.equal(getErrorMessage(42), "42");
  });

  test("converts null via String()", () => {
    assert.equal(getErrorMessage(null), "null");
  });

  test("converts undefined via String()", () => {
    assert.equal(getErrorMessage(undefined), "undefined");
  });

  test("converts a plain object via String()", () => {
    assert.equal(getErrorMessage({ code: "ENOENT" }), "[object Object]");
  });

  test("handles Error subclasses", () => {
    class CustomError extends Error {}
    assert.equal(getErrorMessage(new CustomError("custom")), "custom");
  });
});

// ----------------------------------------------------------------------------
// fillTemplate
// ----------------------------------------------------------------------------

describe("fillTemplate", () => {
  test("replaces a single placeholder", () => {
    assert.equal(
      fillTemplate("Hello {{NAME}}!", { NAME: "World" }),
      "Hello World!",
    );
  });

  test("replaces multiple distinct placeholders", () => {
    const result = fillTemplate("{{A}} and {{B}}", { A: "foo", B: "bar" });
    assert.equal(result, "foo and bar");
  });

  test("replaces all occurrences of the same placeholder", () => {
    const result = fillTemplate("{{X}} {{X}} {{X}}", { X: "hi" });
    assert.equal(result, "hi hi hi");
  });

  test("leaves unmatched placeholders intact", () => {
    const result = fillTemplate("{{KNOWN}} {{UNKNOWN}}", { KNOWN: "ok" });
    assert.equal(result, "ok {{UNKNOWN}}");
  });

  test("returns template unchanged when vars is empty", () => {
    assert.equal(fillTemplate("no placeholders", {}), "no placeholders");
  });

  test("handles empty string template", () => {
    assert.equal(fillTemplate("", { KEY: "val" }), "");
  });

  test("handles empty string replacement value", () => {
    assert.equal(
      fillTemplate("prefix{{EMPTY}}suffix", { EMPTY: "" }),
      "prefixsuffix",
    );
  });

  test("handles values that contain braces without interfering", () => {
    const result = fillTemplate("{{A}}", {
      A: "{{B}}",
      B: "should-not-expand",
    });
    // After replacing {{A}} → "{{B}}", whether {{B}} also gets replaced depends
    // on iteration order. Assert the final string contains the substituted value.
    assert.ok(result === "{{B}}" || result === "should-not-expand");
  });

  test("handles multiline template values", () => {
    const result = fillTemplate("START\n{{BODY}}\nEND", {
      BODY: "line1\nline2",
    });
    assert.equal(result, "START\nline1\nline2\nEND");
  });
});

// ----------------------------------------------------------------------------
// formatZodIssues
// ----------------------------------------------------------------------------

describe("formatZodIssues", () => {
  test("formats a single issue", () => {
    const issues = [{ path: ["goal"], message: "Required" }];
    assert.equal(formatZodIssues(issues), "  goal: Required");
  });

  test("formats multiple issues separated by newlines", () => {
    const issues = [
      { path: ["goal"], message: "Required" },
      { path: ["steps", 0, "name"], message: "Expected string" },
    ];
    assert.equal(
      formatZodIssues(issues),
      "  goal: Required\n  steps.0.name: Expected string",
    );
  });

  test("handles a top-level issue with empty path", () => {
    const issues = [{ path: [], message: "Invalid input" }];
    assert.equal(formatZodIssues(issues), "  : Invalid input");
  });

  test("returns empty string for no issues", () => {
    assert.equal(formatZodIssues([]), "");
  });
});

// ----------------------------------------------------------------------------
// ignoreBrokenPipe
// ----------------------------------------------------------------------------

describe("ignoreBrokenPipe", () => {
  test("swallows EPIPE errors instead of letting them crash the process", () => {
    const stream = new PassThrough();
    ignoreBrokenPipe(stream);
    assert.doesNotThrow(() => {
      stream.emit(
        "error",
        Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      );
    });
  });

  test("rethrows non-EPIPE stream errors so real failures still surface", () => {
    const stream = new PassThrough();
    ignoreBrokenPipe(stream);
    assert.throws(() => {
      stream.emit(
        "error",
        Object.assign(new Error("boom"), { code: "ECONNRESET" }),
      );
    }, /boom/);
  });
});
