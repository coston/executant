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

/**
 * Returns a shell command that fails until it has run `failures` times, then
 * passes. The counter lives in a fresh temp file, so each call is isolated.
 */
export function flakyCommand(failures: number): string {
  const counterFile = join(tmpDir(), "counter");
  writeFileSync(counterFile, "0", "utf8");
  return `count=$(cat ${counterFile}); echo $((count + 1)) > ${counterFile}; test "$count" -ge ${failures}`;
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

/**
 * Installs a sequenced mock claude binary into a temp dir prepended to PATH.
 * Each invocation reads/increments a shared counter and serves the
 * corresponding pre-written NDJSON response. The prompt arg ($2) is saved to
 * promptsDir/<call_index>.txt so tests can assert on injected content.
 */
export function installSequencedMock(responses: string[]): {
  promptsDir: string;
} {
  const mockDir = tmpDir();
  const responsesDir = join(mockDir, "responses");
  const promptsDir = join(mockDir, "prompts");
  const counterFile = join(mockDir, "counter");

  mkdirSync(responsesDir, { recursive: true });
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(counterFile, "0", "utf8");

  for (const [i, text] of responses.entries()) {
    const ndjson =
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      }) +
      "\n" +
      JSON.stringify({ type: "result", total_cost_usd: 0.001 }) +
      "\n";
    writeFileSync(join(responsesDir, `${i}.ndjson`), ndjson, "utf8");
  }

  const mockScript = join(mockDir, "claude");
  writeFileSync(
    mockScript,
    `#!/usr/bin/env bash
count=$(cat "${counterFile}")
echo $((count + 1)) > "${counterFile}"
printf '%s' "$2" > "${promptsDir}/$count.txt"
cat "${responsesDir}/$count.ndjson"
exit 0
`,
    "utf8",
  );
  chmodSync(mockScript, 0o755);

  process.env["PATH"] = `${mockDir}:${process.env["PATH"] ?? ""}`;

  return { promptsDir };
}

/**
 * Installs a fixed-response mock claude binary into a temp dir prepended to
 * PATH. When opts.traceparentFile is set, the mock first dumps its
 * $TRACEPARENT env var to that file so tests can assert env propagation.
 */
export function installMockClaude(opts?: { traceparentFile?: string }): {
  mockDir: string;
  originalPath: string;
} {
  const mockDir = join(
    tmpdir(),
    `executant-mock-claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(mockDir, { recursive: true });

  const traceparentDump = opts?.traceparentFile
    ? `printf '%s' "$TRACEPARENT" > "${opts.traceparentFile}"\n`
    : "";
  const mockScript = join(mockDir, "claude");
  writeFileSync(
    mockScript,
    `#!/usr/bin/env bash
${traceparentDump}echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Applied fix"}]}}'
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
