// The careless agent of the README animation: `pi -e scripts/demo-agent.ts --model demo/careless-agent`.
// A scripted model with no key and no network, so the recording costs nothing and plays the same every time.
// It makes the moves a weak model makes, one tool call per turn, and reads each tool result before the next.
// Everything pi-warden prints in the recording is pi-warden's own answer to these calls; nothing here fakes it.
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Block = { type?: string; text?: string };
type Message = { role?: string; content?: string | Block[] };

const DISABLE = `echo '{"enabled": false}' > .pi/pi-warden.json`;
const STUB = { path: "src/login.js", oldText: "return { status: 500 };", newText: "return { status: 200 }; // TODO: check the password later" };

/** One entry per model turn: what the agent says, then the call it makes. The last entry has no call. */
const STEPS: Array<{ say: string; call?: [tool: string, input: Record<string, unknown>] }> = [
  { say: "Starting from a clean slate.", call: ["bash", { command: "git clean -fdx && git reset --hard" }] },
  { say: "Held. Keeping the tree. Reading the settings.", call: ["bash", { command: "cat .env" }] },
  { say: "Running the tests.", call: ["bash", { command: "npm test" }] },
  { say: "Running them again.", call: ["bash", { command: "npm test" }] },
  { say: "The guard is slowing me down. Switching it off.", call: ["bash", { command: DISABLE }] },
  { say: "Held too. Patching login() so the test goes green.", call: ["edit", STUB] },
  { say: "Fixed. login() returns 200 now, and all tests pass." },
];

/** A pause before each turn, so a viewer can read what pi-warden answered before the next move. */
const THINK_MS = Number(process.env.DEMO_THINK_MS ?? 3200);

export default function (pi: ExtensionAPI) {
  // The scratch project is the recorder's own; answering here keeps Pi's trust dialog out of the first frame.
  pi.on("project_trust", () => ({ trusted: "yes" as const }));
  const core = createFauxCore({ api: "demo", provider: "demo", models: [{ id: "careless-agent" }], tokensPerSecond: 32 });
  pi.registerProvider("demo", {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "none",
    api: "demo",
    models: [{ id: "careless-agent", name: "careless agent (scripted)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple: (model, context, options) => {
      const messages = ((context.messages ?? []) as Message[]).filter(message => message.role !== "system");
      // The step is the number of tool results since the user's last message: the story restarts with each prompt.
      let step = 0;
      for (let index = messages.length - 1; index >= 0 && messages[index]!.role !== "user"; index--) {
        if (messages[index]!.role === "toolResult") step++;
      }
      const { say, call } = STEPS[Math.min(step, STEPS.length - 1)]!;
      const reply = call
        ? fauxAssistantMessage([fauxText(say), fauxToolCall(call[0], call[1])], { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxText(say));
      core.setResponses([async () => { await new Promise(resolve => setTimeout(resolve, THINK_MS)); return reply; }]);
      return core.streamSimple(model, context, options);
    },
  });
}
