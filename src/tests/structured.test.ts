// ============================================================================
// STRUCTURED OUTPUT SALVAGE — unit tests
// ============================================================================
// Tests for src/tasks/structured.ts: findJsonObjects, salvageStructured, and
// the schema sanitising in toAgentJsonSchema. The case that matters most is a
// failed --json-schema call, whose output is several rejected attempts at the
// same object back to back.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";

import { findJsonObjects, salvageStructured } from "../tasks/structured.js";
import { toAgentJsonSchema } from "../tasks/claude.js";

const Verdict = z.object({
  pass: z.boolean(),
  reasoning: z.string().optional(),
  feedback: z.string(),
});

describe("findJsonObjects", () => {
  test("finds a lone object", () => {
    assert.deepEqual(findJsonObjects('{"a":1}'), ['{"a":1}']);
  });

  test("finds each of several sibling objects in order", () => {
    assert.deepEqual(findJsonObjects('{"a":1} noise {"b":2}'), [
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  test("keeps a nested object whole rather than splitting it", () => {
    assert.deepEqual(findJsonObjects('{"a":{"b":2}}'), ['{"a":{"b":2}}']);
  });

  test("ignores braces inside string literals", () => {
    const text = '{"feedback":"use {{VAR}} here"}';
    assert.deepEqual(findJsonObjects(text), [text]);
  });

  test("ignores an escaped quote inside a string", () => {
    const text = '{"feedback":"he said \\"no\\" firmly"}';
    assert.deepEqual(findJsonObjects(text), [text]);
  });

  test("returns nothing for text with no object", () => {
    assert.deepEqual(findJsonObjects("no json here at all"), []);
  });

  test("ignores an unterminated object", () => {
    assert.deepEqual(findJsonObjects('{"a":1'), []);
  });

  test("ignores a stray closing brace", () => {
    assert.deepEqual(findJsonObjects('} {"a":1}'), ['{"a":1}']);
  });
});

describe("salvageStructured", () => {
  test("recovers a verdict from prose surrounding it", () => {
    const out = salvageStructured(
      'Here is my assessment:\n{"pass":true,"feedback":"looks right"}\nDone.',
      Verdict,
    );
    assert.deepEqual(out, { pass: true, feedback: "looks right" });
  });

  test("recovers from a markdown-fenced object", () => {
    const out = salvageStructured(
      '```json\n{"pass":false,"feedback":"missing tests"}\n```',
      Verdict,
    );
    assert.deepEqual(out, { pass: false, feedback: "missing tests" });
  });

  test("takes the LAST valid attempt when several are present", () => {
    // This is the shape of a failed structured call: each attempt was written
    // after seeing why the previous one was rejected, so the final one is the
    // model's best answer.
    const attempts = [
      '{"pass":true}',
      '{"pass":true,"feedback":"first try"}',
      '{"pass":false,"feedback":"final answer"}',
    ].join("\n");
    const out = salvageStructured(attempts, Verdict);
    assert.deepEqual(out, { pass: false, feedback: "final answer" });
  });

  test("skips a syntactically broken attempt to reach a valid earlier one", () => {
    const text = '{"pass":true,"feedback":"good"}\n{"pass":false,,}';
    assert.deepEqual(salvageStructured(text, Verdict), {
      pass: true,
      feedback: "good",
    });
  });

  test("skips a well-formed attempt that fails the schema", () => {
    const text = '{"pass":true,"feedback":"good"}\n{"verdict":"maybe"}';
    assert.deepEqual(salvageStructured(text, Verdict), {
      pass: true,
      feedback: "good",
    });
  });

  test("accepts an answer wrapped under a single key", () => {
    const out = salvageStructured(
      '{"output":{"pass":true,"feedback":"wrapped but correct"}}',
      Verdict,
    );
    assert.deepEqual(out, { pass: true, feedback: "wrapped but correct" });
  });

  test("does not unwrap a two-key object", () => {
    const text = '{"output":{"pass":true,"feedback":"x"},"extra":1}';
    assert.equal(salvageStructured(text, Verdict), undefined);
  });

  test("returns undefined when nothing validates", () => {
    assert.equal(salvageStructured('{"nope":1}', Verdict), undefined);
  });

  test("returns undefined for output with no JSON at all", () => {
    assert.equal(
      salvageStructured("I could not evaluate this step.", Verdict),
      undefined,
    );
  });

  test("strips unknown keys the way the schema says to", () => {
    const out = salvageStructured(
      '{"pass":true,"feedback":"ok","chatter":"ignored"}',
      Verdict,
    );
    assert.deepEqual(out, { pass: true, feedback: "ok" });
  });
});

describe("toAgentJsonSchema", () => {
  test("drops the $schema dialect key", () => {
    const schema = toAgentJsonSchema(Verdict);
    assert.equal("$schema" in schema, false);
  });

  test("keeps the shape the CLI actually needs", () => {
    const schema = toAgentJsonSchema(Verdict);
    assert.equal(schema["type"], "object");
    assert.equal(schema["additionalProperties"], false);
    assert.deepEqual(schema["required"], ["pass", "feedback"]);
    assert.deepEqual(Object.keys(schema["properties"] as object), [
      "pass",
      "reasoning",
      "feedback",
    ]);
  });
});
