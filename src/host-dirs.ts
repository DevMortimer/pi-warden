/**
 * Host directories for pi-warden's own data. The library carries no runtime import of the optional
 * Pi peer; the extension (src/extension.ts) builds these once from the host and passes them to every
 * path call. `defaultHostDirs` covers the plain-library and test cases: `PI_CODING_AGENT_DIR` wins,
 * `~` expands to the home directory, and the fallback matches Pi's own agent directory.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface HostDirs {
  /** The host's agent directory: `~/.pi/agent` on Pi, `~/.omp/agent` on oh-my-pi. */
  agentDir: string;
  /** The project config directory name: `.pi` on Pi, `.omp` on oh-my-pi. */
  configDirName: string;
}

/** Expand a leading `~` or `~/` to the home directory; anything else comes back trimmed. */
export function expandHome(value: string): string {
  const configured = value.trim();
  return configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured;
}

/** Resolve the agent directory the way the host would: `PI_CODING_AGENT_DIR`, else Pi's default. */
export function defaultHostDirs(env: NodeJS.ProcessEnv = process.env): HostDirs {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return {
    agentDir: configured ? expandHome(configured) : join(homedir(), ".pi", "agent"),
    configDirName: ".pi",
  };
}
