import { execFile } from "node:child_process";
import type { RecallTool } from "./config.js";

/**
 * A recall is the agent going back to a stored full output. A whole-file read undoes the saving; a scoped search or a
 * ranged read keeps it. The footer under every excerpt names a search command that exists on this machine, detected
 * once at load. Detection never runs inside a tool_result handler.
 */
export type SearchTool = Exclude<RecallTool, "auto">;

/** Fastest first; the last entries cover Windows shells. */
const CHAIN: ReadonlyArray<{ tool: SearchTool; command: string; args: readonly string[] }> = [
  { tool: "rg", command: "rg", args: ["--version"] },
  { tool: "ag", command: "ag", args: ["--version"] },
  { tool: "ugrep", command: "ugrep", args: ["--version"] },
  { tool: "git-grep", command: "git", args: ["--version"] },
  { tool: "grep", command: "grep", args: ["--version"] },
  { tool: "select-string", command: process.platform === "win32" ? "powershell" : "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"] },
  { tool: "findstr", command: "where.exe", args: ["findstr"] },
];

function available(command: string, args: readonly string[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    try {
      execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, error => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

/** First working tool in the chain, or `none`. A configured tool other than `auto` is trusted without a probe. */
export async function detectSearchTool(configured: RecallTool = "auto", timeoutMs = 1500): Promise<SearchTool> {
  if (configured !== "auto") return configured;
  for (const entry of CHAIN) {
    if (entry.tool === "findstr" && process.platform !== "win32") continue;
    if (await available(entry.command, entry.args, timeoutMs)) return entry.tool;
  }
  return "none";
}

function searchExample(tool: SearchTool, path: string): string | undefined {
  switch (tool) {
    case "rg": return `rg -n -C 3 '<pattern>' '${path}'`;
    case "ag": return `ag -C 3 '<pattern>' '${path}'`;
    case "ugrep": return `ugrep -n -C 3 '<pattern>' '${path}'`;
    case "git-grep": return `git grep --no-index -n -C 3 '<pattern>' -- '${path}'`;
    case "grep": return `grep -n -C 3 -E '<pattern>' '${path}'`;
    case "select-string": return `Select-String -Path '${path}' -Pattern '<pattern>' -Context 3`;
    case "findstr": return `findstr /n /c:"<pattern>" "${path}"`;
    case "none": return undefined;
  }
}

/** Footer under an excerpt or duplicate note. Tells the agent how to get a part back without re-reading everything. */
export function recallInstruction(tool: SearchTool, path: string): string {
  const example = searchExample(tool, path);
  const how = example ? `search it (${example}) or read a known region with offset and limit` : "read a known region with offset and limit";
  return `Full output: ${path}\nTo recall a part, ${how}. Do not read the whole file.`;
}

/** `full` when the call loads the entire stored file into context; `scoped` for searches, ranged reads, and sandboxed processing. */
export function classifyRecall(toolName: string, input: unknown, path: string): "full" | "scoped" {
  const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  if (toolName === "read") return typeof record.offset === "number" || typeof record.limit === "number" ? "scoped" : "full";
  const command = typeof record.command === "string" ? record.command : typeof record.code === "string" ? record.code : undefined;
  if (!command) return "scoped";
  // The pipeline segment that names the path decides: a bare cat/type/Get-Content dumps everything; anything else scopes it.
  for (const segment of command.split(/&&|\|\||[;|]|\n/)) {
    if (!segment.includes(path)) continue;
    if (/^\s*(?:cat|type|Get-Content|gc)\b/.test(segment) && !/\s-(?:TotalCount|Head|Tail)\b/i.test(segment)) return "full";
  }
  return "scoped";
}
