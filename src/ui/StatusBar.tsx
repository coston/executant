// ============================================================================
// STATUS BAR
// ============================================================================
// One dim line above the footer:
//
//   executant   main  ━━━━━━━━━━ 81% 162.2k/200k
//
// The gauge is derived straight from the latest output:usage event, so it
// moves as each step finishes with no polling of any kind. Only the repo name
// and branch need I/O, and they are read once at mount.

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { TokenUsage } from "../types.js";
import {
  buildGauge,
  contextTokens,
  contextWindowSize,
  readRepoInfo,
  type GaugeLevel,
  type RepoInfo,
} from "../lib/statusline.js";
import { theme } from "./theme.js";

const LEVEL_COLOR: Record<GaugeLevel, string> = {
  ok: theme.success,
  warn: theme.warning,
  high: theme.error,
};

interface Props {
  /** Token usage from the most recent Claude invocation, if any has finished. */
  usage: TokenUsage | undefined;
  /** The running step's model — sizes the gauge (200k, or 1M for `[1m]`). */
  model: string;
}

export function StatusBar({ usage, model }: Props) {
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

  const gauge = buildGauge(contextTokens(usage), contextWindowSize(model));
  const level = LEVEL_COLOR[gauge.level];

  return (
    <Box>
      {repo && <Text color={theme.primary}> {repo.name}</Text>}
      {repo?.branch && (
        <Text color={theme.primaryLight}>
          {"   "}
          {repo.branch}
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
