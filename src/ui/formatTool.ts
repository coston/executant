export function formatToolCall(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `[${tool}] ${input['file_path'] ?? JSON.stringify(input)}`;
    case 'Bash':
      return `[Bash] ${input['description'] ?? ''}\n  $ ${String(input['command'] ?? '').slice(0, 120)}`;
    case 'Glob':
      return `[Glob] ${input['pattern'] ?? JSON.stringify(input)}`;
    case 'Grep':
      return `[Grep] ${input['pattern'] ?? JSON.stringify(input)}`;
    case 'TodoWrite': {
      const todos = input['todos'];
      if (Array.isArray(todos)) {
        const inProgress = todos
          .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null && t['status'] === 'in_progress')
          .map((t) => String(t['content'] ?? ''));
        if (inProgress.length > 0) return `[Task] ${inProgress.join(', ')}`;
      }
      return '';
    }
    case 'Agent':
      return `[Agent:${input['subagent_type'] ?? '?'}] ${input['description'] ?? ''}`;
    default:
      if (process.env['EXECUTANT_DEBUG'] === '1') {
        return `[${tool}] ${JSON.stringify(input)}`;
      }
      return '';
  }
}
