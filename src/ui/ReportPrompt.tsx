// ============================================================================
// REPORT PROMPT
// ============================================================================
// Shown after a successful run, once the free part of the report (duration,
// cost, tokens, overflow) is on screen and no suggestion was already
// generated automatically. Offers the efficiency-suggestion analysis as an
// on-demand action — press `a` to run it, any other key to skip and exit.
// App.tsx only mounts this when the terminal supports raw mode and
// report.suggestion is still unset, so an unattended/CI run never sees it —
// the suggestion call stays strictly opt-in (see report.ts).

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { RunReport, Workflow } from "../types.js";
import { generateEfficiencySuggestion } from "../report.js";
import { formatDuration, formatTokenCount } from "../lib/utils.js";
import { useInterval } from "./useInterval.js";
import { SPINNER } from "./utils.js";

type Phase = "choosing" | "analyzing" | "done" | "failed";

interface Props {
  report: RunReport;
  workflow: Workflow;
  onDone: () => void;
}

export function ReportPrompt({ report, workflow, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>("choosing");
  const [suggestion, setSuggestion] = useState<string | undefined>();
  const [tick, setTick] = useState(0);
  const [analyzeStartMs, setAnalyzeStartMs] = useState<number | undefined>();

  // App's own tick stops once the run ends (state.endTime is set by then),
  // so the spinner needs its own clock — only ticking while it's actually
  // waiting on the analysis call.
  useInterval(() => {
    if (phase === "analyzing") setTick((t) => t + 1);
  }, 100);

  useInput((input) => {
    if (phase === "choosing") {
      if (input.toLowerCase() === "a") {
        setPhase("analyzing");
        setAnalyzeStartMs(Date.now());
        generateEfficiencySuggestion(workflow, report.stepNarrative).then(
          (s) => {
            setSuggestion(s);
            setPhase(s ? "done" : "failed");
          },
        );
        return;
      }
      onDone();
      return;
    }
    if (phase === "done" || phase === "failed") onDone();
    // phase === "analyzing": input is ignored — nothing to cancel mid-flight,
    // the call is already bounded by its own 10-minute timeout.
  });

  const t = report.totalTokens;
  const totalTokens =
    t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
  const elapsed = formatDuration(
    analyzeStartMs ? Date.now() - analyzeStartMs : 0,
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>run report:</Text>
      <Text dimColor>
        {"  "}duration {formatDuration(report.durationMs)} · cost $
        {report.totalCostUsd.toFixed(4)} · tokens{" "}
        {formatTokenCount(totalTokens)}
        {report.overflowCalls > 0
          ? ` (${formatTokenCount(report.overflowTokens)} over 200k in ${report.overflowCalls} call(s))`
          : ""}
      </Text>
      {phase === "choosing" && (
        <Text dimColor>
          {"  "}[a] analyze this run for efficiency improvements · any other key
          to skip
        </Text>
      )}
      {phase === "analyzing" && (
        <Text dimColor>
          {"  "}
          {SPINNER[tick % SPINNER.length]} analyzing… ({elapsed}, up to 10 min)
        </Text>
      )}
      {(phase === "done" || phase === "failed") && (
        <>
          <Text dimColor>
            {"  "}efficiency idea:{" "}
            {suggestion ?? "analysis unavailable — see the log for details"}
          </Text>
          <Text dimColor>{"  "}press any key to exit</Text>
        </>
      )}
    </Box>
  );
}
