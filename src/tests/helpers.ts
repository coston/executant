import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, Workflow } from "../types.js";

export function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `executant-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function tmpYaml(content: string): string {
  const dir = join(tmpdir(), `executant-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`,
  );
  writeFileSync(file, content, "utf8");
  return file;
}

export async function collectEvents(workflow: Workflow): Promise<Event[]> {
  const { runWorkflow } = await import("../runner.js");
  const events: Event[] = [];
  for await (const e of runWorkflow(workflow)) events.push(e);
  return events;
}

function normalizeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export async function collectEventsUntilError(
  workflow: Workflow,
): Promise<{ events: Event[]; error?: Error }> {
  const { runWorkflow } = await import("../runner.js");
  const events: Event[] = [];
  try {
    for await (const e of runWorkflow(workflow)) events.push(e);
  } catch (err) {
    return { events, error: normalizeError(err) };
  }
  return { events };
}

export function installMockClaude(): { mockDir: string; originalPath: string } {
  const mockDir = join(
    tmpdir(),
    `executant-mock-claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(mockDir, { recursive: true });

  const mockScript = join(mockDir, "claude");
  writeFileSync(
    mockScript,
    `#!/usr/bin/env bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Applied fix"}]}}'
echo '{"type":"result","total_cost_usd":0.001}'
exit 0
`,
    "utf8",
  );
  chmodSync(mockScript, 0o755);

  const originalPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${mockDir}:${originalPath}`;

  return { mockDir, originalPath };
}
