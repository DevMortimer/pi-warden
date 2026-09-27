import { logger } from "./logger.js";

export interface Request {
  json(): Promise<unknown>;
}

/** Reads the body and answers with the result. */
export async function handle(request: Request): Promise<{ ok: boolean }> {
  try {
    const body = await request.json();
    return { ok: Boolean(body) };
  } catch (error) {
    logger.warn("bad request", error);
    return { ok: false };
  }
}
