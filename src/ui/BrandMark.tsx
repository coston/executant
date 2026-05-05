// ============================================================================
// BRAND MARK — animated "Executant" header
// ============================================================================
// When active: a single-character hotspot of theme.primaryLight sweeps
// left→right over a theme.primary base, with a long gap between sweeps.
// When idle/complete: all letters show in theme.primary+bold.
// Colors use design tokens exclusively (no hardcoded hex).

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

const BRAND = 'Executant';
const SWEEP_TICKS = BRAND.length * 2; // 2 ticks per character position
const GAP_TICKS = 30;                 // long pause between sweeps
export const CYCLE = SWEEP_TICKS + GAP_TICKS;

export function charColor(charIndex: number, tick: number, isActive: boolean): string {
  if (!isActive) return theme.primary;
  const pos = tick % CYCLE;
  if (pos >= SWEEP_TICKS) return theme.primary; // gap phase
  const charPos = Math.floor(pos / 2);          // hotspot advances every 2 ticks
  return charIndex === charPos ? theme.primaryLight : theme.primary;
}

interface Props {
  tick: number;
  isActive: boolean;
}

export function BrandMark({ tick, isActive }: Props) {
  return (
    <Box>
      {[...BRAND].map((char, i) => (
        <Text key={i} color={charColor(i, tick, isActive)} bold>{char}</Text>
      ))}
    </Box>
  );
}
