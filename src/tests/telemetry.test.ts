// ============================================================================
// TELEMETRY TESTS (unit)
// ============================================================================
// Drives Telemetry.observe() directly with hand-built Event literals
// (logger.test.ts style) and asserts on spans/metrics collected by injected
// in-memory exporters (the TelemetryOptions test seam).
//
// IMPORTANT: no static value imports from @opentelemetry/* — the first test
// proves the disabled path loads no OTel modules at all, so everything OTel
// is imported dynamically inside the tests that need it (type-only imports
// are erased and safe). Tests run in declaration order ({ concurrency: 1 }),
// so the disabled-path describe MUST stay first.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import type { Attributes } from "@opentelemetry/api";
import type {
  InMemorySpanExporter,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type {
  InMemoryMetricExporter,
  MetricData,
} from "@opentelemetry/sdk-metrics";

import {
  createTelemetry,
  type Telemetry,
  type TelemetryOptions,
} from "../telemetry.js";
import { getTraceparent, setTraceparent } from "../lib/trace-context.js";
import type { Event, Workflow } from "../types.js";

const require = createRequire(import.meta.url);

/** node_modules paths of every currently loaded @opentelemetry module. */
function loadedOtelModules(): string[] {
  return Object.keys(require.cache ?? {}).filter((p) =>
    p.includes("@opentelemetry"),
  );
}

// ----------------------------------------------------------------------------
// Fixtures & harness
// ----------------------------------------------------------------------------

const WORKFLOW: Workflow = {
  goal: "test goal",
  tasks: [
    { type: "command", name: "step-a", command: "echo a" },
    { type: "claude", name: "step-b", prompt: "do b", model: "sonnet" },
  ],
};

const start = (index: number, name: string): Event => ({
  type: "step:start",
  index,
  name,
});
const complete = (index: number, name: string, durationMs = 10): Event => ({
  type: "step:complete",
  index,
  name,
  durationMs,
});

interface Harness {
  telemetry: Telemetry;
  spanExporter: InMemorySpanExporter;
  metricExporter: InMemoryMetricExporter;
  statusCode: { OK: number; ERROR: number; UNSET: number };
  spans(): ReadableSpan[];
  span(name: string): ReadableSpan;
  metric(name: string): MetricData | undefined;
}

/** Creates a Telemetry wired to in-memory exporters via the test seam. */
async function makeTelemetry(taskName = "task.yaml"): Promise<Harness> {
  const [api, traceSdk, metricsSdk] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/sdk-metrics"),
  ]);
  const spanExporter = new traceSdk.InMemorySpanExporter();
  const metricExporter = new metricsSdk.InMemoryMetricExporter(
    metricsSdk.AggregationTemporality.CUMULATIVE,
  );
  const metricReader = new metricsSdk.PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000, // delivered by shutdown()'s flush, not the timer
  });
  const options: TelemetryOptions = {
    // InMemorySpanExporter wipes its buffer on shutdown(); delegate everything
    // but shutdown so spans stay readable after telemetry.shutdown().
    spanExporter: {
      export: spanExporter.export.bind(spanExporter),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    metricReader,
  };
  const telemetry = await createTelemetry(taskName, options);
  assert.ok(telemetry, "telemetry should be enabled (env var is set)");
  const spans = () => spanExporter.getFinishedSpans();
  const span = (name: string): ReadableSpan => {
    const found = spans().find((s) => s.name === name);
    assert.ok(found, `expected a finished span named "${name}"`);
    return found;
  };
  return {
    telemetry,
    spanExporter,
    metricExporter,
    statusCode: api.SpanStatusCode,
    spans,
    span,
    metric: (name) =>
      metricExporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics)
        .flatMap((sm) => sm.metrics)
        .filter((m) => m.descriptor.name === name)
        .at(-1),
  };
}

function observeAll(telemetry: Telemetry, events: Event[]): void {
  events.forEach((e) => telemetry.observe(e));
}

/** Loosely-typed dataPoints accessors — keeps assertions free of enum juggling. */
function sumPoints(
  metric: MetricData | undefined,
): Array<{ attributes: Attributes; value: number }> {
  return (metric?.dataPoints ?? []) as Array<{
    attributes: Attributes;
    value: number;
  }>;
}
function histogramPoints(
  metric: MetricData | undefined,
): Array<{ attributes: Attributes; value: { count: number; sum?: number } }> {
  return (metric?.dataPoints ?? []) as Array<{
    attributes: Attributes;
    value: { count: number; sum?: number };
  }>;
}

const approx = (actual: unknown, expected: number) =>
  assert.ok(
    typeof actual === "number" && Math.abs(actual - expected) < 1e-9,
    `expected ≈${expected}, got ${String(actual)}`,
  );

// Serialise all describes: they share process.env and the traceparent registry.
describe("telemetry", { concurrency: 1 }, () => {
  let originalEndpoint: string | undefined;
  let originalServiceName: string | undefined;

  beforeEach(() => {
    originalEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    originalServiceName = process.env["OTEL_SERVICE_NAME"];
    // Port 1 is never contacted — all tests inject in-memory exporters.
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:1";
    delete process.env["OTEL_SERVICE_NAME"];
    setTraceparent(undefined);
  });

  afterEach(() => {
    if (originalEndpoint === undefined)
      delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    else process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = originalEndpoint;
    if (originalServiceName === undefined)
      delete process.env["OTEL_SERVICE_NAME"];
    else process.env["OTEL_SERVICE_NAME"] = originalServiceName;
    setTraceparent(undefined);
  });

  // --------------------------------------------------------------------------
  // Disabled path — MUST run first, before any test loads the OTel SDK
  // --------------------------------------------------------------------------

  describe("disabled path", () => {
    test("returns null and loads no @opentelemetry modules when the endpoint is unset", async () => {
      delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
      assert.deepEqual(
        loadedOtelModules(),
        [],
        "test-order violation: OTel already loaded before the disabled-path test",
      );

      const telemetry = await createTelemetry("task.yaml");

      assert.equal(telemetry, null);
      assert.deepEqual(
        loadedOtelModules(),
        [],
        "disabled createTelemetry must not import any @opentelemetry module",
      );
      assert.equal(getTraceparent(), undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Span model
  // --------------------------------------------------------------------------

  describe("span model", () => {
    test("happy path: root + step spans with parentage, durations, and attributes", async () => {
      const h = await makeTelemetry("my-task.yaml");
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        complete(0, "step-a", 12),
        start(1, "step-b"),
        complete(1, "step-b", 34),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await h.telemetry.shutdown();

      assert.equal(h.spans().length, 3);
      const root = h.span("executant.run");
      assert.equal(root.parentSpanContext, undefined);
      assert.equal(root.status.code, h.statusCode.OK);
      assert.equal(root.attributes["executant.goal"], "test goal");
      assert.equal(root.attributes["executant.task"], "my-task.yaml");
      assert.equal(root.attributes["executant.step_count"], 2);

      const stepA = h.span("step-a");
      assert.equal(
        stepA.parentSpanContext?.spanId,
        root.spanContext().spanId,
        "step spans must be children of the root span",
      );
      assert.equal(stepA.status.code, h.statusCode.OK);
      assert.equal(stepA.attributes["executant.step.index"], 0);
      assert.equal(stepA.attributes["executant.step.name"], "step-a");
      assert.equal(stepA.attributes["executant.step.type"], "command");

      const stepB = h.span("step-b");
      assert.equal(stepB.parentSpanContext?.spanId, root.spanContext().spanId);
      assert.equal(stepB.attributes["executant.step.type"], "claude");
      assert.equal(stepB.attributes["executant.provider"], "claude");
      assert.equal(stepB.attributes["executant.model"], "sonnet");

      // Durations flow into the histogram exactly as reported by the runner.
      const durations = histogramPoints(h.metric("executant.step.duration"));
      const pointA = durations.find(
        (p) => p.attributes["step_name"] === "step-a",
      );
      assert.equal(pointA?.value.sum, 12);
      assert.equal(pointA?.attributes["step_type"], "command");
      assert.equal(pointA?.attributes["status"], "complete");
      const pointB = durations.find(
        (p) => p.attributes["step_name"] === "step-b",
      );
      assert.equal(pointB?.value.sum, 34);
    });

    test("step:error records exception + ERROR status; continue_on_error keeps root OK", async () => {
      const h = await makeTelemetry();
      const boom = new Error("boom");
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        { type: "step:error", index: 0, name: "step-a", error: boom },
        start(1, "step-b"),
        complete(1, "step-b"),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await h.telemetry.shutdown();

      const stepA = h.span("step-a");
      assert.equal(stepA.status.code, h.statusCode.ERROR);
      assert.equal(stepA.status.message, "boom");
      const exception = stepA.events.find((e) => e.name === "exception");
      assert.ok(exception, "recordException should add an exception event");

      // A swallowed step error must never end (or fail) the root span.
      assert.equal(h.span("executant.run").status.code, h.statusCode.OK);

      const errors = sumPoints(h.metric("executant.step.errors"));
      assert.equal(errors.length, 1);
      assert.equal(errors[0].attributes["step_name"], "step-a");
      assert.equal(errors[0].value, 1);
      const errorDuration = histogramPoints(
        h.metric("executant.step.duration"),
      ).find((p) => p.attributes["status"] === "error");
      assert.equal(errorDuration?.attributes["step_name"], "step-a");
      assert.equal(errorDuration?.value.count, 1);
    });

    test("workflow:cancelled ends the root span cancelled, without OK status, and clears the traceparent", async () => {
      const h = await makeTelemetry();
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        complete(0, "step-a"),
        { type: "workflow:cancelled", workflow: WORKFLOW, durationMs: 20 },
      ]);
      assert.equal(
        getTraceparent(),
        undefined,
        "traceparent cleared when the root ends",
      );
      await h.telemetry.shutdown();

      const root = h.span("executant.run");
      assert.equal(root.attributes["executant.cancelled"], true);
      assert.notEqual(
        root.status.code,
        h.statusCode.OK,
        "a cancelled run must not report OK",
      );
      assert.ok(
        !("executant.aborted" in root.attributes),
        "a clean cancellation is not an abort — shutdown must not relabel it",
      );
    });

    test("step:error bounds the recorded exception and status message", async () => {
      const h = await makeTelemetry();
      // Failed claude steps join their output lines into error.message —
      // simulate a noisy one and prove nothing unbounded reaches the span.
      const noisy = new Error(
        `claude exited with code 1\n${"output line with a secret token\n".repeat(200)}`,
      );
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        { type: "step:error", index: 0, name: "step-a", error: noisy },
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 5 },
      ]);
      await h.telemetry.shutdown();

      const stepA = h.span("step-a");
      // ~1000-char truncation (+1 for the ellipsis)
      assert.ok((stepA.status.message ?? "").length <= 1001);
      const exception = stepA.events.find((e) => e.name === "exception");
      assert.ok(exception, "recordException should add an exception event");
      const message = exception.attributes?.["exception.message"];
      assert.equal(typeof message, "string");
      assert.ok((message as string).length <= 1001);
      assert.ok(
        !("exception.stacktrace" in (exception.attributes ?? {})),
        "V8 stacks embed the full message — they must not be recorded",
      );
    });

    test("step:skip creates an immediately-ended span flagged skipped", async () => {
      const h = await makeTelemetry();
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        { type: "step:skip", index: 0, name: "step-a" },
        start(1, "step-b"),
        complete(1, "step-b"),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await h.telemetry.shutdown();

      const skipped = h.span("step-a");
      assert.equal(skipped.attributes["executant.step.skipped"], true);
      assert.equal(skipped.attributes["executant.step.type"], "command");
      assert.equal(
        skipped.parentSpanContext?.spanId,
        h.span("executant.run").spanContext().spanId,
      );
    });

    test("iteration spans: previous ends when the next starts; open one ends at step end", async () => {
      const h = await makeTelemetry();
      const longItem = "x".repeat(300);
      // The simple processor exports synchronously on end, so the set of
      // finished spans between observations proves the end ordering exactly.
      const finished = () => h.spans().map((s) => s.name);
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        {
          type: "step:iteration",
          index: 0,
          item: "one",
          iteration: 1,
          total: 2,
        },
      ]);
      assert.ok(!finished().includes("iteration 1/2"), "first is still open");

      h.telemetry.observe({
        type: "step:iteration",
        index: 0,
        item: longItem,
        iteration: 2,
        total: 2,
      });
      assert.ok(
        finished().includes("iteration 1/2"),
        "previous iteration ends when the next starts",
      );
      assert.ok(!finished().includes("iteration 2/2"), "second is still open");

      h.telemetry.observe(complete(0, "step-a"));
      assert.ok(
        finished().includes("iteration 2/2"),
        "open iteration ends at step end",
      );
      h.telemetry.observe({
        type: "workflow:complete",
        workflow: WORKFLOW,
        durationMs: 50,
      });
      await h.telemetry.shutdown();

      const first = h.span("iteration 1/2");
      const second = h.span("iteration 2/2");
      const stepSpanId = h.span("step-a").spanContext().spanId;
      assert.equal(first.parentSpanContext?.spanId, stepSpanId);
      assert.equal(second.parentSpanContext?.spanId, stepSpanId);
      assert.equal(first.attributes["executant.item"], "one");
      // ~200-char truncation of the item attribute
      const item = second.attributes["executant.item"];
      assert.equal(typeof item, "string");
      assert.ok((item as string).length <= 201);
      assert.ok((item as string).startsWith("xxx"));
    });

    test("positive control: enabled telemetry does load @opentelemetry modules (validates the disabled-path probe)", () => {
      assert.ok(loadedOtelModules().length > 0);
    });
  });

  // --------------------------------------------------------------------------
  // Span events (tool / healing / judge) — and none for output:text
  // --------------------------------------------------------------------------

  describe("span events", () => {
    test("tool, healing, and judge events land on the step span; output:text adds none", async () => {
      const h = await makeTelemetry();
      const longFeedback = "f".repeat(600);
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        {
          type: "output:tool",
          index: 0,
          tool: "Read",
          input: { file_path: "/secret" },
        },
        { type: "output:text", index: 0, text: "line 1" },
        { type: "output:text", index: 0, text: "line 2" },
        {
          type: "step:healing",
          index: 0,
          phase: "attempt-failed",
          attempt: 1,
          maxAttempts: 5,
          exitCode: 2,
        },
        {
          type: "step:healing",
          index: 0,
          phase: "healed",
          attempt: 2,
          maxAttempts: 5,
        },
        {
          type: "step:judge",
          index: 0,
          verdict: "fail",
          attempt: 1,
          maxAttempts: 5,
          feedback: longFeedback,
        },
        {
          type: "step:judge",
          index: 0,
          verdict: "pass",
          attempt: 2,
          maxAttempts: 5,
        },
        complete(0, "step-a"),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await h.telemetry.shutdown();

      const events = h.span("step-a").events;
      assert.deepEqual(
        events.map((e) => e.name),
        ["tool", "healing", "healing", "judge", "judge"],
        "output:text must add NO span events",
      );

      const [tool, healingFailed, healed, judgeFail, judgePass] = events;
      assert.equal(tool.attributes?.["tool"], "Read");
      assert.ok(
        !("input" in (tool.attributes ?? {})),
        "tool input must not be recorded",
      );

      assert.equal(healingFailed.attributes?.["phase"], "attempt-failed");
      assert.equal(healingFailed.attributes?.["attempt"], 1);
      assert.equal(healingFailed.attributes?.["maxAttempts"], 5);
      assert.equal(healingFailed.attributes?.["exitCode"], 2);
      assert.equal(healed.attributes?.["phase"], "healed");
      assert.ok(!("exitCode" in (healed.attributes ?? {})));

      assert.equal(judgeFail.attributes?.["verdict"], "fail");
      assert.equal(judgeFail.attributes?.["attempt"], 1);
      const feedback = judgeFail.attributes?.["feedback"];
      assert.equal(typeof feedback, "string");
      assert.ok(
        (feedback as string).length <= 501,
        "feedback truncated to ~500 chars",
      );
      assert.equal(judgePass.attributes?.["verdict"], "pass");
      assert.ok(!("feedback" in (judgePass.attributes ?? {})));

      // Metrics: verdict counter per verdict; healing histogram only for
      // terminal phases (healed/exhausted), not per attempt-failed.
      const verdicts = sumPoints(h.metric("executant.judge.verdicts"));
      assert.equal(
        verdicts.find((p) => p.attributes["verdict"] === "fail")?.value,
        1,
      );
      assert.equal(
        verdicts.find((p) => p.attributes["verdict"] === "pass")?.value,
        1,
      );
      const healing = histogramPoints(h.metric("executant.healing.attempts"));
      assert.equal(healing.length, 1);
      assert.equal(healing[0].attributes["outcome"], "healed");
      assert.equal(healing[0].value.sum, 2);
      assert.equal(healing[0].value.count, 1);
    });
  });

  // --------------------------------------------------------------------------
  // Cost accumulation
  // --------------------------------------------------------------------------

  describe("cost", () => {
    test("output:cost accumulates onto step and root attributes and the cost counter", async () => {
      const h = await makeTelemetry();
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(1, "step-b"), // claude step
        { type: "output:cost", index: 1, usd: 0.001 },
        { type: "output:cost", index: 1, usd: 0.002 },
        complete(1, "step-b"),
        start(0, "step-a"), // command step (healing cost arrives mid-step)
        { type: "output:cost", index: 0, usd: 0.004 },
        complete(0, "step-a"),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await h.telemetry.shutdown();

      approx(h.span("step-b").attributes["executant.cost.usd"], 0.003);
      approx(h.span("step-a").attributes["executant.cost.usd"], 0.004);
      approx(
        h.span("executant.run").attributes["executant.cost.total.usd"],
        0.007,
      );

      // Both steps attribute cost to the claude provider (healing/judge
      // sub-invocations inside command steps run claude explicitly).
      const cost = sumPoints(h.metric("executant.cost.usd"));
      assert.equal(cost.length, 1);
      assert.equal(cost[0].attributes["provider"], "claude");
      approx(cost[0].value, 0.007);
    });

    test("steps without cost events get no cost attributes", async () => {
      const h = await makeTelemetry();
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        complete(0, "step-a"),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await h.telemetry.shutdown();

      assert.ok(!("executant.cost.usd" in h.span("step-a").attributes));
      assert.ok(
        !("executant.cost.total.usd" in h.span("executant.run").attributes),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Traceparent registry integration
  // --------------------------------------------------------------------------

  describe("traceparent registry", () => {
    test("set to the step span on step:start, back to root between steps, cleared on root end", async () => {
      const h = await makeTelemetry();

      h.telemetry.observe({ type: "workflow:start", workflow: WORKFLOW });
      const rootTp = getTraceparent();
      assert.ok(rootTp, "root traceparent set on workflow:start");

      h.telemetry.observe(start(0, "step-a"));
      const stepTp = getTraceparent();
      assert.ok(stepTp);
      assert.notEqual(stepTp, rootTp);

      h.telemetry.observe(complete(0, "step-a"));
      assert.equal(getTraceparent(), rootTp, "reset to root between steps");

      h.telemetry.observe({
        type: "workflow:complete",
        workflow: WORKFLOW,
        durationMs: 50,
      });
      assert.equal(getTraceparent(), undefined, "cleared when the root ends");

      await h.telemetry.shutdown();

      // The published values match the real span ids (W3C sampled format).
      const root = h.span("executant.run").spanContext();
      const step = h.span("step-a").spanContext();
      assert.equal(rootTp, `00-${root.traceId}-${root.spanId}-01`);
      assert.equal(stepTp, `00-${step.traceId}-${step.spanId}-01`);
      assert.equal(step.traceId, root.traceId, "one trace per run");
    });

    test("cleared by shutdown when the run is abandoned mid-step", async () => {
      const h = await makeTelemetry();
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
      ]);
      assert.ok(getTraceparent());

      await h.telemetry.shutdown();
      assert.equal(getTraceparent(), undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Lifecycle: shutdown, abandonment, resilience
  // --------------------------------------------------------------------------

  describe("lifecycle", () => {
    test("abandonment: open spans are ended with executant.aborted=true on shutdown", async () => {
      const h = await makeTelemetry();
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
      ]);
      await h.telemetry.shutdown();

      assert.equal(h.spans().length, 2);
      assert.equal(h.span("step-a").attributes["executant.aborted"], true);
      assert.equal(
        h.span("executant.run").attributes["executant.aborted"],
        true,
      );
    });

    test("shutdown stamps accumulated cost onto abandoned root and step spans", async () => {
      const h = await makeTelemetry();
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(1, "step-b"),
        { type: "output:cost", index: 1, usd: 0.002 },
        complete(1, "step-b"),
        start(0, "step-a"),
        // Healing cost lands mid-step; then the run dies (fatal error/SIGINT)
        // before step:complete or workflow:complete ever fire.
        { type: "output:cost", index: 0, usd: 0.003 },
      ]);
      await h.telemetry.shutdown();

      const root = h.span("executant.run");
      assert.equal(root.attributes["executant.aborted"], true);
      approx(root.attributes["executant.cost.total.usd"], 0.005);
      const stepA = h.span("step-a");
      assert.equal(stepA.attributes["executant.aborted"], true);
      approx(stepA.attributes["executant.cost.usd"], 0.003);
    });

    test("shutdown is idempotent and observe afterwards is a safe no-op", async () => {
      const h = await makeTelemetry();
      observeAll(h.telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        complete(0, "step-a"),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await h.telemetry.shutdown();
      const spanCount = h.spans().length;

      await h.telemetry.shutdown(); // second call resolves without effect
      assert.doesNotThrow(() =>
        h.telemetry.observe({ type: "workflow:start", workflow: WORKFLOW }),
      );
      assert.equal(h.spans().length, spanCount, "no spans after shutdown");
      assert.equal(getTraceparent(), undefined);
    });

    test("observe swallows a synchronous reducer fault and keeps the run alive", async () => {
      const h = await makeTelemetry();
      h.telemetry.observe({ type: "workflow:start", workflow: WORKFLOW });

      // Fault on the synchronous path observe() actually executes: step-b is
      // a claude step without a provider field, so stepAttributes calls
      // resolveAgentProvider, which throws on an invalid EXECUTANT_PROVIDER.
      const original = process.env["EXECUTANT_PROVIDER"];
      process.env["EXECUTANT_PROVIDER"] = "bogus";
      try {
        assert.doesNotThrow(() => h.telemetry.observe(start(1, "step-b")));
      } finally {
        if (original === undefined) delete process.env["EXECUTANT_PROVIDER"];
        else process.env["EXECUTANT_PROVIDER"] = original;
      }

      // The faulted event is dropped, but the observer keeps working.
      observeAll(h.telemetry, [
        start(0, "step-a"),
        complete(0, "step-a"),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await h.telemetry.shutdown();

      assert.equal(h.span("executant.run").status.code, h.statusCode.OK);
      assert.equal(h.span("step-a").status.code, h.statusCode.OK);
    });

    test("shutdown still resolves with a broken exporter", async () => {
      const broken = {
        export: () => {
          throw new Error("exporter boom");
        },
        shutdown: () => Promise.reject(new Error("shutdown boom")),
        forceFlush: () => Promise.reject(new Error("flush boom")),
      };
      // Inject a working in-memory metric reader so only the span path breaks.
      const metricsSdk = await import("@opentelemetry/sdk-metrics");
      const telemetry = await createTelemetry("task.yaml", {
        spanExporter: broken,
        metricReader: new metricsSdk.PeriodicExportingMetricReader({
          exporter: new metricsSdk.InMemoryMetricExporter(
            metricsSdk.AggregationTemporality.CUMULATIVE,
          ),
          exportIntervalMillis: 3_600_000,
        }),
      });
      assert.ok(telemetry);

      observeAll(telemetry, [
        { type: "workflow:start", workflow: WORKFLOW },
        start(0, "step-a"),
        complete(0, "step-a"),
        { type: "workflow:complete", workflow: WORKFLOW, durationMs: 50 },
      ]);
      await telemetry.shutdown(); // swallows rejections; never hangs
    });
  });
});
