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
import { basename } from "node:path";
import { getErrorMessage } from "./utils.js";

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
export function githubToken(): string | undefined {
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
