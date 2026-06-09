// ============================================================================
// EVAL CONTAINER ISOLATION
// ============================================================================
// Helpers for running eval subprocesses inside Docker containers so that
// Claude/OpenCode agents cannot write to the host filesystem.
//
// Opt-in: set EVAL_DOCKER=1 to enable. When unset, eval runs directly on
// the host (existing behaviour, already protected by allowedTools: [] for
// prompt evals).
//
// Usage in workflow evals:
//   if (isDockerEnabled()) {
//     spawn("docker", buildDockerArgs({ workdir, readOnlyMounts, env, cmd }))
//   }

export const DOCKER_IMAGE = "executant-eval:latest";

/** Returns true when EVAL_DOCKER=1 is present in the environment. */
export function isDockerEnabled(): boolean {
  return process.env["EVAL_DOCKER"] === "1";
}

export interface DockerReadOnlyMount {
  host: string;
  container: string;
}

export interface DockerRunOpts {
  /** Host path mounted read-write at /workspace inside the container. */
  workdir: string;
  /** Additional host paths mounted read-only inside the container. */
  readOnlyMounts?: DockerReadOnlyMount[];
  /** Environment to pass through. Only a safe subset of keys is forwarded. */
  env: NodeJS.ProcessEnv;
  /** Command and args to execute inside the container. */
  cmd: string[];
}

// Only forward keys that are known-safe for eval containers.
// Never forward HOME, PATH, or shell state variables.
const PASSTHROUGH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "EXECUTANT_PROVIDER",
  "EXECUTANT_MODEL",
  "EXECUTANT_AGENT",
  "OPENCODE_PERMISSION",
  "NODE_ENV",
];

/**
 * Builds the argv for `spawn("docker", buildDockerArgs(...))`.
 *
 * Mounts:
 *   workdir        → /workspace  (read-write)
 *   readOnlyMounts → as specified (read-only)
 *
 * All writes by the container process are confined to /workspace (the
 * worktree on the host). The host HOME, source repo, and system paths are
 * never mounted unless explicitly listed in readOnlyMounts.
 */
export function buildDockerArgs(opts: DockerRunOpts): string[] {
  const envArgs = PASSTHROUGH_ENV_KEYS.filter(
    (k) => opts.env[k] !== undefined,
  ).flatMap((k) => ["--env", `${k}=${opts.env[k]!}`]);

  const roMountArgs = (opts.readOnlyMounts ?? []).flatMap(
    ({ host, container }) => ["--volume", `${host}:${container}:ro`],
  );

  return [
    "run",
    "--rm",
    "--volume",
    `${opts.workdir}:/workspace:rw`,
    ...roMountArgs,
    "--workdir",
    "/workspace",
    ...envArgs,
    // Allow the container to reach host-side llama-server processes for local
    // model inference. On Linux this requires the explicit --add-host flag;
    // on macOS host.docker.internal is already defined by Docker Desktop.
    "--add-host",
    "host.docker.internal:host-gateway",
    DOCKER_IMAGE,
    ...opts.cmd,
  ];
}
