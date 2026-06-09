import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODELS, MODELS_DIR } from "../lib/model-config.js";
import { isServerHealthy } from "../model-server.js";

function hasCli(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── claude ───────────────────────────────────────────────────────────────────

const claudeInstalled = hasCli("claude");

describe("claude dependency", { skip: !claudeInstalled }, () => {
  test("claude CLI is on PATH", () => {
    assert.ok(
      claudeInstalled,
      "claude not found — install: npm install -g @anthropic-ai/claude-code",
    );
  });
});

// ── local model inference (skipped when dev tools not present) ───────────────

const llamaInstalled = hasCli("llama-server");
const modelsPresent = existsSync(MODELS_DIR);

describe("llama-server binary", { skip: !llamaInstalled }, () => {
  test("llama-server is on PATH", () => {
    assert.ok(hasCli("llama-server"), "brew install llama.cpp");
  });
});

describe("GGUF model files", { skip: !modelsPresent }, () => {
  for (const model of MODELS) {
    const label = model.file.replace("-Instruct-Q4_K_M.gguf", "");
    test(`${label} exists`, () => {
      assert.ok(
        existsSync(join(MODELS_DIR, model.file)),
        `${model.file} not found — npm run models:download`,
      );
    });
  }
});

describe("llama-server ports", () => {
  for (const model of MODELS) {
    test(
      `${model.key} :${model.port}`,
      { skip: !isServerHealthy(model.port) },
      () => {
        assert.ok(
          isServerHealthy(model.port),
          `not running — npm run models:start`,
        );
      },
    );
  }
});
