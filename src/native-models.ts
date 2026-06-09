#!/usr/bin/env tsx
// Downloads GGUF model files to ~/llms/ using native curl.
// No Docker required. Run via: npm run models:download

import { spawnSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { MODELS, MODELS_DIR } from "./lib/model-config.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function hasCli(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasCli("curl")) {
  console.error(`${RED}✗${RESET}  curl not found — required for downloads`);
  process.exit(1);
}

mkdirSync(MODELS_DIR, { recursive: true });
console.log(`${BOLD}Checking GGUF model files in ${MODELS_DIR}${RESET}\n`);

let issues = 0;

for (const model of MODELS) {
  const dest = join(MODELS_DIR, model.file);
  if (existsSync(dest)) {
    console.log(`${GREEN}✓${RESET}  ${model.name}  (${model.file})`);
    continue;
  }

  console.log(`\n${YELLOW}↓${RESET}  ${model.name}  ${model.size}`);
  console.log(`   → ${dest}`);

  const tmp = `${dest}.tmp`;
  const result = spawnSync("curl", ["-L", "-#", "-o", tmp, model.url], {
    stdio: "inherit",
  });

  if (result.status === 0) {
    renameSync(tmp, dest);
    console.log(`${GREEN}✓${RESET}  ${model.name}  downloaded`);
  } else {
    console.log(`${RED}✗${RESET}  ${model.name}  download failed`);
    issues++;
  }
}

console.log();

if (issues === 0) {
  console.log(`${GREEN}${BOLD}All models ready.${RESET}`);
  console.log();
  console.log("Next — start the inference servers:");
  console.log("  npm run models:start");
} else {
  console.error(
    `${RED}${BOLD}${issues} download(s) failed.${RESET}  Re-run: npm run models:download`,
  );
  process.exit(1);
}
