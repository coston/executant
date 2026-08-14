// ============================================================================
// useStatusLine
// ============================================================================
// Runs the user's Claude Code statusLine command (if configured) on mount and
// on a fixed interval, and returns its latest output line. Returns null when
// disabled, unconfigured, or the command has not produced output yet — the
// caller renders nothing in that case, per the "just don't show it" contract.

import { useEffect, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
import type { Workflow } from "../types.js";
import {
  buildStatusLinePayload,
  findStatusLineCommand,
  runStatusLine,
  statusLineEnabled,
} from "../lib/statusline.js";
import { DEFAULT_MODEL } from "../lib/utils.js";

const REFRESH_MS = 30_000;

export function useStatusLine(
  workflow: Pick<Workflow, "sourcePath">,
  totalCostUsd: number,
  startTime: number | undefined,
): string | null {
  const [line, setLine] = useState<string | null>(null);
  const [command] = useState(() =>
    statusLineEnabled() ? findStatusLineCommand(process.cwd()) : undefined,
  );
  const [sessionId] = useState(() => randomUUID());
  const model = process.env["EXECUTANT_MODEL"] ?? DEFAULT_MODEL;

  // Read inside the interval closure without re-triggering the effect on
  // every cost/tick update — only `command` and `sessionId` ever change it.
  const latest = useRef({ totalCostUsd, startTime });
  latest.current = { totalCostUsd, startTime };

  useEffect(() => {
    if (!command) return;
    let active = true;

    const refresh = () => {
      const { totalCostUsd, startTime } = latest.current;
      const payload = buildStatusLinePayload({
        workflow,
        sessionId,
        model,
        totalCostUsd,
        elapsedMs: startTime ? Date.now() - startTime : 0,
      });
      runStatusLine(command, payload).then((out) => {
        if (active && out) setLine(out);
      });
    };

    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
    // workflow.sourcePath and model are fixed for the run's lifetime, so
    // command/sessionId (both set once via useState initializers) are the
    // only inputs that ever actually change.
  }, [command, sessionId]);

  return line;
}
