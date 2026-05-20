import { getToolArg } from "../lib/utils.js";

export function formatToolCall(
  tool: string,
  input: Record<string, unknown>,
): string {
  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
    case "Glob":
    case "Grep":
      return `[${tool}] ${getToolArg(tool, input)}`;
    case "Bash":
      return `[Bash] ${input["description"] ?? ""}\n  $ ${String(input["command"] ?? "").slice(0, 120)}`;
    case "TodoWrite": {
      const todos = input["todos"];
      if (Array.isArray(todos)) {
        const inProgress = todos
          .filter(
            (t): t is Record<string, unknown> =>
              typeof t === "object" &&
              t !== null &&
              t["status"] === "in_progress",
          )
          .map((t) => String(t["content"] ?? ""));
        if (inProgress.length > 0) return `[Task] ${inProgress.join(", ")}`;
      }
      return "";
    }
    case "Agent":
      return `[Agent:${input["subagent_type"] ?? "?"}] ${input["description"] ?? ""}`;
    default:
      if (process.env["EXECUTANT_DEBUG"] === "1") {
        return `[${tool}] ${JSON.stringify(input)}`;
      }
      return "";
  }
}
