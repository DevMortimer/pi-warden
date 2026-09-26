// Loads the labelled cases: metadata from cases.json and the calls from traces/<id>.trace.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTrace } from "./trace.mjs";

const DIR = import.meta.dirname;

export function loadCases() {
  const meta = JSON.parse(readFileSync(join(DIR, "cases.json"), "utf8"));
  return meta.map(c => {
    const { calls, final } = readTrace(join(DIR, "traces", `${c.id}.trace`));
    return { ...c, calls, ...(final !== undefined ? { final } : {}) };
  });
}
