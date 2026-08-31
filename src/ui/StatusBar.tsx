// ============================================================================
// STATUS BAR
// ============================================================================
// One dim line above the footer:
//
//   executant   main  ━━━━━━━━━━ 81% 162.2k/200k
//
// The gauge is derived straight from the latest output:context event — how
// full the running session's window is — so it moves as the session grows,
// with no polling of any kind. Each prompt step is its own session and gets
// its own gauge. Only the repo name and branch need I/O, read once at mount.

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import {
  buildGauge,
  contextWindowSize,
  fitRepoLabel,
  readRepoInfo,
  GAUGE_WIDTH,
  type GaugeLevel,
  type RepoInfo,
} from "../lib/statusline.js";
import { theme } from "./theme.js";

const LEVEL_COLOR: Record<GaugeLevel, string> = {
  ok: theme.success,
  warn: theme.warning,
  high: theme.error,
};

// Everything after the repo/branch segment: 2-space gap + the gauge itself +
// " NNN%" (up to 5 chars) + " NNN.Nk/NNNk" (up to 13 chars, generous for a
// 7-digit token count against a "1M" window).
const GAUGE_SEGMENT_WIDTH = 2 + GAUGE_WIDTH + 5 + 13;

interface Props {
  /** Context tokens the running session occupies; 0 before its first turn. */
  tokens: number;
  /** The session's model — sizes the gauge (200k, or 1M for `[1m]`). */
  model: string;
  /** Terminal width, so a long repo name/branch shrinks instead of wrapping onto a second line. */
  columns: number;
}

export function StatusBar({ tokens, model, columns }: Props) {
  const [repo, setRepo] = useState<RepoInfo | undefined>(undefined);

  useEffect(() => {
    let active = true;
    readRepoInfo(process.cwd())
      .then((info) => {
        if (active) setRepo(info);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const gauge = buildGauge(tokens, contextWindowSize(model));
  const level = LEVEL_COLOR[gauge.level];
  const fitted = repo && fitRepoLabel(repo, columns - GAUGE_SEGMENT_WIDTH);

  return (
    <Box>
      {fitted && <Text color={theme.primary}> {fitted.name}</Text>}
      {fitted?.branch && (
        <Text color={theme.primaryLight}>
          {"   "}
          {fitted.branch}
        </Text>
      )}
      <Text>{"  "}</Text>
      <Text color={level}>{gauge.filled}</Text>
      <Text color={theme.border}>{gauge.empty}</Text>
      <Text color={level}> {gauge.pct}%</Text>
      <Text color={theme.muted}>
        {" "}
        {gauge.used}/{gauge.limit}
      </Text>
    </Box>
  );
}
