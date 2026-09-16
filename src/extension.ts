import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTypeSafe, resolveApiKey } from "pi-typesafe";
import type { TypeSafe } from "pi-typesafe";
import { ensureApiKey } from "pi-typesafe/ui";
import { applyUserOverrides, defaultConfig, loadConfig, PACKAGE_NAME, projectConfigPath, readUserConfig, setUserSetting, userConfigPath, writeUserConfig } from "./config.js";
import type { WardenConfig } from "./config.js";
import { evaluateAction, formatVerdict } from "./guard.js";
import type { Verdict } from "./guard.js";

export const disclosure = "With TypeSafe judgments enabled, pi-warden sends the latest user request plus a redacted, truncated summary of each guarded bash, write, or edit call (command text, file path, content excerpt) to api.typesafe.ai before the tool runs. Requests may incur charges. Secret redaction is best-effort. Results are model judgments, not proof or authorization; offline pattern checks stay active either way.";

const WIDGET = PACKAGE_NAME;
const CONFIRM_TEXT_LIMIT = 500;

interface Stats { inspected: number; judged: number; warned: number; confirmed: number; blocked: number; errors: number }
const freshStats = (): Stats => ({ inspected: 0, judged: 0, warned: 0, confirmed: 0, blocked: 0, errors: 0 });

function latestUserPrompt(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    return content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join("\n");
  }
  return undefined;
}

function headlessPolicy(config: WardenConfig): "allow" | "block" {
  const env = process.env.PI_WARDEN_HEADLESS?.trim();
  return env === "allow" || env === "block" ? env : config.headless;
}

function clip(text: string): string {
  return text.length <= CONFIRM_TEXT_LIMIT ? text : `${text.slice(0, CONFIRM_TEXT_LIMIT)}…`;
}

function confirmMessage(verdict: Verdict): string {
  const { summary } = verdict;
  const lines: string[] = [];
  if (summary.command !== undefined) lines.push(clip(summary.command));
  if (summary.path !== undefined) lines.push(`${summary.tool} ${summary.path}${summary.location === "outside_project" ? " (outside the project)" : ""}${summary.exists === false ? " (new file)" : ""}`);
  if (summary.input !== undefined) lines.push(clip(summary.input));
  lines.push("", `Why: ${verdict.reasons.join("; ")}`);
  if (verdict.judgment) lines.push(`Jev: irreversible ${verdict.judgment.irreversible.toFixed(2)}, off-task ${verdict.judgment.offTask.toFixed(2)}, ${verdict.judgment.scope.replace(/_/g, " ")} (${verdict.judgment.model}, ${verdict.judgment.elapsedMs} ms)`);
  lines.push("Judgments are model output, not authorization. Yes runs the tool; No blocks it and tells the agent.");
  return lines.join("\n");
}

/** Native Pi registration; importing the root library does not load this module. */
export default function wardenExtension(pi: ExtensionAPI): void {
  let client: TypeSafe | undefined;
  let budgetExhausted = false;
  let stats = freshStats();
  let lastVerdict: Verdict | undefined;

  const configFor = (ctx: ExtensionContext | ExtensionCommandContext) => loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
  const consentGiven = (config: WardenConfig) => config.typesafe || process.env.PI_WARDEN_ENABLED === "1";
  const consentSource = (config: WardenConfig) => config.typesafe ? "/warden enable" : process.env.PI_WARDEN_ENABLED === "1" ? "PI_WARDEN_ENABLED" : undefined;
  const judgeFor = (config: WardenConfig): TypeSafe | undefined => {
    if (!consentGiven(config) || budgetExhausted || !resolveApiKey()) return undefined;
    return client ??= createTypeSafe({ maxRequests: config.action.maxRequests, timeoutMs: config.action.timeoutMs });
  };

  pi.on("session_start", async (_event, ctx) => {
    client = undefined;
    budgetExhausted = false;
    stats = freshStats();
    lastVerdict = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled || !config.action.enabled || !config.action.tools.includes(event.toolName)) return;
    stats.inspected++;
    const verdict = await evaluateAction(
      { tool: event.toolName, input: event.input, cwd: ctx.cwd, task: latestUserPrompt(ctx) },
      { config: config.action, judge: judgeFor(config), signal: ctx.signal },
    );
    lastVerdict = verdict;
    if (verdict.judgment) stats.judged++;
    if (verdict.source === "error") {
      stats.errors++;
      if (verdict.errorCode === "budget") budgetExhausted = true;
      if (ctx.hasUI) ctx.ui.notify(`warden: ${verdict.error}${budgetExhausted ? " Pattern checks continue without TypeSafe for the rest of this session." : ""}`, "warning");
    }
    if (ctx.hasUI && verdict.source !== "read-only") ctx.ui.setWidget(WIDGET, [formatVerdict(verdict)]);
    if (verdict.level === "warn") {
      stats.warned++;
      if (ctx.hasUI) ctx.ui.notify(`warden · ${event.toolName}: ${verdict.reasons.join("; ")}`, "warning");
      return undefined;
    }
    if (verdict.level !== "confirm") return undefined;
    stats.confirmed++;
    const reasons = verdict.reasons.join("; ");
    if (ctx.hasUI) {
      const allowed = await ctx.ui.confirm(`warden: allow this ${event.toolName} call?`, confirmMessage(verdict), ctx.signal ? { signal: ctx.signal } : {});
      if (allowed) return undefined;
      stats.blocked++;
      return { block: true, reason: `pi-warden: the user declined this ${event.toolName} call (${reasons}). Do not retry it unchanged; ask the user how to proceed.` };
    }
    if (headlessPolicy(config) === "allow") return undefined;
    stats.blocked++;
    return { block: true, reason: `pi-warden blocked this ${event.toolName} call because it needs user confirmation (${reasons}) and no user is present. Choose a safer approach or stop and report. Operators can set PI_WARDEN_HEADLESS=allow to permit such calls.` };
  });

  const actions = ["status", "enable", "disable", "config", "test"];
  pi.registerCommand("warden", {
    description: "pi-warden status, TypeSafe consent, config editor, and a synthetic guard test",
    getArgumentCompletions(prefix) {
      const matches = actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      const action = args.trim() || "status";
      const report = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else pi.sendMessage({ customType: `${PACKAGE_NAME}-status`, content: text, display: true });
      };
      try {
        const config = configFor(ctx);
        if (action === "status") {
          const key = resolveApiKey();
          const source = consentSource(config);
          const usage = client?.getUsage();
          report([
            `pi-warden: ${config.enabled && config.action.enabled ? "guarding" : "off"} ${config.action.tools.join(", ")}; TypeSafe judgments ${source ? `enabled via ${source}` : "disabled (run /warden enable)"}; key ${key ? key.source === "stored" ? "stored (shared with pi-typesafe)" : "from TYPESAFE_API_KEY" : "missing (run /warden enable)"}.`,
            `Session: ${stats.inspected} inspected, ${stats.judged} judged, ${stats.warned} warned, ${stats.confirmed} asked, ${stats.blocked} blocked, ${stats.errors} TypeSafe errors; ${usage?.requestsStarted ?? 0}/${config.action.maxRequests} requests.`,
            `Thresholds: irreversible warn ${config.action.irreversible.warn} / confirm ${config.action.irreversible.confirm}; off-task warn ${config.action.offTask.warn} / confirm ${config.action.offTask.confirm}; failOpen ${config.action.failOpen}; headless ${headlessPolicy(config)}.`,
            `Config: ${userConfigPath()}${ctx.isProjectTrusted() ? ` and ${projectConfigPath(ctx.cwd)}` : ""}.`,
            lastVerdict ? `Last: ${formatVerdict(lastVerdict)}` : "No guarded tool calls yet this session.",
          ].join(" "));
          return;
        }
        if (action === "enable") {
          if (!ctx.hasUI) { report("Consent needs an interactive session. For headless runs set PI_WARDEN_ENABLED=1 and TYPESAFE_API_KEY explicitly.", "warning"); return; }
          if (!await ctx.ui.confirm("Enable TypeSafe judgments for pi-warden?", disclosure)) return;
          // One flow: consent, then a key if none is configured yet (hidden input, verified, stored for every pi-typesafe consumer).
          const key = await ensureApiKey(ctx);
          if (!key) { report("No key entered; pi-warden stays on pattern checks only. Run /warden enable again when you have a key from console.typesafe.ai.", "warning"); return; }
          const path = setUserSetting("typesafe", true);
          client = undefined;
          budgetExhausted = false;
          report(`TypeSafe judgments enabled and saved to ${path}${key.login ? `; key verified (${key.login.models} model${key.login.models === 1 ? "" : "s"}) and stored at ${key.login.path}` : ` using the ${key.source === "stored" ? "stored key" : "key from TYPESAFE_API_KEY"}`}. This stays on in new sessions until /warden disable.`);
          return;
        }
        if (action === "disable") {
          const path = setUserSetting("typesafe", false);
          report(`TypeSafe judgments disabled in ${path}. Offline pattern checks stay active; set enabled to false there to turn pi-warden off entirely.`);
          return;
        }
        if (action === "config") {
          if (!ctx.hasUI) { report(`Edit ${userConfigPath()} directly. Defaults: ${JSON.stringify(defaultConfig())}`); return; }
          const current = readUserConfig();
          const seed = Object.keys(current).length ? current : { ...defaultConfig(), typesafe: config.typesafe };
          const text = await ctx.ui.editor(`pi-warden config · ${userConfigPath()}`, JSON.stringify(seed, null, 2));
          if (text === undefined) return;
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { report("Invalid JSON; nothing was saved.", "error"); return; }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { report("The config must be a JSON object; nothing was saved.", "error"); return; }
          const path = writeUserConfig(parsed as Record<string, unknown>);
          const effective = applyUserOverrides(defaultConfig(), parsed);
          client = undefined;
          report(`Saved ${path}. Effective: guard ${effective.enabled && effective.action.enabled ? "on" : "off"}, TypeSafe ${effective.typesafe ? "on" : "off"}, tools ${effective.action.tools.join(", ")}, irreversible confirm ≥ ${effective.action.irreversible.confirm}, off-task confirm ≥ ${effective.action.offTask.confirm}.`);
          return;
        }
        if (action === "test") {
          const judge = judgeFor(config);
          if (judge && ctx.hasUI && !await ctx.ui.confirm("Send one synthetic pi-warden test request?", `A synthetic action ("rm -rf /tmp/pi-warden-demo" for the task "Clean up the demo directory") goes to api.typesafe.ai and may incur charges. ${disclosure}`)) return;
          const verdict = await evaluateAction(
            { tool: "bash", input: { command: "rm -rf /tmp/pi-warden-demo" }, cwd: ctx.cwd, task: "Clean up the demo directory" },
            { config: { ...config.action, enabled: true, tools: ["bash"] }, judge },
          );
          if (ctx.hasUI) ctx.ui.setWidget(WIDGET, [formatVerdict(verdict)]);
          report(`${formatVerdict(verdict)}${verdict.reasons.length ? ` — ${verdict.reasons.join("; ")}` : ""}${judge ? "" : " (pattern checks only: TypeSafe judgments are not enabled or no key is configured)"}${verdict.error ? ` — ${verdict.error}` : ""}`);
          return;
        }
        report(`Unknown action "${action}". Use: ${actions.join(", ")}.`, "warning");
      } catch (error) {
        report(error instanceof Error ? error.message : "pi-warden command failed.", "error");
      }
    },
  });
}
