// ============================================================================
// TRACE CONTEXT REGISTRY
// ============================================================================
// Module-level registry holding the current W3C traceparent string so spawn
// sites (claude.ts, opencode.ts, command.ts) can propagate trace context to
// child processes via the TRACEPARENT env var.
//
// Deliberately free of OpenTelemetry imports — plain strings only — so the
// bundle never loads the OTel SDK when telemetry is off. The telemetry
// observer sets the registry synchronously on step:start; the runner is
// suspended at `yield` until the consumer pulls the next event, so the value
// is guaranteed to be in place before the step's spawn.

let current: string | undefined;

/** Sets (or clears, with undefined) the traceparent for subsequent spawns. */
export function setTraceparent(tp: string | undefined): void {
  current = tp;
}

/** Returns the current traceparent, or undefined when telemetry is off. */
export function getTraceparent(): string | undefined {
  return current;
}

/**
 * Env fragment to spread into a child process env: `{ TRACEPARENT }` when the
 * registry is set, `{}` otherwise — so spawn env is identical to today when
 * telemetry is off.
 */
export function traceparentEnv(): Record<string, string> {
  const tp = getTraceparent();
  return tp ? { TRACEPARENT: tp } : {};
}
