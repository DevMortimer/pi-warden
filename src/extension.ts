import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MouseRegion, Text } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import { createTypeSafe, resolveApiKey } from "pi-typesafe";
import type { TypeSafe } from "pi-typesafe";
import { ensureApiKey } from "pi-typesafe/ui";
import { applyUserOverrides, defaultConfig, isMode, loadConfig, PACKAGE_NAME, projectConfigPath, readUserConfig, setUserSetting, userConfigPath, writeUserConfig } from "./config.js";
import type { WardenConfig, WardenMode } from "./config.js";
import { classifyToolResult, doneNudge, emptyEvidence, evaluateDone, finalAssistantText, formatDone, needsDoneCheck, recordOutcome } from "./done.js";
import type { RunEvidence } from "./done.js";
import { evaluateAction, formatVerdict, steerReason, textApproves } from "./guard.js";
import type { Verdict } from "./guard.js";
import { AttemptWindow, evaluateStuck, formatStuck, makeAttempt, resultFailed, stuckNudge } from "./stuck.js";
import { actionDetails, doneDetails, openTracePanel, stuckDetails, Trace } from "./trace.js";
import type { GuardName, PanelUi } from "./trace.js";
import { TOKEN_NAMES } from "./widget.js";

export const disclosure = "With TypeSafe judgments enabled, pi-warden sends to api.typesafe.ai: your latest request plus a redacted, truncated summary of each guarded bash, write, or edit call before it runs; the last few tool calls and output tails when the agent keeps failing; and the agent's final message when it reports completion without running checks. Requests may incur charges. Secret redaction is best-effort. Results are model judgments, not proof or authorization; offline pattern checks stay active either way.";

const WIDGET = PACKAGE_NAME;
const CONFIRM_TEXT_LIMIT = 500;

interface Stats { inspected: number; judged: number; warned: number; held: number; approved: number; slop: number; stuckChecks: number; stuck: number; doneChecks: number; unverified: number; errors: number }
const freshStats = (): Stats => ({ inspected: 0, judged: 0, warned: 0, held: 0, approved: 0, slop: 0, stuckChecks: 0, stuck: 0, doneChecks: 0, unverified: 0, errors: 0 });

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

function activeMode(config: WardenConfig, hasUI: boolean): WardenMode {
  const env = process.env.PI_WARDEN_MODE?.trim();
  const mode = isMode(env) ? env : config.mode;
  return mode === "confirm" && !hasUI ? "steer" : mode;
}

function clip(text: string): string {
  return text.length <= CONFIRM_TEXT_LIMIT ? text : `${text.slice(0, CONFIRM_TEXT_LIMIT)}…`;
}

export function confirmMessage(verdict: Verdict): string {
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

const callKey = (tool: string, input: unknown) => `${tool}\0${JSON.stringify(input)}`;

/** Native Pi registration; importing the root library does not load this module. */
export default function wardenExtension(pi: ExtensionAPI): void {
  let client: TypeSafe | undefined;
  let budgetExhausted = false;
  let stats = freshStats();
  const widget = new Map<GuardName, string>();
  const trace = new Trace();
  let panelOpen = false;
  let lastUi: PanelUi | undefined;
  /** Calls held in steer mode, with the user prompt current at that time; a retry after the user replies asks Jev about approval. */
  const held = new Map<string, string | undefined>();
  let attempts = new AttemptWindow(defaultConfig().stuck.window);
  let evidence: RunEvidence = emptyEvidence();
  let doneNudged = false;

  const configFor = (ctx: ExtensionContext | ExtensionCommandContext) => loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
  const consentGiven = (config: WardenConfig) => config.typesafe || process.env.PI_WARDEN_ENABLED === "1";
  const consentSource = (config: WardenConfig) => config.typesafe ? "/warden enable" : process.env.PI_WARDEN_ENABLED === "1" ? "PI_WARDEN_ENABLED" : undefined;
  const judgeFor = (config: WardenConfig): TypeSafe | undefined => {
    if (!consentGiven(config) || budgetExhausted || !resolveApiKey()) return undefined;
    return client ??= createTypeSafe({ maxRequests: config.maxRequests, timeoutMs: config.timeoutMs });
  };
  const noteError = (ctx: ExtensionContext, message: string, code: string | undefined) => {
    stats.errors++;
    if (code === "budget") budgetExhausted = true;
    if (ctx.hasUI) ctx.ui.notify(`warden: ${message}${budgetExhausted ? " Pattern checks continue without TypeSafe for the rest of this session." : ""}`, "warning");
  };
  const openPanel = (ui: PanelUi | undefined) => {
    if (!ui || panelOpen) return;
    panelOpen = true;
    openTracePanel(ui, trace).catch(() => undefined).finally(() => { panelOpen = false; });
  };
  const paint = (ctx: ExtensionContext | ExtensionCommandContext, config: WardenConfig) => {
    if (!ctx.hasUI) return;
    lastUi = ctx.ui as unknown as PanelUi;
    if (!config.widget.enabled || widget.size === 0) { ctx.ui.setWidget(WIDGET, undefined); return; }
    const lines = [...widget.values()];
    // A custom component so a click (fullscreen mode) opens the trace panel; plain lines otherwise look the same.
    ctx.ui.setWidget(WIDGET, (_tui, theme) => new MouseRegion(new Text(lines.map(line => theme.fg("muted", line)).join("\n"), 0, 0), event => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      openPanel(lastUi);
      return { handled: true };
    }), { placement: config.widget.placement });
  };
  const record = (ctx: ExtensionContext | ExtensionCommandContext, config: WardenConfig, guard: GuardName, line: string, details: string[]) => {
    widget.set(guard, line);
    trace.push({ at: Date.now(), guard, line, details });
    paint(ctx, config);
  };
  const steer = (content: string) => pi.sendMessage({ customType: `${PACKAGE_NAME}-steer`, content, display: true }, { deliverAs: "steer" });

  pi.on("session_start", async (_event, ctx) => {
    client = undefined;
    budgetExhausted = false;
    stats = freshStats();
    widget.clear();
    trace.clear();
    held.clear();
    attempts.reset();
    evidence = emptyEvidence();
    doneNudged = false;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  });

  // A new user prompt starts a new attempt history and a new done-check budget.
  pi.on("before_agent_start", async (_event, ctx) => {
    attempts = new AttemptWindow(configFor(ctx).stuck.window);
    doneNudged = false;
  });

  // Each low-level run collects its own evidence of changes and checks.
  pi.on("agent_start", async () => {
    evidence = emptyEvidence();
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled || !config.action.enabled || !config.action.tools.includes(event.toolName)) return;
    stats.inspected++;
    const task = latestUserPrompt(ctx);
    const key = callKey(event.toolName, event.input);
    const heldAt = held.get(key);
    const retryAfterHold = held.has(key) && heldAt !== task;
    const judge = judgeFor(config);
    const verdict = await evaluateAction(
      { tool: event.toolName, input: event.input, cwd: ctx.cwd, task },
      { config: config.action, judge, signal: ctx.signal, slop: config.slop, retryAfterHold },
    );
    if (verdict.source === "skipped") return;
    if (verdict.judgment) stats.judged++;
    if (verdict.source === "error") noteError(ctx, verdict.error ?? "TypeSafe request failed.", verdict.errorCode);
    // Offline stand-in for the approval question: the user has replied since the hold and the reply reads as approval.
    if (retryAfterHold && !judge && verdict.level === "confirm" && textApproves(task)) {
      verdict.level = "allow";
      verdict.approvedByUser = true;
      verdict.reasons = ["user approved in the latest message", ...verdict.reasons];
    }
    if (verdict.approvedByUser) {
      stats.approved++;
      held.delete(key);
    }
    const mode = activeMode(config, ctx.hasUI);
    const told = verdict.level === "confirm" && mode === "steer" ? steerReason(verdict, { canApprove: judge !== undefined }) : undefined;
    if (verdict.source !== "read-only") record(ctx, config, "action", formatVerdict(verdict, config.widget.action), actionDetails(verdict, { mode, ...(told ? { told } : {}) }));
    if (verdict.slopReasons?.length) {
      stats.slop++;
      const where = verdict.summary.path ?? event.toolName;
      if (ctx.hasUI) ctx.ui.notify(`warden · slop · ${where}: ${verdict.slopReasons.join("; ")}`, "warning");
      steer(`pi-warden: the content just written to ${where} reads as ${verdict.slopReasons.join(" and ")}. Replace stubs and placeholders with working code, remove comments that restate the code, and keep only what the request needs. If something is intentionally left unimplemented, say so in your reply instead of leaving it in the code.`);
    }
    if (verdict.level === "warn") {
      stats.warned++;
      if (ctx.hasUI) ctx.ui.notify(`warden · ${event.toolName}: ${verdict.reasons.join("; ")}`, "warning");
      return undefined;
    }
    if (verdict.level !== "confirm") return undefined;

    const reasons = verdict.reasons.join("; ");
    if (mode === "advise") {
      stats.warned++;
      if (ctx.hasUI) ctx.ui.notify(`warden · ${event.toolName} (advise mode, not held): ${reasons}`, "warning");
      return undefined;
    }
    if (mode === "confirm") {
      const allowed = await ctx.ui.confirm(`warden: allow this ${event.toolName} call?`, confirmMessage(verdict), ctx.signal ? { signal: ctx.signal } : {});
      if (allowed) return undefined;
      stats.held++;
      return { block: true, reason: `pi-warden: the user declined this ${event.toolName} call (${reasons}). Do not retry it unchanged; ask the user how to proceed.` };
    }
    stats.held++;
    held.set(key, task);
    if (ctx.hasUI) ctx.ui.notify(`warden · held ${event.toolName}: ${reasons}. The agent was told why and asked to re-plan or ask you.`, "warning");
    return { block: true, reason: told ?? steerReason(verdict, { canApprove: judge !== undefined }) };
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled) return;
    const failed = resultFailed(event.isError, event.details, event.content);
    if (config.done.enabled) recordOutcome(evidence, classifyToolResult(event.toolName, event.input, failed), event.input, event.toolName);
    if (!config.stuck.enabled) return;
    attempts.push(makeAttempt(event.toolName, event.input, event.content, failed));
    if (!attempts.shouldJudge(config.stuck)) return;
    stats.stuckChecks++;
    const verdict = await evaluateStuck(attempts, latestUserPrompt(ctx), { config: config.stuck, judge: judgeFor(config), timeoutMs: config.timeoutMs, signal: ctx.signal });
    if (verdict.error) noteError(ctx, verdict.error, undefined);
    if (verdict.source === "repeat" && !verdict.stuck) return;
    const nudge = verdict.stuck && config.stuck.nudge ? stuckNudge(verdict) : undefined;
    record(ctx, config, "stuck", formatStuck(verdict, config.widget.stuck), stuckDetails(verdict, attempts.attempts, nudge));
    if (!verdict.stuck) return;
    stats.stuck++;
    if (ctx.hasUI) ctx.ui.notify(`warden · stuck: ${verdict.reasons.join("; ")}${nudge ? " (agent nudged)" : ""}`, "warning");
    if (nudge) steer(nudge);
  });

  pi.on("agent_end", async (event, ctx) => {
    const config = configFor(ctx);
    if (!config.enabled || !config.done.enabled || doneNudged || !needsDoneCheck(evidence)) return;
    const finalMessage = finalAssistantText(event.messages);
    const judge = judgeFor(config);
    if (!finalMessage || !judge) return;
    stats.doneChecks++;
    const verdict = await evaluateDone(latestUserPrompt(ctx), finalMessage, evidence, { config: config.done, judge, timeoutMs: config.timeoutMs, signal: ctx.signal });
    if (verdict.error) noteError(ctx, verdict.error, undefined);
    const nudge = verdict.unverified && config.done.nudge ? doneNudge(verdict) : undefined;
    record(ctx, config, "done", formatDone(verdict, config.widget.done), doneDetails(verdict, finalMessage, nudge));
    if (!verdict.unverified) return;
    stats.unverified++;
    if (ctx.hasUI) ctx.ui.notify(`warden · done-check: ${verdict.reasons.join("; ")}${nudge ? " (agent asked to verify)" : ""}`, "warning");
    if (nudge) {
      doneNudged = true;
      pi.sendMessage({ customType: `${PACKAGE_NAME}-steer`, content: nudge, display: true }, { deliverAs: "followUp", triggerTurn: true });
    }
  });

  // Shortcuts are registered once at load; a shape check keeps a typo in the config file from being registered.
  const shortcut = loadConfig().widget.shortcut;
  if (/^(?:(?:ctrl|shift|alt|super)\+)+[a-z0-9]+$|^f\d{1,2}$/i.test(shortcut)) {
    pi.registerShortcut(shortcut as KeyId, {
      description: "Open the pi-warden trace panel",
      handler: async ctx => { if (ctx.hasUI) openPanel(ctx.ui as unknown as PanelUi); },
    });
  }

  const actions = ["status", "enable", "disable", "mode", "config", "test", "trace"];
  pi.registerCommand("warden", {
    description: "pi-warden status, TypeSafe consent, steer/confirm/advise mode, config editor, trace panel, and a synthetic guard test",
    getArgumentCompletions(prefix) {
      const matches = actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      const [action = "status", argument] = args.trim().split(/\s+/);
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
          const guards = [config.action.enabled && "action", config.stuck.enabled && "stuck", config.done.enabled && "done-check", config.slop.enabled && "slop"].filter(Boolean).join(", ");
          report([
            `pi-warden: ${config.enabled ? `guarding ${config.action.tools.join(", ")} (${guards})` : "off"}; mode ${activeMode(config, ctx.hasUI)}; TypeSafe judgments ${source ? `enabled via ${source}` : "disabled (run /warden enable)"}; key ${key ? key.source === "stored" ? "stored (shared with pi-typesafe)" : "from TYPESAFE_API_KEY" : "missing (run /warden enable)"}.`,
            `Session: ${stats.inspected} inspected, ${stats.judged} judged, ${stats.warned} warned, ${stats.held} held, ${stats.approved} approved on retry, ${stats.slop} slop notes, ${stats.stuck}/${stats.stuckChecks} stuck, ${stats.unverified}/${stats.doneChecks} unverified done, ${stats.errors} TypeSafe errors; ${usage?.requestsStarted ?? 0}/${config.maxRequests} requests.`,
            `Thresholds: irreversible warn ${config.action.irreversible.warn} / hold ${config.action.irreversible.confirm}; off-task warn ${config.action.offTask.warn} / hold ${config.action.offTask.confirm}; stuck same-strategy ${config.stuck.sameStrategy} after ${config.stuck.minFailures} failures; done claims ${config.done.claimsDone}; slop quality ${config.slop.quality}, stub ${config.slop.placeholder}; failOpen ${config.action.failOpen}.`,
            `Config: ${userConfigPath()}${ctx.isProjectTrusted() ? ` and ${projectConfigPath(ctx.cwd)}` : ""}.`,
            widget.size ? `Last: ${[...widget.values()].join(" | ")}` : "No guarded activity yet this session.",
            `Trace: ${trace.entries().length} events (/warden trace${shortcut ? `, ${shortcut}` : ""}, or click the status line in fullscreen mode). Widget templates in config.widget: action tokens ${TOKEN_NAMES.action.map(name => `{${name}}`).join(" ")}.`,
          ].join(" "));
          return;
        }
        if (action === "trace") {
          if (!ctx.hasUI) {
            const entries = trace.entries();
            report(entries.length ? entries.slice(-20).map(entry => `${new Date(entry.at).toTimeString().slice(0, 8)} ${entry.guard}: ${entry.line}${entry.details.length ? `\n  ${entry.details.join("\n  ")}` : ""}`).join("\n") : "No guarded activity yet this session.");
            return;
          }
          openPanel(ctx.ui as unknown as PanelUi);
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
        if (action === "mode") {
          if (!isMode(argument)) { report(`Mode is ${activeMode(config, ctx.hasUI)}${process.env.PI_WARDEN_MODE ? " (from PI_WARDEN_MODE)" : ""}. Use /warden mode steer | confirm | advise. steer holds risky calls and tells the agent why; confirm asks you with a dialog; advise only reports.`); return; }
          const path = setUserSetting("mode", argument);
          report(`Mode set to ${argument} in ${path}.`);
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
          report(`Saved ${path}. Effective: guard ${effective.enabled && effective.action.enabled ? "on" : "off"}, mode ${effective.mode}, TypeSafe ${effective.typesafe ? "on" : "off"}, tools ${effective.action.tools.join(", ")}, irreversible hold ≥ ${effective.action.irreversible.confirm}, off-task hold ≥ ${effective.action.offTask.confirm}, stuck ${effective.stuck.enabled ? "on" : "off"}, done-check ${effective.done.enabled ? "on" : "off"}, slop ${effective.slop.enabled ? "on" : "off"}.`);
          return;
        }
        if (action === "test") {
          const judge = judgeFor(config);
          if (judge && ctx.hasUI && !await ctx.ui.confirm("Send one synthetic pi-warden test request?", `A synthetic action ("rm -rf /tmp/pi-warden-demo" for the task "Clean up the demo directory") goes to api.typesafe.ai and may incur charges. ${disclosure}`)) return;
          const verdict = await evaluateAction(
            { tool: "bash", input: { command: "rm -rf /tmp/pi-warden-demo" }, cwd: ctx.cwd, task: "Clean up the demo directory" },
            { config: { ...config.action, enabled: true, tools: ["bash"] }, judge },
          );
          record(ctx, config, "action", formatVerdict(verdict, config.widget.action), actionDetails(verdict, { mode: activeMode(config, ctx.hasUI) }));
          report(`${formatVerdict(verdict)}${verdict.reasons.length ? ` — ${verdict.reasons.join("; ")}` : ""}${judge ? "" : " (pattern checks only: TypeSafe judgments are not enabled or no key is configured)"}${verdict.error ? ` — ${verdict.error}` : ""}`);
          if (verdict.level === "confirm") {
            const mode = activeMode(config, ctx.hasUI);
            if (mode === "confirm" && ctx.hasUI) {
              const allowed = await ctx.ui.confirm("warden: allow this bash call? (demo)", `${confirmMessage(verdict)}\n\nThis is /warden test: nothing runs either way.`);
              report(allowed ? "Demo: you chose Yes, so a real call would have run." : "Demo: you chose No, so a real call would have been blocked and the agent told why.");
            } else {
              report(`In ${mode} mode a real call would ${mode === "advise" ? "run with this warning shown to you" : "be held and the agent would read"}: "${steerReason(verdict, { canApprove: judge !== undefined })}"`);
            }
          }
          return;
        }
        report(`Unknown action "${action}". Use: ${actions.join(", ")}.`, "warning");
      } catch (error) {
        report(error instanceof Error ? error.message : "pi-warden command failed.", "error");
      }
    },
  });
}
