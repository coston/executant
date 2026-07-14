// ============================================================================
// TELEMETRY OBSERVER (OpenTelemetry)
// ============================================================================
//
// Subscribes to the runner's event stream (same observe() shape as Logger)
// and exports OpenTelemetry traces + metrics to an OTLP/HTTP collector.
//
// Enabled ONLY when OTEL_EXPORTER_OTLP_ENDPOINT is set — createTelemetry
// returns null otherwise, before importing anything. All @opentelemetry/*
// imports are dynamic and live INSIDE createTelemetry: esbuild preserves
// external dynamic imports verbatim, so the bundled CLI never loads the OTel
// SDK when telemetry is off.
//
// Span model (one trace per run):
//   executant.run                  root — goal/task/step_count/total cost
//   └─ <step name>                 per step — index/type/provider/model/cost;
//      │                           span events: tool, healing, judge
//      └─ iteration N/M            per top-level forEach iteration
//
// The current step's span context is published to the trace-context registry
// so child processes (claude, opencode, bash) inherit a TRACEPARENT env var.

import type {
  Attributes,
  Context,
  Counter,
  Histogram,
  Span,
  Tracer,
} from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { IMetricReader } from "@opentelemetry/sdk-metrics";
import type {
  AgentProvider,
  ClaudeTask,
  Event,
  OutputCostEvent,
  StepCompleteEvent,
  StepErrorEvent,
  StepHealingEvent,
  StepIterationEvent,
  StepJudgeEvent,
  Task,
  Workflow,
} from "./types.js";
import { resolveAgentModel, resolveAgentProvider } from "./tasks/agent.js";
import { setTraceparent } from "./lib/trace-context.js";
import { getErrorMessage } from "./lib/utils.js";
import { CURRENT_VERSION } from "./version.js";
import type { Observer } from "./logger.js";

// ============================================================================
// Public API
// ============================================================================

/** Synchronous event observer (same observe() shape as Logger) + shutdown. */
export interface Telemetry extends Observer {
  /**
   * Ends any open spans, flushes both providers, and stops the SDK.
   * Idempotent; the flush and every in-flight OTLP request are capped at ~3s
   * so a dead collector cannot hang exit.
   */
  shutdown(): Promise<void>;
}

/** Test seam: inject in-memory exporters instead of the OTLP/HTTP defaults. */
export interface TelemetryOptions {
  /** SpanExporter; defaults to OTLP/HTTP from OTEL_EXPORTER_OTLP_ENDPOINT. */
  spanExporter?: unknown;
  /** MetricReader; defaults to a periodic OTLP/HTTP exporting reader. */
  metricReader?: unknown;
}

/**
 * Creates the telemetry observer, or returns null when
 * OTEL_EXPORTER_OTLP_ENDPOINT is unset (read lazily at creation time — never
 * at module top level — so tests can toggle it per case).
 */
export async function createTelemetry(
  taskName: string,
  opts?: TelemetryOptions,
): Promise<Telemetry | null> {
  if (!process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]) return null;

  const [api, resources, traceSdk, metricsSdk] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/sdk-metrics"),
  ]);

  const resource = resources.defaultResource().merge(
    resources.resourceFromAttributes({
      "service.name": process.env["OTEL_SERVICE_NAME"] ?? "executant",
      "service.version": CURRENT_VERSION,
    }),
  );

  const spanExporter =
    (opts?.spanExporter as SpanExporter | undefined) ??
    new (
      await import("@opentelemetry/exporter-trace-otlp-http")
    ).OTLPTraceExporter({ timeoutMillis: EXPORT_TIMEOUT_MS });
  const tracerProvider = new traceSdk.BasicTracerProvider({
    resource,
    // Injected (test) exporters get a simple processor so finished spans are
    // visible immediately; the real OTLP exporter batches.
    spanProcessors: [
      opts?.spanExporter
        ? new traceSdk.SimpleSpanProcessor(spanExporter)
        : new traceSdk.BatchSpanProcessor(spanExporter),
    ],
  });

  const metricReader =
    (opts?.metricReader as IMetricReader | undefined) ??
    new metricsSdk.PeriodicExportingMetricReader({
      exporter: new (
        await import("@opentelemetry/exporter-metrics-otlp-http")
      ).OTLPMetricExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }),
    });
  const meterProvider = new metricsSdk.MeterProvider({
    resource,
    readers: [metricReader],
  });

  const meter = meterProvider.getMeter("executant");
  const deps: OtelDeps = {
    api,
    taskName,
    tracer: tracerProvider.getTracer("executant"),
    instruments: {
      stepDuration: meter.createHistogram("executant.step.duration", {
        unit: "ms",
        description: "Wall-clock duration of each workflow step",
      }),
      stepErrors: meter.createCounter("executant.step.errors", {
        description: "Steps that ended in error",
      }),
      costUsd: meter.createCounter("executant.cost.usd", {
        description: "API cost reported by agent invocations",
      }),
      healingAttempts: meter.createHistogram("executant.healing.attempts", {
        description: "Self-healing attempts used per finished loop outcome",
      }),
      judgeVerdicts: meter.createCounter("executant.judge.verdicts", {
        description: "LLM-as-judge evaluations by verdict",
      }),
    },
  };

  let state = INIT_STATE;
  let shutdownPromise: Promise<void> | undefined;

  return {
    observe(event: Event): void {
      if (shutdownPromise) return; // safe no-op after shutdown
      try {
        state = reduce(deps, state, event);
      } catch (err) {
        // A broken exporter/SDK must never break a run (same policy as Logger).
        console.warn(`[telemetry] error: ${getErrorMessage(err)}`);
      }
    },
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        // End anything still open — the run was abandoned (quit, SIGINT,
        // fatal step error). Stamp the accumulated cost first so aborted
        // runs still export the totals tracked in state.
        if (state.stepCost > 0)
          state.step?.setAttribute("executant.cost.usd", state.stepCost);
        if (state.totalCost > 0)
          state.root?.setAttribute("executant.cost.total.usd", state.totalCost);
        [state.iteration, state.step, state.root]
          .flatMap((span) => (span ? [span] : []))
          .forEach((span) => {
            span.setAttribute("executant.aborted", true);
            span.end();
          });
        state = INIT_STATE;
        setTraceparent(undefined);
        // Flush then stop both providers, hard-capped so a dead collector can
        // never hang process exit. All SDK timers are cleared by shutdown().
        await raceTimeout(
          Promise.all([
            tracerProvider.forceFlush(),
            meterProvider.forceFlush(),
          ]).then(() =>
            Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]),
          ),
          SHUTDOWN_TIMEOUT_MS,
        );
      })();
      return shutdownPromise;
    },
  };
}

// ============================================================================
// State machine — reducer over events, mirroring logger.ts
// ============================================================================

type OtelApi = typeof import("@opentelemetry/api");

/** Metric instruments created once at startup and recorded per event. */
interface Instruments {
  readonly stepDuration: Histogram;
  readonly stepErrors: Counter;
  readonly costUsd: Counter;
  readonly healingAttempts: Histogram;
  readonly judgeVerdicts: Counter;
}

/** Fixed values determined at creation — never change across events. */
interface OtelDeps {
  readonly api: OtelApi;
  readonly tracer: Tracer;
  readonly instruments: Instruments;
  readonly taskName: string;
}

/** Mutable snapshot replaced (not mutated) on each event. */
interface TelemetryState {
  /** Task list snapshotted at workflow:start (like the UI reducer does). */
  readonly tasks: readonly Task[];
  readonly root?: Span;
  readonly rootTraceparent?: string;
  readonly step?: Span;
  /** The running step's task — source of type/provider/model attributes. */
  readonly stepTask?: Task;
  readonly stepStartMs: number;
  /** Cost accumulated for the running step (output:cost events). */
  readonly stepCost: number;
  readonly totalCost: number;
  readonly iteration?: Span;
}

const INIT_STATE: TelemetryState = {
  tasks: [],
  stepStartMs: 0,
  stepCost: 0,
  totalCost: 0,
};

const SHUTDOWN_TIMEOUT_MS = 3_000;
/**
 * In-flight OTLP requests abort at the same horizon as the shutdown cap.
 * Without this, a dead-but-accepting collector keeps the export socket (and
 * therefore the event loop) alive for the exporter's ~10s default long after
 * shutdown() has resolved, delaying drain-based process exit.
 */
const EXPORT_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS;
const MAX_ITEM_CHARS = 200;
const MAX_FEEDBACK_CHARS = 500;
/** Failed steps' error messages can quote step output — keep them bounded. */
const MAX_ERROR_CHARS = 1_000;

function reduce(
  deps: OtelDeps,
  s: TelemetryState,
  event: Event,
): TelemetryState {
  switch (event.type) {
    case "workflow:start":
      return onWorkflowStart(deps, s, event.workflow);
    case "workflow:complete":
      return onWorkflowEnd(deps, s, "complete");
    case "workflow:cancelled":
      return onWorkflowEnd(deps, s, "cancelled");
    case "step:start":
      return onStepStart(deps, s, event.index, event.name);
    case "step:complete":
      return onStepComplete(deps, s, event);
    case "step:error":
      return onStepError(deps, s, event);
    case "step:skip":
      return onStepSkip(deps, s, event.index, event.name);
    case "step:iteration":
      return onIteration(deps, s, event);
    case "output:tool":
      // Tool name only — inputs may contain secrets/prompts; keep spans lean.
      s.step?.addEvent("tool", { tool: event.tool });
      return s;
    case "step:healing":
      return onHealing(deps, s, event);
    case "step:judge":
      return onJudge(deps, s, event);
    case "output:cost":
      return onCost(deps, s, event);
    default:
      // output:text is deliberately NOT recorded — per-line span events would
      // grow without bound. The rest (log, step:inner, …) carry nothing the
      // span model needs.
      return s;
  }
}

// ----------------------------------------------------------------------------
// Handlers — each performs its span/metric side-effects, returns the new state
// ----------------------------------------------------------------------------

function onWorkflowStart(
  deps: OtelDeps,
  _s: TelemetryState,
  workflow: Workflow,
): TelemetryState {
  const root = deps.tracer.startSpan("executant.run", {
    attributes: {
      "executant.goal": workflow.goal,
      "executant.task": deps.taskName,
      "executant.step_count": workflow.tasks.length,
    },
  });
  const rootTraceparent = toTraceparent(root);
  setTraceparent(rootTraceparent);
  return { ...INIT_STATE, tasks: workflow.tasks, root, rootTraceparent };
}

function onWorkflowEnd(
  deps: OtelDeps,
  s: TelemetryState,
  outcome: "complete" | "cancelled",
): TelemetryState {
  if (!s.root) return s;
  if (s.totalCost > 0)
    s.root.setAttribute("executant.cost.total.usd", s.totalCost);
  if (outcome === "cancelled") s.root.setAttribute("executant.cancelled", true);
  else s.root.setStatus({ code: deps.api.SpanStatusCode.OK });
  s.root.end();
  setTraceparent(undefined);
  return { ...s, root: undefined, rootTraceparent: undefined };
}

function onStepStart(
  deps: OtelDeps,
  s: TelemetryState,
  index: number,
  name: string,
): TelemetryState {
  if (!s.root) return s;
  const task = s.tasks[index];
  const step = deps.tracer.startSpan(
    name,
    { attributes: stepAttributes(index, name, task) },
    childOf(deps.api, s.root),
  );
  setTraceparent(toTraceparent(step));
  return {
    ...s,
    step,
    stepTask: task,
    stepStartMs: Date.now(),
    stepCost: 0,
    iteration: undefined,
  };
}

function onStepComplete(
  deps: OtelDeps,
  s: TelemetryState,
  event: StepCompleteEvent,
): TelemetryState {
  if (!s.step) return s;
  finalizeStepSpan(s);
  s.step.setStatus({ code: deps.api.SpanStatusCode.OK });
  s.step.end();
  deps.instruments.stepDuration.record(event.durationMs, {
    step_name: event.name,
    step_type: s.stepTask?.type ?? "unknown",
    status: "complete",
  });
  setTraceparent(s.rootTraceparent);
  return clearStep(s);
}

function onStepError(
  deps: OtelDeps,
  s: TelemetryState,
  event: StepErrorEvent,
): TelemetryState {
  if (!s.step) return s;
  finalizeStepSpan(s);
  // Failed claude steps quote their output lines in error.message (and V8
  // stacks embed the message) — record a bounded, stack-free exception so
  // step output can never flow to the collector unbounded.
  const message = truncate(event.error.message, MAX_ERROR_CHARS);
  s.step.recordException({ name: event.error.name, message });
  s.step.setStatus({
    code: deps.api.SpanStatusCode.ERROR,
    message,
  });
  s.step.end();
  deps.instruments.stepDuration.record(Date.now() - s.stepStartMs, {
    step_name: event.name,
    step_type: s.stepTask?.type ?? "unknown",
    status: "error",
  });
  deps.instruments.stepErrors.add(1, { step_name: event.name });
  // continue_on_error means step:error is not workflow-fatal — the root span
  // stays open and only ever ends on workflow:complete/cancelled/shutdown.
  setTraceparent(s.rootTraceparent);
  return clearStep(s);
}

function onStepSkip(
  deps: OtelDeps,
  s: TelemetryState,
  index: number,
  name: string,
): TelemetryState {
  if (!s.root) return s;
  deps.tracer
    .startSpan(
      name,
      {
        attributes: {
          ...stepAttributes(index, name, s.tasks[index]),
          "executant.step.skipped": true,
        },
      },
      childOf(deps.api, s.root),
    )
    .end();
  return s;
}

function onIteration(
  deps: OtelDeps,
  s: TelemetryState,
  event: StepIterationEvent,
): TelemetryState {
  if (!s.step) return s;
  s.iteration?.end(); // the previous iteration ends when the next starts
  const iteration = deps.tracer.startSpan(
    `iteration ${event.iteration}/${event.total}`,
    { attributes: { "executant.item": truncate(event.item, MAX_ITEM_CHARS) } },
    childOf(deps.api, s.step),
  );
  return { ...s, iteration };
}

function onHealing(
  deps: OtelDeps,
  s: TelemetryState,
  event: StepHealingEvent,
): TelemetryState {
  s.step?.addEvent("healing", {
    phase: event.phase,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
  });
  // The loop's terminal phases record how many attempts the outcome took.
  if (event.phase !== "attempt-failed")
    deps.instruments.healingAttempts.record(event.attempt, {
      outcome: event.phase,
    });
  return s;
}

function onJudge(
  deps: OtelDeps,
  s: TelemetryState,
  event: StepJudgeEvent,
): TelemetryState {
  s.step?.addEvent("judge", {
    verdict: event.verdict,
    attempt: event.attempt,
    ...(event.feedback
      ? { feedback: truncate(event.feedback, MAX_FEEDBACK_CHARS) }
      : {}),
  });
  deps.instruments.judgeVerdicts.add(1, { verdict: event.verdict });
  return s;
}

function onCost(
  deps: OtelDeps,
  s: TelemetryState,
  event: OutputCostEvent,
): TelemetryState {
  deps.instruments.costUsd.add(event.usd, {
    provider: stepProvider(s.stepTask),
  });
  return {
    ...s,
    stepCost: s.stepCost + event.usd,
    totalCost: s.totalCost + event.usd,
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Ends an open iteration span and stamps the step's accumulated cost. */
function finalizeStepSpan(s: TelemetryState): void {
  s.iteration?.end(); // an open iteration ends with its step
  if (s.step && s.stepCost > 0)
    s.step.setAttribute("executant.cost.usd", s.stepCost);
}

function clearStep(s: TelemetryState): TelemetryState {
  return {
    ...s,
    step: undefined,
    stepTask: undefined,
    iteration: undefined,
    stepCost: 0,
  };
}

function stepAttributes(
  index: number,
  name: string,
  task: Task | undefined,
): Attributes {
  return {
    "executant.step.index": index,
    "executant.step.name": name,
    ...(task ? { "executant.step.type": task.type } : {}),
    ...(task?.type === "claude" ? agentAttributes(task) : {}),
  };
}

function agentAttributes(task: ClaudeTask): Attributes {
  const model = resolveAgentModel(task);
  return {
    "executant.provider": resolveAgentProvider(task),
    ...(model ? { "executant.model": model } : {}),
  };
}

/**
 * Provider attribute for cost metrics. Healing/judge sub-invocations inside
 * non-claude steps always run the claude provider explicitly.
 */
function stepProvider(task: Task | undefined): AgentProvider {
  return task?.type === "claude" ? resolveAgentProvider(task) : "claude";
}

function childOf(api: OtelApi, parent: Span): Context {
  return api.trace.setSpan(api.context.active(), parent);
}

/** W3C traceparent for a span: 00-<traceId>-<spanId>-01 (sampled). */
function toTraceparent(span: Span): string {
  const { traceId, spanId } = span.spanContext();
  return `00-${traceId}-${spanId}-01`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Awaits `work` but resolves after `ms` regardless, swallowing rejections —
 * telemetry flushing must never hang or crash process exit. The fallback
 * timer is always cleared so no live handle outlives the call.
 */
async function raceTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  const safe = work.then(
    () => undefined,
    () => undefined,
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      safe,
      new Promise<void>((done) => {
        timer = setTimeout(done, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
