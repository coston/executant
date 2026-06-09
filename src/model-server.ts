#!/usr/bin/env tsx
// Manages native llama-server processes with Apple Silicon Metal GPU acceleration.
// Run via: npm run models:start | models:stop | models:status
//
// llama-server binds to 0.0.0.0 so the Docker dev container can reach it via
// the host.docker.internal (or via extra_hosts: localhost:host-gateway).
// The -ngl 999 flag routes all transformer layers to Metal GPU.

import { spawn, execSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  MODELS,
  MODELS_DIR,
  PIDS_DIR,
  type ModelConfig,
} from "./lib/model-config.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function hasCli(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isServerHealthy(port: number): boolean {
  try {
    execSync(`curl -sf http://localhost:${port}/health`, {
      stdio: "ignore",
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

function pidFile(key: string): string {
  return join(PIDS_DIR, `${key}.pid`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(key: string): number | null {
  const file = pidFile(key);
  if (!existsSync(file)) return null;
  const n = parseInt(readFileSync(file, "utf8").trim(), 10);
  return isNaN(n) ? null : n;
}

function startServer(model: ModelConfig): void {
  const modelPath = join(MODELS_DIR, model.file);
  if (!existsSync(modelPath)) {
    console.log(
      `${RED}✗${RESET}  ${model.name}: model not found at ${modelPath}`,
    );
    console.log(`   Run: npm run models:download`);
    return;
  }

  const existingPid = readPid(model.key);
  if (existingPid !== null && isRunning(existingPid)) {
    console.log(
      `${GREEN}✓${RESET}  ${model.name}: already running (PID ${existingPid}) on :${model.port}`,
    );
    return;
  }

  mkdirSync(PIDS_DIR, { recursive: true });

  const child = spawn(
    "llama-server",
    [
      "--model",
      modelPath,
      "--port",
      String(model.port),
      "--host",
      "0.0.0.0",
      "--ctx-size",
      "32768",
      "-ngl",
      "999",
      "--no-webui",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  writeFileSync(pidFile(model.key), String(child.pid));
  console.log(
    `${YELLOW}↑${RESET}  ${model.name}: started (PID ${child.pid}) on :${model.port}`,
  );
}

function stopServer(model: ModelConfig): void {
  const pid = readPid(model.key);
  if (pid === null) {
    console.log(`   ${model.name}: not running`);
    return;
  }
  if (!isRunning(pid)) {
    console.log(`   ${model.name}: not running (stale PID ${pid})`);
    const pf = pidFile(model.key);
    if (existsSync(pf)) unlinkSync(pf);
    return;
  }
  process.kill(pid);
  console.log(`${YELLOW}↓${RESET}  ${model.name}: stopped (PID ${pid})`);
}

function printStatus(model: ModelConfig): void {
  const pid = readPid(model.key);
  const alive = pid !== null && isRunning(pid);
  const healthy = alive && isServerHealthy(model.port);

  if (healthy) {
    console.log(
      `${GREEN}✓${RESET}  ${model.name}: running (PID ${pid}) on :${model.port}`,
    );
  } else if (alive) {
    console.log(
      `${YELLOW}~${RESET}  ${model.name}: starting (PID ${pid}), :${model.port} not yet ready`,
    );
  } else {
    console.log(`${RED}✗${RESET}  ${model.name}: not running`);
  }
}

// CLI entry point — only runs when executed directly, not when imported
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];

  switch (command) {
    case "start":
      if (!hasCli("llama-server")) {
        const hint =
          process.platform === "darwin"
            ? "brew install llama.cpp"
            : "build from source: https://github.com/ggml-org/llama.cpp";
        console.error(`${RED}✗${RESET}  llama-server not found — ${hint}`);
        process.exit(1);
      }
      MODELS.forEach(startServer);
      console.log();
      console.log(
        "Model servers loading in the background (~30 sec to warm up).",
      );
      console.log("Check status: npm run models:status");
      break;

    case "stop":
      MODELS.forEach(stopServer);
      break;

    case "status":
      MODELS.forEach(printStatus);
      break;

    default:
      console.error("Usage: tsx src/model-server.ts <start|stop|status>");
      process.exit(1);
  }
}
