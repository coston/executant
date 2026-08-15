// ============================================================================
// USE OUTPUT RESIZE — scroll + resize (keyboard and mouse) for the output pane
// ============================================================================
// Owns two related pieces of interaction state for the live output pane:
//   - scrollOffset: lines back from the live tail (the caller resets this
//     whenever the active step changes, so a new step always starts pinned
//     to its own tail).
//   - outputRows: the pane's current content-line height. Starts out tied to
//     `autoMaxRows` (the caller's auto-sizing budget for this frame); once
//     the user resizes by keyboard or mouse, it detaches and stays fixed for
//     the rest of the run — still clamped into [MIN_OUTPUT_ROWS, autoMaxRows]
//     so a shrinking terminal can never make it overflow.
//
// Keyboard is the reliable path (`[`/`]` resize, arrows/j-k/PageUp/PageDown
// scroll) and works in every terminal. Mouse drag-to-resize on the pane's
// bottom border is best-effort: Ink has no public API for raw stdin bytes or
// on-screen row position, so this reaches into `internal_eventEmitter` (the
// same undocumented channel `useInput` itself is built on — see
// node_modules/ink/build/hooks/use-input.js) to see raw chunks, and
// calibrates the frame's on-screen origin row via a DSR cursor-position query
// (see mouseResize.ts for the math). If a terminal doesn't answer that query
// within CALIBRATION_TIMEOUT_MS, mouse resize silently stays unavailable —
// keyboard resize always still works regardless.

import { useCallback, useEffect, useRef, useState } from "react";
import { useInput, useStdin, useStdout } from "ink";
import { clamp, MIN_OUTPUT_ROWS } from "./utils.js";
import {
  applyDragDelta,
  computeOriginRow,
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  isOnBorderRow,
  parseCursorPositionReport,
  parseSgrMouseEvents,
  REQUEST_CURSOR_POSITION,
} from "./mouseResize.js";

const RESIZE_STEP = 1;
const SCROLL_STEP = 1;
const SCROLL_PAGE = 10;
/** Rows of slack around the exact border row a mouse-down still counts as a grab. */
const GRAB_TOLERANCE = 1;
const CALIBRATION_TIMEOUT_MS = 500;

interface Options {
  /** Content-line height the output pane would get if purely auto-sized this frame. */
  autoMaxRows: number;
  /** True while the output pane is on screen and should own keyboard/mouse input. */
  enabled: boolean;
  /**
   * Rows rendered above the pane's top border this frame: outer top padding,
   * brand, header, the full step list, iteration rows, the step list's
   * bottom margin, and the pane's own top margin. Must stay in sync with
   * App.tsx's layout — see the comment above FIXED_OVERHEAD there.
   */
  rowsAboveOutputPane: number;
  /**
   * Rows rendered below the pane's bottom border this frame: footer margin,
   * the hint line, and whichever of the update banner / statusline /
   * interject input are currently showing, plus outer bottom padding.
   */
  rowsBelowOutputPane: number;
}

interface Result {
  /** The pane's current content-line height — already clamped and ready to render. */
  outputRows: number;
  scrollOffset: number;
  resetScroll: () => void;
}

export function useOutputResize({
  autoMaxRows,
  enabled,
  rowsAboveOutputPane,
  rowsBelowOutputPane,
}: Options): Result {
  // The user's resize preference, in content-line rows. Null = not yet
  // resized, i.e. still tracking autoMaxRows every frame.
  const [preference, setPreference] = useState<number | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const { stdout } = useStdout();
  const { internal_eventEmitter, isRawModeSupported } = useStdin();

  const resetScroll = useCallback(() => setScrollOffset(0), []);

  const currentRows = clamp(
    preference ?? autoMaxRows,
    MIN_OUTPUT_ROWS,
    autoMaxRows,
  );
  const bottomBorderRow = rowsAboveOutputPane + 1 + currentRows;
  const totalFrameHeight = bottomBorderRow + 1 + rowsBelowOutputPane;

  // ----------------------------------------------------------------------
  // Keyboard: scroll + resize. Always the reliable path.
  // ----------------------------------------------------------------------
  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setScrollOffset((o) => o + SCROLL_STEP);
      else if (key.downArrow || input === "j")
        setScrollOffset((o) => Math.max(0, o - SCROLL_STEP));
      else if (key.pageUp) setScrollOffset((o) => o + SCROLL_PAGE);
      else if (key.pageDown)
        setScrollOffset((o) => Math.max(0, o - SCROLL_PAGE));
      else if (input === "[")
        setPreference(
          clamp(currentRows - RESIZE_STEP, MIN_OUTPUT_ROWS, autoMaxRows),
        );
      else if (input === "]")
        setPreference(
          clamp(currentRows + RESIZE_STEP, MIN_OUTPUT_ROWS, autoMaxRows),
        );
    },
    { isActive: enabled },
  );

  // ----------------------------------------------------------------------
  // Mouse: best-effort drag-to-resize on the bottom border.
  // ----------------------------------------------------------------------
  // Absolute terminal row of this frame's first line, once calibrated via a
  // DSR round trip. Null until calibrated (or if the terminal never replies).
  const originRowRef = useRef<number | null>(null);
  const dragRef = useRef<{ startY: number; startRows: number } | null>(null);
  const pendingCalibrationRef = useRef<{
    frameHeight: number;
    timeout: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Always holds the latest computed frame height so the calibration effect
  // (which intentionally only re-fires on mount/resize, not every frame) can
  // read a fresh value at the moment it actually queries the cursor position.
  const totalFrameHeightRef = useRef(totalFrameHeight);
  totalFrameHeightRef.current = totalFrameHeight;

  useEffect(() => {
    if (!enabled || !isRawModeSupported || !stdout) return;

    const calibrate = () => {
      if (pendingCalibrationRef.current)
        clearTimeout(pendingCalibrationRef.current.timeout);
      pendingCalibrationRef.current = {
        frameHeight: totalFrameHeightRef.current,
        timeout: setTimeout(() => {
          pendingCalibrationRef.current = null;
        }, CALIBRATION_TIMEOUT_MS),
      };
      stdout.write(REQUEST_CURSOR_POSITION);
    };

    stdout.write(ENABLE_MOUSE_TRACKING);
    calibrate();
    const onResize = () => {
      originRowRef.current = null;
      calibrate();
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      stdout.write(DISABLE_MOUSE_TRACKING);
      if (pendingCalibrationRef.current)
        clearTimeout(pendingCalibrationRef.current.timeout);
    };
    // Deliberately omits totalFrameHeight/currentRows — calibration re-runs
    // only on mount and terminal resize, since the frame's origin row does
    // not move just because the step list or pane grew/shrank in place.
    // `calibrate` reads the live value via totalFrameHeightRef instead.
  }, [enabled, isRawModeSupported, stdout]);

  useEffect(() => {
    if (!enabled || !isRawModeSupported || !internal_eventEmitter) return;

    const handleInput = (chunk: string) => {
      const cursorReport = parseCursorPositionReport(chunk);
      if (cursorReport && pendingCalibrationRef.current) {
        originRowRef.current = computeOriginRow(
          cursorReport.row,
          pendingCalibrationRef.current.frameHeight,
        );
        clearTimeout(pendingCalibrationRef.current.timeout);
        pendingCalibrationRef.current = null;
      }

      const origin = originRowRef.current;
      if (origin == null) return;

      for (const event of parseSgrMouseEvents(chunk)) {
        if (event.type === "down" && event.button === 0) {
          if (
            isOnBorderRow(event.y, origin + bottomBorderRow, GRAB_TOLERANCE)
          ) {
            dragRef.current = { startY: event.y, startRows: currentRows };
          }
          continue;
        }
        if (!dragRef.current) continue;
        if (event.type === "move") {
          setPreference(
            applyDragDelta(
              dragRef.current.startRows,
              event.y - dragRef.current.startY,
              MIN_OUTPUT_ROWS,
              autoMaxRows,
            ),
          );
        } else if (event.type === "up") {
          dragRef.current = null;
        }
      }
    };

    internal_eventEmitter.on("input", handleInput);
    return () => {
      internal_eventEmitter.removeListener("input", handleInput);
    };
  }, [
    enabled,
    isRawModeSupported,
    internal_eventEmitter,
    bottomBorderRow,
    currentRows,
    autoMaxRows,
  ]);

  return { outputRows: currentRows, scrollOffset, resetScroll };
}
