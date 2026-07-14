// ============================================================================
// TELEMETRY E2E TEST (real OTLP/HTTP export)
// ============================================================================
// Proves the full pipeline with no OTel mocks: a local node:http server
// captures OTLP/HTTP+JSON POST bodies, createTelemetry builds the real OTLP
// exporters from OTEL_EXPORTER_OTLP_ENDPOINT, and a real runWorkflow with
// script-only steps (echo — no claude binary needed) is teed through the
// observer. Flush-on-shutdown must deliver both traces and metrics.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createTelemetry } from "../telemetry.js";
import { runWorkflow } from "../runner.js";
import { withLogger } from "../logger.js";
import { setTraceparent } from "../lib/trace-context.js";
import { CURRENT_VERSION } from "../version.js";
import type { Workflow } from "../types.js";

// ----------------------------------------------------------------------------
// OTLP/HTTP+JSON body shapes (the subset these assertions need)
// ----------------------------------------------------------------------------

interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string };
}
interface OtlpSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
}
interface OtlpTraceBody {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpKeyValue[] };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}
interface OtlpMetricBody {
  resourceMetrics?: Array<{
    scopeMetrics?: Array<{ metrics?: Array<{ name: string }> }>;
  }>;
}

interface Capture {
  path: string;
  body: unknown;
}

/** Starts an HTTP server that records every JSON POST body it receives. */
function startCaptureServer(
  captures: Capture[],
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captures.push({
        path: req.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePort({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

const WORKFLOW: Workflow = {
  goal: "e2e telemetry",
  tasks: [
    { type: "command", name: "echo-one", command: "echo one" },
    { type: "command", name: "echo-two", command: "echo two" },
  ],
};

describe("telemetry e2e (real OTLP/HTTP export)", { concurrency: 1 }, () => {
  const SCRUBBED = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    // The signal-specific endpoints take precedence over the generic one in
    // the OTLP exporters — a developer's shell config would redirect the
    // export away from the test's capture server (and leak test telemetry).
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_SERVICE_NAME",
  ];
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(SCRUBBED.map((k) => [k, process.env[k]]));
    SCRUBBED.forEach((k) => delete process.env[k]);
    setTraceparent(undefined);
  });

  afterEach(() => {
    SCRUBBED.forEach((k) => {
      const v = originalEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    setTraceparent(undefined);
  });

  test("a real run exports executant.run + step spans and metrics via OTLP", async () => {
    const captures: Capture[] = [];
    const { server, port } = await startCaptureServer(captures);
    try {
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = `http://127.0.0.1:${port}`;
      const telemetry = await createTelemetry("e2e-task.yaml");
      assert.ok(telemetry, "telemetry enabled by the endpoint env var");

      for await (const event of withLogger(runWorkflow(WORKFLOW), telemetry)) {
        void event; // drain the real event stream through the observer tee
      }
      await telemetry.shutdown(); // flush-on-shutdown must deliver everything

      // ---- traces ----------------------------------------------------------
      const traceBodies = captures
        .filter((c) => c.path === "/v1/traces")
        .map((c) => c.body as OtlpTraceBody);
      assert.ok(traceBodies.length > 0, "at least one OTLP trace export");

      const resourceSpans = traceBodies.flatMap((b) => b.resourceSpans ?? []);
      const spans = resourceSpans
        .flatMap((rs) => rs.scopeSpans ?? [])
        .flatMap((ss) => ss.spans ?? []);
      const names = spans.map((s) => s.name);
      assert.ok(names.includes("executant.run"), `spans: ${names.join(", ")}`);
      assert.ok(names.includes("echo-one"));
      assert.ok(names.includes("echo-two"));

      const root = spans.find((s) => s.name === "executant.run");
      assert.ok(root);
      spans
        .filter((s) => s.name.startsWith("echo-"))
        .forEach((step) =>
          assert.equal(
            step.parentSpanId,
            root.spanId,
            "step spans are children of executant.run",
          ),
        );

      const resourceAttrs = resourceSpans.flatMap(
        (rs) => rs.resource?.attributes ?? [],
      );
      const serviceNames = resourceAttrs
        .filter((a) => a.key === "service.name")
        .map((a) => a.value.stringValue);
      assert.ok(
        serviceNames.every((n) => n === "executant") && serviceNames.length > 0,
        `expected service.name "executant", got: ${serviceNames.join(", ")}`,
      );

      const serviceVersions = resourceAttrs
        .filter((a) => a.key === "service.version")
        .map((a) => a.value.stringValue);
      assert.ok(
        serviceVersions.length > 0 &&
          serviceVersions.every((v) => v === CURRENT_VERSION),
        `expected service.version "${CURRENT_VERSION}", got: ${serviceVersions.join(", ")}`,
      );

      // ---- metrics ---------------------------------------------------------
      const metricNames = captures
        .filter((c) => c.path === "/v1/metrics")
        .map((c) => c.body as OtlpMetricBody)
        .flatMap((b) => b.resourceMetrics ?? [])
        .flatMap((rm) => rm.scopeMetrics ?? [])
        .flatMap((sm) => sm.metrics ?? [])
        .map((m) => m.name);
      assert.ok(
        metricNames.includes("executant.step.duration"),
        `metrics: ${metricNames.join(", ")}`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  test("OTEL_SERVICE_NAME overrides the exported service.name", async () => {
    const captures: Capture[] = [];
    const { server, port } = await startCaptureServer(captures);
    try {
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = `http://127.0.0.1:${port}`;
      process.env["OTEL_SERVICE_NAME"] = "my-pipeline";
      const telemetry = await createTelemetry("e2e-task.yaml");
      assert.ok(telemetry);

      for await (const event of withLogger(runWorkflow(WORKFLOW), telemetry)) {
        void event;
      }
      await telemetry.shutdown();

      const serviceNames = captures
        .filter((c) => c.path === "/v1/traces")
        .map((c) => c.body as OtlpTraceBody)
        .flatMap((b) => b.resourceSpans ?? [])
        .flatMap((rs) => rs.resource?.attributes ?? [])
        .filter((a) => a.key === "service.name")
        .map((a) => a.value.stringValue);
      assert.ok(serviceNames.length > 0);
      assert.ok(serviceNames.every((n) => n === "my-pipeline"));
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });
});
