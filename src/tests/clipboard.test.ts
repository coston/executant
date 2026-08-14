// ============================================================================
// CLIPBOARD — unit tests
// ============================================================================
// Exercises copyToClipboard against fake executables on PATH rather than the
// real system clipboard, so the suite is deterministic and headless-safe.
// process.platform is swapped per test (it's configurable, see the assertion
// below) to cover both the darwin and linux candidate lists from one host.

import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach } from "node:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyToClipboard } from "../lib/clipboard.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
assert.ok(
  platformDescriptor?.configurable,
  "process.platform must be configurable for this suite",
);

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value });
}

let binDir: string;
let originalPath: string | undefined;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "executant-clipboard-"));
  originalPath = process.env.PATH;
  // Isolated on purpose: real clipboard tools on the host PATH (e.g. this
  // machine's own wl-copy) would otherwise shadow the stubs below and make
  // the "tool absent" cases flaky.
  process.env.PATH = binDir;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
  if (platformDescriptor)
    Object.defineProperty(process, "platform", platformDescriptor);
});

/**
 * Writes an executable stub that captures its stdin to `outFile`. Shebangs
 * to the running node binary's absolute path so it resolves without PATH
 * (the isolated test PATH deliberately excludes `env`/`node`'s directory).
 */
function installStub(name: string, outFile: string) {
  const path = join(binDir, name);
  writeFileSync(
    path,
    `#!${process.execPath}\nlet data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{require("fs").writeFileSync(${JSON.stringify(outFile)},data);process.exit(0);});\n`,
  );
  chmodSync(path, 0o755);
}

describe("copyToClipboard", () => {
  test("pipes text into pbcopy on darwin", async () => {
    setPlatform("darwin");
    const outFile = join(binDir, "out.txt");
    installStub("pbcopy", outFile);

    const ok = await copyToClipboard("hello from the retrospective");
    assert.equal(ok, true);
    assert.equal(readFileSync(outFile, "utf8"), "hello from the retrospective");
  });

  test("falls through to the first available linux tool", async () => {
    setPlatform("linux");
    const outFile = join(binDir, "out.txt");
    // wl-copy (tried first) is absent; xclip is installed.
    installStub("xclip", outFile);

    const ok = await copyToClipboard("some text");
    assert.equal(ok, true);
    assert.equal(readFileSync(outFile, "utf8"), "some text");
  });

  test("returns false when no clipboard tool is on PATH", async () => {
    setPlatform("linux");
    const ok = await copyToClipboard("nothing to copy to");
    assert.equal(ok, false);
  });

  test("returns false on an unrecognized platform", async () => {
    setPlatform("sunos");
    const ok = await copyToClipboard("text");
    assert.equal(ok, false);
  });
});
