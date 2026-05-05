// ============================================================================
// THEME — Purple dark theme sourced from @coston/design-tokens
// ============================================================================
// Edit this file to change the color palette. Colors are derived from
// @coston/design-tokens tokens.json (purple-dark theme) and converted to hex
// for use as Ink color props. To adopt a different theme, change THEME_NAME
// to one of: light | dark | forest | forest-dark | purple | purple-dark |
// monochrome | monochrome-dark
// ============================================================================

import { createRequire } from 'node:module';
import { oklchToHex } from '@coston/design-tokens';

const THEME_NAME = 'purple-dark';

const _require = createRequire(import.meta.url);
const { themes } = _require('@coston/design-tokens/tokens.json') as {
  themes: Record<string, Record<string, string>>;
};

function hex(key: string): string {
  return oklchToHex(themes[THEME_NAME][key]);
}

export const theme = {
  foreground:   hex('foreground'),           // primary text
  muted:        hex('muted-foreground'),     // dimmed / inactive text and borders
  primary:      hex('primary'),              // tool calls, cursor, active
  primaryLight: hex('secondary-foreground'), // lighter tint of primary (same hue, higher lightness)
  success:      hex('success'),              // completed steps
  error:        hex('destructive'),          // errors
  warning:      hex('warning'),              // warnings, retries, updates
  border:       hex('border'),               // log pane border
} as const;

export type Theme = typeof theme;
