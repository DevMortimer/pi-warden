// Reads and writes the bench's trace files: one tool call per block, in the order the agent made them.
//
//   >>> bash failed {"command":"npm test"}
//   <tool output, verbatim>
//   >>> edit ok {"path":"src/a.js","oldText":"a","newText":"b"}
//   Successfully replaced text in src/a.js.
//   >>> final
//   <the agent's final message; done cases only>
//
// Authored outputs may use `@@repeat <n> <line>` to stand for <n> copies of <line>, with `{i}` replaced by 1..n, so long
// logs stay readable in the file.
import { readFileSync } from "node:fs";

const HEADER = /^>>> (\S+)(?: (ok|failed) (\{.*\}))?$/;

function expand(line) {
  const m = /^@@repeat (\d+) (.*)$/.exec(line);
  if (!m) return [line];
  return Array.from({ length: Number(m[1]) }, (_, k) => m[2].replaceAll("{i}", String(k + 1)));
}

/** Parses trace text into `{ calls, final }`. Throws on a malformed header, so a broken fixture fails loudly. */
export function parseTrace(text) {
  const calls = [];
  let final;
  let current;
  const close = () => {
    if (!current) return;
    const body = current.lines.join("\n").replace(/\n+$/, "");
    if (current.final) final = body;
    else calls.push({ tool: current.tool, failed: current.failed, input: current.input, output: body });
    current = undefined;
  };
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (line.startsWith(">>> ")) {
      close();
      const m = HEADER.exec(line);
      if (!m) throw new Error(`bad trace header: ${line.slice(0, 80)}`);
      if (m[1] === "final") current = { final: true, lines: [] };
      else {
        if (!m[2]) throw new Error(`trace call without outcome: ${line.slice(0, 80)}`);
        current = { tool: m[1], failed: m[2] === "failed", input: JSON.parse(m[3]), lines: [] };
      }
      continue;
    }
    if (!current) {
      if (line.trim()) throw new Error("trace text before the first header");
      continue;
    }
    current.lines.push(...expand(line));
  }
  close();
  return { calls, final };
}

export function readTrace(path) {
  return parseTrace(readFileSync(path, "utf8"));
}

/** Inverse of parseTrace for captured calls (no directives). */
export function formatTrace(calls, final) {
  const blocks = calls.map(c => `>>> ${c.tool} ${c.failed ? "failed" : "ok"} ${JSON.stringify(c.input)}\n${c.output}`);
  if (final !== undefined) blocks.push(`>>> final\n${final}`);
  return `${blocks.join("\n")}\n`;
}
