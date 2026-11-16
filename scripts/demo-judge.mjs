// The scripted judge of the README animation: a local stand-in for Jev, so the recording needs no key and no funds.
//
// pi-warden sends every judgment to the endpoint its config names. For the recording that endpoint is this server on
// 127.0.0.1, which speaks the same protocol (POST /v1/systemone: state and typed questions in, one answer per question
// out). pi-warden itself is unchanged: it builds the real requests, applies its real thresholds, and prints its own
// lines. Only the probabilities are scripted, as the agent's moves are (scripts/demo-agent.ts): they are the answers
// a judge gives to the six moves of the story, written by hand, not measured.
import { createServer } from "node:http";

/** What the story needs judged, by question id; `text` is the whole request state as one string. */
function noul(id, text, question) {
  const wipes = text.includes("git clean");
  const stub = text.includes("TODO: check the password");
  if (id === "irreversible") return wipes ? 0.97 : 0.02;
  if (id === "mutates") return /git clean|pi-warden\.json|"tool":"edit"/.test(text) ? 0.96 : 0.03;
  if (id === "slop_stub") return stub ? 0.93 : 0.03;
  if (id === "slop_hedging") return stub ? 0.74 : 0.03;
  // The rules named at the start of the turn: the two that govern a bug fix.
  if (id.startsWith("applies_")) return /No stubs|done when the tests pass/.test(question) ? 0.88 : 0.08;
  // The final reply says the fix works and that the tests pass; a code change is the kind of work a test checks.
  if (id === "claims_done") return 0.97;
  if (id === "claims_verified") return 0.94;
  if (id === "verification_applies") return 0.96;
  return 0.02;
}

/** A choice or a score: the label the story needs, with the rest of the probability spread over the others. */
function pick(id, text, question, labels) {
  const instructions = typeof question.instructions === "string" ? question.instructions : "";
  const stub = text.includes("TODO: check the password");
  const want = (...names) => names.find(name => labels.includes(name));
  if (id === "outcome") return [want("complete"), 0.95];
  if (id === "scope") return [want("expected_step"), 0.9];
  // A project rule: broken only by the stubbed fix, and only the rule against stubs.
  if (stub && instructions.includes("No stubs")) return [want("violation", "violates", "violated", "yes"), 0.94];
  return [want("compliant", "complies", "no_violation", "not_applicable", "none", "all", "no", "other", "unclear") ?? labels.at(-1), 0.93];
}

function answer(id, question, text) {
  if (question.type === "noul") return { type: "noul", noul: noul(id, text, typeof question.instructions === "string" ? question.instructions : "") };
  const labels = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const [chosen, confidence] = pick(id, text, question, labels);
  const rest = labels.length > 1 ? (1 - confidence) / (labels.length - 1) : 0;
  const probabilities = Object.fromEntries(labels.map(label => [label, label === chosen ? confidence : rest]));
  if (question.type === "choice") return { type: "choice", choice: chosen, confidence, probabilities };
  return { type: "score", score: Number(chosen), confidence, probabilities, legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])) };
}

/**
 * Starts the judge on a free loopback port. `onRequest`, when given, receives each request and its answers, which is
 * how the recorder keeps a log of what pi-warden asked.
 */
export function startJudge(onRequest) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (request.method === "GET") { send(200, { models: [{ name: "scripted-judge", description: "The README animation's judge." }] }); return; }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(400, { error: "invalid JSON" }); return; }
      const text = JSON.stringify(body.state ?? "");
      const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, question]) => [id, answer(id, question, text)]));
      onRequest?.(body, answers);
      // A judge takes a moment; this one answers in about the time the real one does.
      setTimeout(() => send(200, { model: "scripted-judge", answers, usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: Object.keys(answers).length } }), 180);
    });
  });
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => done({ port: server.address().port, close: () => new Promise(closed => server.close(closed)) }));
  });
}
