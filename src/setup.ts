#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODELS, MODELS_DIR } from "./lib/model-config.js";
import { isServerHealthy } from "./model-server.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function checkCli(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

let issues = 0;

// ── required: coding-agent CLI ───────────────────────────────────────────────
console.log(`${BOLD}Required:${RESET}`);

const claudePath = checkCli("claude");
const opencodePath = checkCli("opencode");

if (claudePath) {
  console.log(`${GREEN}✓${RESET}  claude    ${claudePath}`);
} else {
  console.log(`${RED}✗${RESET}  claude    not found`);
  console.log(
    `   ${YELLOW}Install: npm install -g @anthropic-ai/claude-code${RESET}`,
  );
  issues++;
}

if (opencodePath) {
  console.log(`${GREEN}✓${RESET}  opencode  ${opencodePath}`);
} else {
  console.log(`   opencode  not found (optional — needed for local models)`);
}

// ── optional: local model inference (dev evals only) ─────────────────────────
console.log();
console.log(
  `${BOLD}Local model inference (optional — dev evals only):${RESET}`,
);

const llamaPath = checkCli("llama-server");
if (llamaPath) {
  console.log(`${GREEN}✓${RESET}  llama-server  ${llamaPath}`);
} else {
  const hint =
    process.platform === "darwin"
      ? "brew install llama.cpp"
      : "build from source: https://github.com/ggml-org/llama.cpp";
  console.log(`   llama-server  not found  (${hint})`);
}

const anyModelPresent = MODELS.some((m) =>
  existsSync(join(MODELS_DIR, m.file)),
);
if (anyModelPresent) {
  for (const model of MODELS) {
    const present = existsSync(join(MODELS_DIR, model.file));
    const label = model.file.replace("-Instruct-Q4_K_M.gguf", "");
    console.log(`${present ? GREEN + "✓" : " "}${RESET}  ${label}`);
  }
} else {
  console.log(`   No models in ${MODELS_DIR}`);
  console.log(`   ${YELLOW}Download: npm run models:download${RESET}`);
}

for (const model of MODELS) {
  if (isServerHealthy(model.port)) {
    console.log(`${GREEN}✓${RESET}  ${model.key}  :${model.port}`);
  } else {
    console.log(`   ${model.key}  not running on :${model.port}`);
  }
}

console.log();

if (issues === 0) {
  console.log(`${GREEN}${BOLD}Ready.${RESET}`);
} else {
  console.log(
    `${RED}${BOLD}${issues} issue${issues > 1 ? "s" : ""} found.${RESET} Fix the above, then re-run: npm run setup`,
  );
}

process.exit(issues > 0 ? 1 : 0);
