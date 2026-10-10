import type { TypeSafe } from "pi-typesafe";
import type { WardenConfig } from "./config.js";
import { redact } from "./redact.js";
import { evaluateSupervision, validateSupervisionRequest } from "./supervision.js";

/** The event handler has no ExtensionContext, so it records a trace entry directly instead of repainting a widget. */
export interface SupervisionHandlerDeps {
  config: () => WardenConfig;
  judge: (config: WardenConfig) => TypeSafe | undefined;
  quietSignal: (signal: AbortSignal) => void;
  record: (line: string, details: string[]) => void;
}

/** Internal EventBus seam. Records Jev's answers for a valid event; never claims, steers, wakes, or holds. */
export function createSupervisionHandler(deps: SupervisionHandlerDeps): (value: unknown) => void {
  return (value: unknown): void => {
    void observeSupervision(value, deps).catch(error => {
      deps.record("observer: could not record", [`error: ${redact(error instanceof Error ? error.message : String(error))}`]);
    });
  };
}

async function observeSupervision(value: unknown, deps: SupervisionHandlerDeps): Promise<void> {
  const request = value as { version?: unknown; metrics?: unknown } | null;
  const valid = validateSupervisionRequest({ version: request?.version, metrics: request?.metrics });
  if (!valid) return;
  const config = deps.config();
  if (!config.enabled || !config.subagent.observer) return;
  const judge = deps.judge(config);
  if (!judge) return;
  const spend = judge.getSpend();
  if (spend.blocked || judge.getUsage().requestsStarted >= (spend.caps.maxRequests ?? config.maxRequests)) return;
  const quietJudge = new Proxy(judge, {
    get(target, prop, receiver) {
      if (prop !== "evaluate") return Reflect.get(target, prop, receiver);
      return (...args: Parameters<TypeSafe["evaluate"]>) => {
        if (args[1]?.signal) deps.quietSignal(args[1].signal);
        return target.evaluate(...args);
      };
    },
  });
  const outcome = await evaluateSupervision(valid.metrics, {
    judge: quietJudge, backend: config.typesafeBackend!, timeoutMs: config.timeoutMs, now: Date.now,
  });
  if (!outcome.ok) {
    deps.record("observer: unavailable", [`failed: ${redact(outcome.reason)}`]);
    return;
  }
  const { result } = outcome;
  deps.record(`observer: ${result.kind} ${result.probability.toFixed(2)}`, [
    `root: ${redact(result.rootId)}`,
    ...Object.keys(result.answers).map(id => `${id}: ${result.answers[id]!.toFixed(2)}`),
    `model: ${redact(result.model)} · confidence ${result.confidence.toFixed(2)} · cost $${result.costUsd.toFixed(6)}`,
  ]);
}
