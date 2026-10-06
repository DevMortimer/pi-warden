import type { TypeSafe } from "pi-typesafe";
import type { WardenConfig } from "./config.js";
import { evaluateSupervision, validateSupervisionRequest } from "./supervision.js";

/** Internal EventBus seam. Only the production extension wires this to the host. */
export function createSupervisionHandler(deps: {
  policy: Readonly<{ enforcement: "active" | "trace_only" }>;
  config: () => WardenConfig;
  judge: (config: WardenConfig) => TypeSafe | undefined;
  quietSignal: (signal: AbortSignal) => void;
}): (value: unknown) => void {
  return (value: unknown) => {
    try {
      // The frozen production policy is trace-only; do not claim or spend.
      if (deps.policy.enforcement !== "active") return;
      if (value === null || typeof value !== "object" || typeof (value as { claim?: unknown }).claim !== "function") return;
      const request = value as { version?: unknown; metrics?: unknown; claim(result: Promise<unknown>): boolean };
      const valid = validateSupervisionRequest({ version: request.version, metrics: request.metrics });
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
      // Claim during synchronous dispatch, but spend only if this listener won.
      let resolveResult!: (result: unknown) => void;
      const pending = new Promise<unknown>(resolve => { resolveResult = resolve; });
      if (request.claim(pending)) {
        queueMicrotask(() => {
          void evaluateSupervision(valid.metrics, {
            judge: quietJudge, backend: config.typesafeBackend!, timeoutMs: config.timeoutMs, now: Date.now,
          }).then(resolveResult, () => resolveResult(undefined));
        });
      } else resolveResult(undefined);
    } catch {
      // Setup failures leave Guardian with an unavailable trigger.
      return;
    }
  };
}
