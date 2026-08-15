// ============================================================================
// MOUSE RESIZE — pure parsing + math for terminal mouse drag-to-resize
// ============================================================================
// Ink has no concept of mouse input or on-screen element position — it only
// ever writes a stream of text. Everything here is the small amount of raw
// ANSI/VT protocol needed to bolt SGR mouse reporting onto it:
//
//   - SGR mouse sequences (`\x1b[<Cb;Cx;CyM` / `...m`) report clicks/drags
//     as (button, absolute column, absolute row) in the terminal viewport.
//   - A cursor position report (`\x1b[{row};{col}R`, the terminal's reply to
//     a `\x1b[6n` query) is the only way to learn where Ink's own frame
//     starts, since Ink never clears the screen or tracks screen position.
//
// Everything in this file is a pure function so the parsing/math can be unit
// tested without a real terminal; `useOutputResize.ts` is the only caller,
// and it owns all the actual stdin/stdout I/O.

/** Enables SGR (extended-coordinate) mouse button + motion reporting. */
export const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
/** Restores the terminal's normal mouse behavior (text selection, etc). */
export const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1006l";
/** Device Status Report query — the terminal replies with a cursor position report. */
export const REQUEST_CURSOR_POSITION = "\x1b[6n";

type MouseEventType = "down" | "up" | "move";

interface ParsedMouseEvent {
  /** 0 = left, 1 = middle, 2 = right; meaningless (no button held) during a bare "move". */
  button: number;
  /** 1-based column, absolute within the terminal viewport. */
  x: number;
  /** 1-based row, absolute within the terminal viewport. */
  y: number;
  type: MouseEventType;
}

const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Extracts every SGR mouse event present in a raw stdin chunk, in order. */
export function parseSgrMouseEvents(chunk: string): ParsedMouseEvent[] {
  const events: ParsedMouseEvent[] = [];
  SGR_MOUSE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE_RE.exec(chunk))) {
    const cb = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const isRelease = match[4] === "m";
    const isMotion = (cb & 32) !== 0;
    events.push({
      button: cb & 3,
      x,
      y,
      type: isRelease ? "up" : isMotion ? "move" : "down",
    });
  }
  return events;
}

const CURSOR_POSITION_RE = /\x1b\[(\d+);(\d+)R/;

/** Parses a terminal's reply to `REQUEST_CURSOR_POSITION`, if present in the chunk. */
export function parseCursorPositionReport(
  chunk: string,
): { row: number; col: number } | null {
  const match = CURSOR_POSITION_RE.exec(chunk);
  if (!match) return null;
  return { row: Number(match[1]), col: Number(match[2]) };
}

/**
 * Ink's renderer (`log-update`) writes the whole frame followed by a single
 * trailing newline on every render, which leaves the terminal cursor one row
 * below the frame's last line. Given the cursor's reported row right after a
 * render and that render's known height, the frame's first row can be
 * recovered — the one thing Ink itself never exposes.
 */
export function computeOriginRow(
  cursorRowAfterRender: number,
  frameHeightAtThatRender: number,
): number {
  return cursorRowAfterRender - frameHeightAtThatRender;
}

/** Whether an absolute row `y` is within `tolerance` rows of the grabbable border. */
export function isOnBorderRow(
  y: number,
  borderRow: number,
  tolerance: number,
): boolean {
  return Math.abs(y - borderRow) <= tolerance;
}

/** New content-line height for a drag that has moved `deltaRows` since the grab, clamped. */
export function applyDragDelta(
  startRows: number,
  deltaRows: number,
  min: number,
  max: number,
): number {
  return Math.min(Math.max(startRows + deltaRows, min), Math.max(min, max));
}
