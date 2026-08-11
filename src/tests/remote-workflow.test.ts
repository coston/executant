import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  fetchWorkflowSource,
  isRemoteWorkflow,
  resolveWorkflowRef,
  toRawUrl,
  workflowTaskName,
} from "../lib/remote-workflow.js";

// ============================================================================
// isRemoteWorkflow
// ============================================================================

test("isRemoteWorkflow detects http(s) URLs only", () => {
  assert.equal(isRemoteWorkflow("https://example.com/a.yaml"), true);
  assert.equal(isRemoteWorkflow("http://example.com/a.yaml"), true);
  assert.equal(isRemoteWorkflow("a.yaml"), false);
  assert.equal(isRemoteWorkflow("./tasks/a.yaml"), false);
  assert.equal(isRemoteWorkflow("/abs/path/a.yaml"), false);
  assert.equal(isRemoteWorkflow("./http-server/a.yaml"), false);
});

// ============================================================================
// toRawUrl
// ============================================================================

test("toRawUrl rewrites a GitHub blob URL", () => {
  assert.equal(
    toRawUrl("https://github.com/o/r/blob/main/tasks/foo.yaml"),
    "https://raw.githubusercontent.com/o/r/main/tasks/foo.yaml",
  );
});

test("toRawUrl handles refs and paths containing slashes", () => {
  assert.equal(
    toRawUrl("https://github.com/o/r/blob/feature/x/a/b/c.yaml"),
    "https://raw.githubusercontent.com/o/r/feature/x/a/b/c.yaml",
  );
});

test("toRawUrl rewrites a gist page URL", () => {
  assert.equal(
    toRawUrl("https://gist.github.com/user/abc123"),
    "https://gist.githubusercontent.com/user/abc123/raw",
  );
});

test("toRawUrl leaves already-raw and non-GitHub URLs unchanged", () => {
  const raw = "https://raw.githubusercontent.com/o/r/main/a.yaml";
  assert.equal(toRawUrl(raw), raw);
  const other = "https://example.com/tasks/a.yaml";
  assert.equal(toRawUrl(other), other);
  // A GitHub URL that is not a blob path is passed through untouched.
  const repo = "https://github.com/o/r";
  assert.equal(toRawUrl(repo), repo);
});

test("toRawUrl returns unparseable input unchanged", () => {
  assert.equal(toRawUrl("not a url"), "not a url");
});

// ============================================================================
// workflowTaskName
// ============================================================================

test("workflowTaskName uses the basename of paths and URLs", () => {
  assert.equal(workflowTaskName("./tasks/deploy.yaml"), "deploy.yaml");
  assert.equal(
    workflowTaskName("https://raw.githubusercontent.com/o/r/main/deploy.yaml"),
    "deploy.yaml",
  );
  assert.equal(workflowTaskName("https://example.com/"), "remote-workflow");
});

// ============================================================================
// fetchWorkflowSource — fetch is stubbed; no network, no `gh` invocation.
// ============================================================================

type Captured = { url: string; headers: Record<string, string> };

function stubFetch(
  response: {
    ok: boolean;
    status?: number;
    statusText?: string;
    body?: string;
  },
  captured: Captured[],
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: response.ok,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      text: async () => response.body ?? "",
    };
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("fetchWorkflowSource returns the body on success", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(
    { ok: true, body: "goal: hi\nsteps: []\n" },
    captured,
  );
  try {
    const body = await fetchWorkflowSource(
      "https://example.com/a.yaml",
      () => undefined,
    );
    assert.equal(body, "goal: hi\nsteps: []\n");
  } finally {
    restore();
  }
});

test("fetchWorkflowSource sends the gh token to GitHub raw hosts", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(
    { ok: true, body: "goal: x\nsteps: []\n" },
    captured,
  );
  try {
    await fetchWorkflowSource(
      "https://gist.githubusercontent.com/u/id/raw",
      () => "tok_123",
    );
    assert.equal(captured[0]?.headers["Authorization"], "Bearer tok_123");
  } finally {
    restore();
  }
});

test("fetchWorkflowSource never sends the token to non-GitHub hosts", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch({ ok: true, body: "" }, captured);
  try {
    await fetchWorkflowSource("https://example.com/a.yaml", () => "tok_123");
    assert.equal(captured[0]?.headers["Authorization"], undefined);
  } finally {
    restore();
  }
});

test("fetchWorkflowSource hints at gh auth on GitHub 404", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(
    { ok: false, status: 404, statusText: "Not Found" },
    captured,
  );
  try {
    await assert.rejects(
      () =>
        fetchWorkflowSource(
          "https://raw.githubusercontent.com/o/r/main/a.yaml",
          () => undefined,
        ),
      /HTTP 404 Not Found — run "gh auth login"/,
    );
  } finally {
    restore();
  }
});

test("fetchWorkflowSource reports plain status for non-GitHub failures", async () => {
  const captured: Captured[] = [];
  const restore = stubFetch(
    { ok: false, status: 500, statusText: "Server Error" },
    captured,
  );
  try {
    await assert.rejects(
      () => fetchWorkflowSource("https://example.com/a.yaml", () => undefined),
      (err: Error) =>
        /HTTP 500 Server Error/.test(err.message) &&
        !/gh auth login/.test(err.message),
    );
  } finally {
    restore();
  }
});

test("fetchWorkflowSource wraps network errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => fetchWorkflowSource("https://example.com/a.yaml", () => undefined),
      /Cannot fetch workflow from "https:\/\/example.com\/a.yaml": getaddrinfo ENOTFOUND/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ============================================================================
// resolveWorkflowRef
// ============================================================================

test("resolveWorkflowRef: explicit URL is used as-is (rewritten to raw), regardless of origin", () => {
  const result = resolveWorkflowRef(
    { kind: "local", dir: "/home/user/tasks" },
    "https://github.com/o/r/blob/main/child.yaml",
  );
  assert.deepEqual(result, {
    key: "https://raw.githubusercontent.com/o/r/main/child.yaml",
    kind: "remote",
  });
});

test("resolveWorkflowRef: absolute local path under a local origin", () => {
  const result = resolveWorkflowRef(
    { kind: "local", dir: "/home/user/tasks" },
    "/etc/other/child.yaml",
  );
  assert.deepEqual(result, { key: "/etc/other/child.yaml", kind: "local" });
});

test("resolveWorkflowRef: relative path resolves against a local origin's directory", () => {
  const result = resolveWorkflowRef(
    { kind: "local", dir: "/home/user/tasks" },
    "./child.yaml",
  );
  assert.deepEqual(result, {
    key: "/home/user/tasks/child.yaml",
    kind: "local",
  });
});

test("resolveWorkflowRef: relative path with no origin throws", () => {
  assert.throws(
    () => resolveWorkflowRef(undefined, "./child.yaml"),
    /Cannot resolve relative workflow reference ".\/child.yaml"/,
  );
});

test("resolveWorkflowRef: sibling relative path resolves against a remote origin's URL", () => {
  const result = resolveWorkflowRef(
    {
      kind: "remote",
      url: "https://raw.githubusercontent.com/o/r/main/tasks/parent.yaml",
    },
    "./child.yaml",
  );
  assert.deepEqual(result, {
    key: "https://raw.githubusercontent.com/o/r/main/tasks/child.yaml",
    kind: "remote",
  });
});

test("resolveWorkflowRef: ../ relative path resolves against a remote origin's URL", () => {
  const result = resolveWorkflowRef(
    {
      kind: "remote",
      url: "https://raw.githubusercontent.com/o/r/main/tasks/parent.yaml",
    },
    "../shared/child.yaml",
  );
  assert.deepEqual(result, {
    key: "https://raw.githubusercontent.com/o/r/main/shared/child.yaml",
    kind: "remote",
  });
});

test("resolveWorkflowRef: explicit cross-host URL under a remote origin is allowed", () => {
  const result = resolveWorkflowRef(
    {
      kind: "remote",
      url: "https://raw.githubusercontent.com/o/r/main/tasks/parent.yaml",
    },
    "https://example.com/other/child.yaml",
  );
  assert.deepEqual(result, {
    key: "https://example.com/other/child.yaml",
    kind: "remote",
  });
});

test("resolveWorkflowRef: a remote origin resolves an absolute-looking local path to a URL, never the filesystem", () => {
  const result = resolveWorkflowRef(
    {
      kind: "remote",
      url: "https://raw.githubusercontent.com/o/r/main/tasks/parent.yaml",
    },
    "/etc/passwd",
  );
  assert.deepEqual(result, {
    key: "https://raw.githubusercontent.com/etc/passwd",
    kind: "remote",
  });
  // /etc/passwd genuinely exists on any POSIX box this test runs on — the
  // point is that resolveWorkflowRef must never even consider reading it.
  assert.equal(existsSync("/etc/passwd"), true);
});

test("resolveWorkflowRef: a remote origin rejects a reference that resolves to a non-http(s) URL", () => {
  // A reference carrying its own absolute scheme (e.g. file://) overrides the
  // base entirely under WHATWG URL resolution — new URL() would otherwise
  // happily return a file: URL still tagged kind: "remote".
  assert.throws(
    () =>
      resolveWorkflowRef(
        {
          kind: "remote",
          url: "https://raw.githubusercontent.com/o/r/main/tasks/parent.yaml",
        },
        "file:///etc/passwd",
      ),
    /resolved to a non-http\(s\) URL "file:\/\/\/etc\/passwd"/,
  );
});
