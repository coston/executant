import { spawn } from "node:child_process";

// One candidate per platform's usual clipboard bridge. Linux has no single
// standard, so both the Wayland and X11 tools are tried in order; the first
// one present on PATH wins.
const CANDIDATES: Record<string, Array<{ cmd: string; args: string[] }>> = {
  darwin: [{ cmd: "pbcopy", args: [] }],
  linux: [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ],
};

/**
 * Copies text to the system clipboard by piping it into a platform clipboard
 * tool. Returns false (never throws) when no such tool is on PATH or the
 * write fails, so callers can show a fallback message instead of crashing
 * the TUI.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const { cmd, args } of CANDIDATES[process.platform] ?? []) {
    if (await tryCopy(cmd, args, text)) return true;
  }
  return false;
}

function tryCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {
      // Writing to a process that failed to spawn also fires here; the
      // 'error' listener above already resolves(false) in that case.
    });
    child.stdin.end(text);
  });
}
