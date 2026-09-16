/**
 * Knowledge of which tool inputs carry shell commands. Pi's built-ins plus context-mode's ctx_* tools, which many Pi users
 * run instead of bash. Unknown tools return nothing and are judged from their JSON input only.
 */

export interface CommandView {
  /** Shell text to pattern-match and judge. Several commands are joined with newlines. */
  command: string;
  /** False when the code is not shell (JavaScript, Python …); pattern rules still run, the read-only shortcut does not. */
  shell: boolean;
}

const SHELL_LANGUAGES = new Set(["shell", "bash", "sh", "zsh", "powershell"]);

function commandsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => (item && typeof item === "object" ? (item as { command?: unknown }).command : undefined)).filter((command): command is string => typeof command === "string");
}

/** Extract the command text a tool call would execute, or undefined for tools that run no commands. */
export function commandOf(tool: string, input: Record<string, unknown>): CommandView | undefined {
  switch (tool) {
    case "bash":
    case "powershell":
      return typeof input.command === "string" ? { command: input.command, shell: true } : undefined;
    case "ctx_execute":
    case "ctx_execute_file": {
      if (typeof input.code !== "string") return undefined;
      const language = typeof input.language === "string" ? input.language.toLowerCase() : "";
      return { command: input.code, shell: SHELL_LANGUAGES.has(language) };
    }
    case "ctx_batch_execute": {
      const commands = commandsOf(input.commands);
      return commands.length ? { command: commands.join("\n"), shell: true } : undefined;
    }
    default:
      return undefined;
  }
}

/** Tools whose calls carry commands and should be guarded by default. */
export const COMMAND_TOOLS = ["bash", "powershell", "ctx_execute", "ctx_batch_execute", "ctx_execute_file"];

/** Text that signals failure in tool output when the tool itself did not flag an error (context-mode reports exit codes inline). */
export function outputReportsFailure(text: string): boolean {
  return /(?:^|\n)\s*Command exited with code [1-9]\d*\b/.test(text) || /(?:^|\n)\s*\(timed out\)\s*$/.test(text);
}
