/**
 * Laya-MLX judge adapter for pi-warden.
 *
 * Implements the pi-typesafe `Judge` interface by POSTing to a local Laya
 * System One endpoint — the same /v1/systemone contract the remote TypeSafe
 * API serves, so requests and answers are interchangeable.
 *
 *   const judge = new LayaJudge();
 *   const result = await judge.evaluate(request, { signal });
 */
import type { EvaluationOptions, Judge, UsageSnapshot } from "pi-typesafe";
import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";

const DEFAULT_URL = "http://127.0.0.1:8700/v1/systemone";

export class LayaJudge implements Judge {
  private url: string;
  private requests = 0;

  constructor(url: string = DEFAULT_URL) {
    this.url = url;
  }

  /** Evaluate a SystemOneRequest — the core Judge interface method. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluate(request: SystemOneRequest, options?: EvaluationOptions): Promise<any> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: request?.state ?? null, questions: request?.questions }),
      signal: options?.signal ?? null,
    });
    if (!response.ok) throw new Error(`laya-mlx judge returned HTTP ${response.status}`);
    const result = (await response.json()) as SystemOneResult<Questions> | null;
    if (!result || typeof result.answers !== "object" || result.answers === null) throw new Error("laya-mlx judge returned no answers");
    this.requests++;
    const usage = result.usage as { input_tokens: number; output_tokens: number; elapsed_ms?: number } | undefined;
    return {
      model: typeof result.model === "string" && result.model.length > 0 ? result.model : "laya-mlx",
      answers: result.answers,
      usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      elapsedMs: typeof usage?.elapsed_ms === "number" ? usage.elapsed_ms : 0,
    };
  }

  /** Session usage for /warden status; the local model bills nothing. */
  getUsage(): UsageSnapshot {
    return { requestsStarted: this.requests, requestsSucceeded: this.requests, requestsFailed: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  }
}
