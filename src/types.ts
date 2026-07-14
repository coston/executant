// ============================================================================
// CORE TYPES
// ============================================================================
// The entire system is built around these types. Every task produces a stream
// of Events. The UI consumes events and builds ExecutionState. Nothing is
// communicated via raw strings — all data flows through the event model.

// ----------------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------------

/** Shared fields present on every task type. */
interface BaseTask {
  /** Unique identifier for this step within the workflow. */
  name: string;
  /** When true, a failure in this step does not abort the workflow. */
  continueOnError?: boolean;
}

/** Emits a single log line with no side effects. Useful for progress markers. */
export interface LogTask extends BaseTask {
  type: "log";
  message: string;
}

/** Runs an arbitrary bash command. Streams stdout/stderr as output:text events. */
export interface CommandTask extends BaseTask {
  type: "command";
  command: string;
  /**
   * When true (default for script steps), failures trigger a multi-pass Claude
   * repair loop. Claude gets the error output plus accumulated context from prior
   * attempts and full tool access to diagnose and fix the issue. The command is
   * re-run after each fix, up to maxHealingAttempts times.
   * Set to false to disable and fail immediately on error.
   */
  selfHealing?: boolean;
  /** Max self-healing attempts before giving up. Defaults to 5. */
  maxHealingAttempts?: number;
  /**
   * Resolved file path where the runner writes the step's stdout after
   * successful completion. Populated by load-workflow from the `output:` YAML
   * field (which names a var whose value is the file path).
   */
  output?: string;
  /** Kill the process and throw TimeoutError after this many seconds. */
  timeoutSeconds?: number;
}

/** Which coding-agent CLI backend executes a prompt step. */
export type AgentProvider = "claude" | "opencode";

/** Invokes a coding-agent CLI (Claude or OpenCode) via child_process.spawn. Streams AI output as structured events. */
export interface ClaudeTask extends BaseTask {
  type: "claude";
  prompt: string;
  /**
   * Which provider runs this step. Defaults to the EXECUTANT_PROVIDER env var,
   * then falls back to "claude".
   */
  provider?: AgentProvider;
  /** Subset of Claude tools to allow. Defaults to a safe general-purpose set. */
  allowedTools?: string[];
  /** Permission mode passed to the agent CLI. Defaults to 'bypassPermissions'. */
  permissionMode?: "bypassPermissions" | "default";
  /** JSON Schema object passed via --json-schema to enforce structured output (Claude only). */
  jsonSchema?: Record<string, unknown>;
  /** Text appended to the system prompt via --append-system-prompt (Claude only). */
  appendSystemPrompt?: string;
  /** Model override. For Claude: model name like "sonnet". For OpenCode: "provider/model" like "llama-qwen7b/qwen2.5-coder-7b". */
  model?: string;
  /** OpenCode --agent flag. Ignored by the Claude runner. */
  agent?: string;
  /**
   * When true, after the step completes Claude evaluates its own output.
   * If the verdict is FAIL the step retries up to 5 times.
   */
  llmAsJudge?: boolean;
  /**
   * Resolved file paths whose contents are prepended to the prompt at runtime.
   * Populated by load-workflow from the `context:` YAML field (which names vars
   * whose values are file paths).
   */
  contextFiles?: string[];
  /** Kill the agent subprocess and throw TimeoutError after this many seconds. */
  timeoutSeconds?: number;
}

/**
 * Runs child tasks once per item in a list.
 * The list is either an inline array or a shell command whose newline-split
 * output provides the items. `{{item}}` in each inner task's fields is
 * substituted at runtime for each iteration.
 */
export interface ForEachTask extends BaseTask {
  type: "forEach";
  forEach: string[] | string;
  /**
   * Template tasks — {{item}} will be substituted per iteration.
   * Always an array; single-task forEach is normalized to [task] at load time.
   * Nested ForEachTask is supported for multi-level iteration.
   */
  inner: Task[];
}

export type Task = LogTask | CommandTask | ClaudeTask | ForEachTask;

// ----------------------------------------------------------------------------
// Events  (discriminated union — the primary communication contract)
// ----------------------------------------------------------------------------

/** Fired once when the entire workflow begins. */
export interface WorkflowStartEvent {
  type: "workflow:start";
  workflow: Workflow;
}

/** Fired once when all steps have completed (or the last error was swallowed). */
export interface WorkflowCompleteEvent {
  type: "workflow:complete";
  workflow: Workflow;
  durationMs: number;
  /** Last 100 lines of combined stdout/stderr from the final step. */
  lastOutput?: string;
}

/** Fired when execution is stopped cooperatively via the .executant-cancel file. */
export interface WorkflowCancelledEvent {
  type: "workflow:cancelled";
  workflow: Workflow;
  durationMs: number;
}

/** Fired when a step begins executing. */
export interface StepStartEvent {
  type: "step:start";
  index: number;
  name: string;
}

/** Fired when a step finishes successfully. */
export interface StepCompleteEvent {
  type: "step:complete";
  index: number;
  name: string;
  durationMs: number;
}

/** Fired when a step throws. If continueOnError is set, execution continues. */
export interface StepErrorEvent {
  type: "step:error";
  index: number;
  name: string;
  error: Error;
  /** Last 100 lines of combined stdout/stderr from the failing step. */
  lastOutput?: string;
}

/** Fired when a step is skipped due to --step or --from-step filters. */
export interface StepSkipEvent {
  type: "step:skip";
  index: number;
  name: string;
}

/** Fired at the start of each forEach iteration so the UI can show progress. */
export interface StepIterationEvent {
  type: "step:iteration";
  index: number;
  item: string;
  iteration: number; // 1-based
  total: number;
}

/** Fired before each child step within a multi-step forEach iteration. */
export interface StepInnerEvent {
  type: "step:inner";
  index: number; // parent forEach step index
  iteration: number; // 1-based
  innerIndex: number; // 0-based child step index
  innerTotal: number; // total child steps
  name: string; // child step name ({{item}} already substituted)
}

/** A line of plain text output from a command or Claude's text blocks. */
export interface OutputTextEvent {
  type: "output:text";
  /**
   * 0-based step index. Inner generators (log, forEach iterations) emit -1 as
   * a sentinel; runWorkflow patches this to the real step index before yielding
   * downstream.
   */
  index: number;
  text: string;
}

/**
 * A structured tool invocation emitted by Claude.
 * The UI can format this richly (e.g. "[Read] src/foo.ts") instead of
 * showing the raw JSON that stream-parser.sh used to parse.
 */
export interface OutputToolEvent {
  type: "output:tool";
  /**
   * 0-based step index. Inner generators emit -1 as a sentinel;
   * runWorkflow patches this to the real step index before yielding downstream.
   */
  index: number;
  tool: string;
  input: Record<string, unknown>;
}

/** API cost reported at the end of a Claude invocation. */
export interface OutputCostEvent {
  type: "output:cost";
  /**
   * 0-based step index. Inner generators emit -1 as a sentinel;
   * runWorkflow patches this to the real step index before yielding downstream.
   */
  index: number;
  usd: number;
}

/** Schema-validated JSON object from a Claude invocation that used --json-schema. */
export interface OutputStructuredEvent {
  type: "output:structured";
  data: unknown;
}

/** Informational messages from the runner itself (not from commands/Claude). */
export interface LogEvent {
  type: "log";
  level: "info" | "warn" | "error";
  text: string;
}

/** Fired when the user injects a message into the running Claude step via the TUI. */
export interface StepInterjectionEvent {
  type: "step:interjection";
  index: number;
  message: string;
}

/** Fired by the self-healing loop as it progresses. index uses the -1 sentinel. */
export interface StepHealingEvent {
  type: "step:healing";
  index: number;
  phase: "attempt-failed" | "healed" | "exhausted";
  /** 1-based attempt just concluded. */
  attempt: number;
  maxAttempts: number;
  /** Present on attempt-failed / exhausted. */
  exitCode?: number;
}

/** Fired after each LLM-as-judge evaluation completes. index uses the -1 sentinel. */
export interface StepJudgeEvent {
  type: "step:judge";
  index: number;
  verdict: "pass" | "fail";
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
  /** Present on fail. */
  feedback?: string;
}

export type Event =
  | WorkflowStartEvent
  | WorkflowCompleteEvent
  | WorkflowCancelledEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepErrorEvent
  | StepSkipEvent
  | StepIterationEvent
  | StepInnerEvent
  | OutputTextEvent
  | OutputToolEvent
  | OutputCostEvent
  | OutputStructuredEvent
  | LogEvent
  | StepInterjectionEvent
  | StepHealingEvent
  | StepJudgeEvent;

// ----------------------------------------------------------------------------
// Run options  (CLI flags, not YAML — passed to runWorkflow)
// ----------------------------------------------------------------------------

/**
 * Dot-notation path for resuming from a nested step. Each element is 1-based.
 * [stepIdx] | [stepIdx, iteration] | [stepIdx, iteration, childIdx, ...]
 * Components alternate: step → iteration → child-step → iteration → …
 */
export type FromStepTarget = number[];

export interface RunOptions {
  /** Run only this step: match by name or 1-based index string. */
  stepFilter?: string;
  /** Resume from this 1-based path (e.g. [3] or [3,2] or [2,5,4,3]). */
  fromStep?: FromStepTarget;
  /** Directory where the .executant-cancel file is checked. Defaults to process.cwd(). */
  workDir?: string;
}

// ----------------------------------------------------------------------------
// Workflow
// ----------------------------------------------------------------------------

export interface Workflow {
  /** Human-readable description shown in the UI header. */
  goal: string;
  /** Ordered list of steps. Executed sequentially by default. */
  tasks: Task[];
  /** Shared key/value pairs substituted into prompts and commands. */
  vars?: Record<string, string>;
}

// ----------------------------------------------------------------------------
// Execution State  (derived from the event stream by the UI reducer)
// ----------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "skipped";

/** A single forEach iteration's state, including history of completed iterations. */
export interface IterationRecord {
  item: string;
  /** 1-based iteration counter. */
  iteration: number;
  /** Total number of iterations. */
  total: number;
  status: "running" | "complete" | "error";
  startTime: number;
  endTime?: number;
  /** Set when the iteration is running a named child step (innerTotal > 1). */
  inner?: { index: number; total: number; name: string };
}

export interface TaskState {
  task: Task;
  status: TaskStatus;
  startTime?: number;
  endTime?: number;
  /** Rolling buffer of output lines rendered in the log pane. */
  lines: string[];
  error?: Error;
  /** Per-iteration records for forEach steps; grows as iterations start/finish. */
  iterationHistory?: IterationRecord[];
}

export interface ExecutionState {
  workflow: Workflow;
  tasks: TaskState[];
  currentIndex: number;
  startTime: number;
  endTime?: number;
  /** Accumulated list of file paths written via the Write tool across all steps. */
  writtenFiles: string[];
}

// ----------------------------------------------------------------------------
// Interject Channel  (bridges TUI key input → runner subprocess stdin)
// ----------------------------------------------------------------------------

/**
 * Queues user interjection messages for prepending to the next Claude step's
 * prompt. The Claude CLI requires stdin EOF before processing, so mid-execution
 * injection is not possible — messages are always queued and consumed by
 * runStep before starting the next Claude invocation.
 */
export class InterjectChannel {
  private _queue: string[] = [];

  /** Called by the TUI when the user submits an interjection message. */
  interject(message: string): void {
    this._queue.push(message);
  }

  /** Drains and returns any queued messages (for non-Claude steps to consume). */
  consumeQueue(): string[] {
    const q = this._queue.slice();
    this._queue = [];
    return q;
  }
}

/** Raw step shape as parsed from YAML before normalisation. */
export type RawStep = {
  name: string;
  type?: "prompt" | "script" | "log" | "command";
  prompt?: string;
  command?: string;
  message?: string;
  continue_on_error?: boolean;
  self_healing?: boolean;
  max_healing_attempts?: number;
  output?: string;
  llm_as_judge?: boolean;
  allowed_tools?: string[];
  forEach?: string[] | string;
  repeat?: number;
  context?: string[];
  steps?: RawStep[];
  timeout_seconds?: number;
  /** Which provider runs this prompt step. */
  provider?: AgentProvider;
  /** Model override for this step. */
  model?: string;
  /** OpenCode agent name. */
  agent?: string;
};

/** Thrown when a step exceeds its timeout_seconds limit. Exit code: 3. */
export class TimeoutError extends Error {
  readonly exitCode = 3;
  constructor(stepName: string, seconds: number) {
    super(`Step "${stepName}" timed out after ${seconds}s`);
    this.name = "TimeoutError";
  }
}
