// ============================================================================
// EVAL CONTAINER — unit tests
// ============================================================================

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildDockerArgs,
  DOCKER_IMAGE,
  isDockerEnabled,
} from "../eval/container.js";

// ----------------------------------------------------------------------------
// isDockerEnabled
// ----------------------------------------------------------------------------

describe("isDockerEnabled", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env["EVAL_DOCKER"];
  });

  afterEach(() => {
    if (original === undefined) delete process.env["EVAL_DOCKER"];
    else process.env["EVAL_DOCKER"] = original;
  });

  test("returns false when EVAL_DOCKER is not set", () => {
    delete process.env["EVAL_DOCKER"];
    assert.equal(isDockerEnabled(), false);
  });

  test("returns false when EVAL_DOCKER is '0'", () => {
    process.env["EVAL_DOCKER"] = "0";
    assert.equal(isDockerEnabled(), false);
  });

  test("returns false when EVAL_DOCKER is empty string", () => {
    process.env["EVAL_DOCKER"] = "";
    assert.equal(isDockerEnabled(), false);
  });

  test("returns true when EVAL_DOCKER is '1'", () => {
    process.env["EVAL_DOCKER"] = "1";
    assert.equal(isDockerEnabled(), true);
  });
});

// ----------------------------------------------------------------------------
// buildDockerArgs
// ----------------------------------------------------------------------------

describe("buildDockerArgs", () => {
  const base = {
    workdir: "/tmp/eval-test",
    env: { ANTHROPIC_API_KEY: "sk-test", HOME: "/root", PATH: "/usr/bin" },
    cmd: ["node", "src/index.ts", "--ci", "task.yaml"],
  };

  test("starts with 'run --rm'", () => {
    const args = buildDockerArgs(base);
    assert.equal(args[0], "run");
    assert.equal(args[1], "--rm");
  });

  test("mounts workdir at /workspace with :rw", () => {
    const args = buildDockerArgs(base);
    const idx = args.indexOf("--volume");
    assert.ok(idx !== -1, "missing --volume");
    assert.ok(
      args.slice(idx).some((a) => a === "/tmp/eval-test:/workspace:rw"),
      "workdir must be mounted as /workspace:rw",
    );
  });

  test("sets --workdir /workspace", () => {
    const args = buildDockerArgs(base);
    const idx = args.indexOf("--workdir");
    assert.ok(idx !== -1, "missing --workdir");
    assert.equal(args[idx + 1], "/workspace");
  });

  test("passes ANTHROPIC_API_KEY when present", () => {
    const args = buildDockerArgs(base);
    assert.ok(
      args.some((a) => a === "ANTHROPIC_API_KEY=sk-test"),
      "ANTHROPIC_API_KEY must be forwarded",
    );
  });

  test("does not forward HOME or PATH (not in passthrough list)", () => {
    const args = buildDockerArgs(base);
    assert.ok(
      !args.some((a) => a.startsWith("HOME=")),
      "HOME must not be forwarded",
    );
    assert.ok(
      !args.some((a) => a.startsWith("PATH=")),
      "PATH must not be forwarded",
    );
  });

  test("includes --add-host host.docker.internal:host-gateway", () => {
    const args = buildDockerArgs(base);
    const idx = args.indexOf("--add-host");
    assert.ok(idx !== -1, "missing --add-host");
    assert.equal(args[idx + 1], "host.docker.internal:host-gateway");
  });

  test("places DOCKER_IMAGE before cmd args", () => {
    const args = buildDockerArgs(base);
    const imageIdx = args.indexOf(DOCKER_IMAGE);
    assert.ok(imageIdx !== -1, "DOCKER_IMAGE must appear in args");
    const cmdStart = args.lastIndexOf("node");
    assert.ok(imageIdx < cmdStart, "image must appear before cmd");
    assert.deepEqual(args.slice(imageIdx + 1), base.cmd);
  });

  test("includes read-only mounts when provided", () => {
    const args = buildDockerArgs({
      ...base,
      readOnlyMounts: [
        { host: "/repo/src", container: "/app/src" },
        { host: "/repo/node_modules", container: "/workspace/node_modules" },
      ],
    });
    assert.ok(
      args.some((a) => a === "/repo/src:/app/src:ro"),
      "first read-only mount missing",
    );
    assert.ok(
      args.some((a) => a === "/repo/node_modules:/workspace/node_modules:ro"),
      "second read-only mount missing",
    );
  });

  test("no read-only mounts when readOnlyMounts is omitted", () => {
    const args = buildDockerArgs(base);
    const roMounts = args.filter((a) => a.endsWith(":ro"));
    assert.equal(roMounts.length, 0, "no :ro mounts expected");
  });

  test("only one :rw mount (the workdir)", () => {
    const args = buildDockerArgs(base);
    const rwMounts = args.filter((a) => a.endsWith(":rw"));
    assert.equal(rwMounts.length, 1, "exactly one :rw mount expected");
  });

  test("forwards EXECUTANT_PROVIDER and EXECUTANT_MODEL when set", () => {
    const args = buildDockerArgs({
      ...base,
      env: {
        ...base.env,
        EXECUTANT_PROVIDER: "opencode",
        EXECUTANT_MODEL: "llama-qwen7b/qwen2.5-coder-7b",
      },
    });
    assert.ok(args.some((a) => a === "EXECUTANT_PROVIDER=opencode"));
    assert.ok(
      args.some((a) => a === "EXECUTANT_MODEL=llama-qwen7b/qwen2.5-coder-7b"),
    );
  });
});
