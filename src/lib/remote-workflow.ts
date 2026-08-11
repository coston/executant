// ============================================================================
// REMOTE WORKFLOW SOURCES
// ============================================================================
//
// Lets `executant <url>` run a workflow hosted elsewhere — a YAML file in a
// GitHub repo or a (possibly private) gist — without cloning it first.
//
// GitHub "web page" URLs are rewritten to their raw equivalents so a URL
// copied from the browser address bar just works. Private repos and gists
// authenticate with the token from the user's existing `gh` login.

import { execFileSync } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { getErrorMessage } from "./utils.js";
import type { Origin } from "../types.js";

/** Raw hosts we are willing to attach a GitHub token to. */
const GITHUB_RAW_HOSTS = new Set([
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
]);

export function isRemoteWorkflow(source: string): boolean {
  return source.startsWith("https://") || source.startsWith("http://");
}

/**
 * Rewrite a GitHub blob or gist page URL to the raw content URL.
 * Any other URL — including already-raw ones — is returned unchanged.
 */
export function toRawUrl(source: string): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return source;
  }

  if (url.hostname === "github.com") {
    // /<owner>/<repo>/blob/<ref>/<path...>  (ref may itself contain slashes)
    const parts = url.pathname.split("/").filter(Boolean);
    const [owner, repo, kind, ...rest] = parts;
    if (kind === "blob" && owner && repo && rest.length >= 2) {
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`;
    }
    return source;
  }

  if (url.hostname === "gist.github.com") {
    // /<user>/<id> — /raw serves the first file in the gist.
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`;
    }
    return source;
  }

  return source;
}

/**
 * The token from the user's `gh` login, or undefined when gh is missing,
 * not logged in, or otherwise unhappy. Never throws — auth is best-effort.
 */
function githubToken(): string | undefined {
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Fetch the YAML source at `url`. `tokenFn` is injectable for tests. */
export async function fetchWorkflowSource(
  url: string,
  tokenFn: () => string | undefined = githubToken,
): Promise<string> {
  const isGitHub = GITHUB_RAW_HOSTS.has(safeHostname(url));
  const token = isGitHub ? tokenFn() : undefined;
  const headers: Record<string, string> = { Accept: "text/plain" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: "follow" });
  } catch (err) {
    throw new Error(
      `Cannot fetch workflow from "${url}": ${getErrorMessage(err)}`,
    );
  }

  if (!res.ok) {
    const hint =
      isGitHub && [401, 403, 404].includes(res.status)
        ? ` — run "gh auth login" if this is a private repo or gist`
        : "";
    throw new Error(
      `Cannot fetch workflow from "${url}": HTTP ${res.status} ${res.statusText}${hint}`,
    );
  }

  return await res.text();
}

/**
 * Rejects anything but http(s). `new URL(ref, base)` lets `ref` carry its own
 * absolute scheme and override `base` entirely (e.g. `new URL("file:///etc/passwd",
 * "https://...")` resolves to the file: URL, ignoring the base) — without this
 * check that would let a remote-origin workflow's reference reach the local
 * filesystem (or another non-http scheme) despite resolving to a "remote" kind.
 */
function assertHttpUrl(url: string): string {
  const { protocol } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(
      `Workflow reference resolved to a non-http(s) URL "${url}" — only http(s) references are supported`,
    );
  }
  return url;
}

/**
 * Resolves a `workflow:` step's reference (as written in YAML) to an
 * absolute local path or URL, relative to the workflow that referenced it.
 */
export function resolveWorkflowRef(
  origin: Origin | undefined,
  ref: string,
): { key: string; kind: "local" | "remote" } {
  if (isRemoteWorkflow(ref)) {
    return { key: assertHttpUrl(toRawUrl(ref)), kind: "remote" };
  }
  // Must come before the isAbsolute check below: a remote-origin workflow's
  // reference must ALWAYS resolve to a URL, even one that looks like an
  // absolute local path (e.g. "/etc/passwd") — otherwise a malicious or
  // compromised remote workflow could read arbitrary files off the machine
  // running it.
  if (origin?.kind === "remote") {
    return {
      key: assertHttpUrl(new URL(ref, origin.url).toString()),
      kind: "remote",
    };
  }
  if (isAbsolute(ref)) return { key: resolve(ref), kind: "local" };
  if (!origin) {
    throw new Error(
      `Cannot resolve relative workflow reference "${ref}" — the parent workflow has no known file or URL origin`,
    );
  }
  return { key: resolve(origin.dir, ref), kind: "local" };
}

/** Short display/telemetry name for a workflow source (path or URL). */
export function workflowTaskName(source: string): string {
  if (!isRemoteWorkflow(source)) return basename(source);
  try {
    return basename(new URL(source).pathname) || "remote-workflow";
  } catch {
    return "remote-workflow";
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
