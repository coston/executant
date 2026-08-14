// ============================================================================
// STATUSLINE
// ============================================================================
// Best-effort integration with Claude Code's `statusLine` setting
// (https://docs.claude.com — a `.claude/settings.json` key naming a shell
// command that receives session JSON on stdin and prints one line to show in
// a status bar). Executant is not an interactive Claude Code session, so it
// synthesizes an approximation of that payload and renders whatever the
// command prints alongside its own TUI footer.
//
// Every function here is best-effort and never throws: a missing command, a
// malformed settings file, or a failing/slow script should silently mean no
// statusline, never a broken run. Disable entirely with EXECUTANT_STATUSLINE=0.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { stripAnsi } from "./utils.js";
import { CURRENT_VERSION } from "../version.js";
import type { Workflow } from "../types.js";

const SettingsSchema = z
  .object({
    statusLine: z
      .object({ command: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();

function readStatusLineCommand(settingsPath: string): string | undefined {
  try {
    if (!existsSync(settingsPath)) return undefined;
    const parsed = SettingsSchema.safeParse(
      JSON.parse(readFileSync(settingsPath, "utf8")),
    );
    return parsed.success ? parsed.data.statusLine?.command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds the `statusLine.command` from the nearest `.claude/settings.local.json`
 * or `.claude/settings.json` walking up from `cwd`, falling back to the same
 * files under the user's home directory. Mirrors Claude Code's own
 * project-then-user settings precedence; local overrides shared at each level.
 */
export function findStatusLineCommand(
  cwd: string,
  home: string = homedir(),
): string | undefined {
  let dir = cwd;
  while (true) {
    const found =
      readStatusLineCommand(join(dir, ".claude", "settings.local.json")) ??
      readStatusLineCommand(join(dir, ".claude", "settings.json"));
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (
    readStatusLineCommand(join(home, ".claude", "settings.local.json")) ??
    readStatusLineCommand(join(home, ".claude", "settings.json"))
  );
}

interface StatusLinePayload {
  hook_event_name: "Status";
  session_id: string;
  cwd: string;
  model: { id: string; display_name: string };
  workspace: { current_dir: string; project_dir: string };
  version: string;
  cost: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
}

/** Best-effort approximation of Claude Code's own statusLine payload. */
export function buildStatusLinePayload(opts: {
  workflow: Pick<Workflow, "sourcePath">;
  sessionId: string;
  model: string;
  totalCostUsd: number;
  elapsedMs: number;
}): StatusLinePayload {
  const cwd = process.cwd();
  return {
    hook_event_name: "Status",
    session_id: opts.sessionId,
    cwd,
    model: { id: opts.model, display_name: opts.model },
    workspace: {
      current_dir: cwd,
      project_dir: opts.workflow.sourcePath
        ? dirname(opts.workflow.sourcePath)
        : cwd,
    },
    version: CURRENT_VERSION,
    cost: {
      total_cost_usd: opts.totalCostUsd,
      total_duration_ms: opts.elapsedMs,
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
  };
}

/**
 * Runs a statusLine command with `payload` on stdin and returns its first
 * printed line, or undefined if it errors, times out, exits non-zero, or
 * prints nothing. Runs through the shell so commands using `~`, pipes, or
 * env vars behave the way they would from settings.json.
 */
export function runStatusLine(
  command: string,
  payload: unknown,
  timeoutMs = 3000,
): Promise<string | undefined> {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        timeout: timeoutMs,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolveResult(undefined);
      return;
    }
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolveResult(undefined));
    child.stdin.on("error", () => {
      // A spawn failure fires 'error' above; this just stops it also
      // surfacing as an uncaught 'error' event on the stdin stream.
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolveResult(undefined);
        return;
      }
      const line = stripAnsi(out).split("\n")[0]?.trim();
      resolveResult(line || undefined);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Statusline integration is enabled by default; opt out with EXECUTANT_STATUSLINE=0. */
export function statusLineEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["EXECUTANT_STATUSLINE"] !== "0";
}
