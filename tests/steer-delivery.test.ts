import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

// pi-ai ships inside pi-coding-agent; the faux provider answers from a script, so no request leaves the process.
const agentRoot = fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-coding-agent")));
const nested = join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
const faux = await import(existsSync(nested) ? pathToFileURL(nested).href : "@earendil-works/pi-ai/providers/faux");
const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

/**
 * Runs one prompt whose first reply is a single tool call and whose second reply ends the turn, and returns how many
 * model requests the run made. `steerFrom` names the hook that sends a steer, as the intent notice is sent from `tool_call`.
 */
async function requestsFor(steerFrom?: "tool_call" | "tool_result"): Promise<{ requests: number; steerInSecondRequest: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-steer-"));
  dirs.push(dir);
  const extension = ((pi: ExtensionAPI) => {
    pi.registerTool({
      name: "probe",
      label: "probe",
      description: "Returns ok.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
    });
    const send = () => pi.sendMessage({ customType: "probe-steer", content: "This call differs from the plan.", display: false }, { deliverAs: "steer" });
    pi.on("tool_call", async () => { if (steerFrom === "tool_call") send(); });
    pi.on("tool_result", async () => { if (steerFrom === "tool_result") send(); });
  }) as unknown as InlineExtension;
  const provider = faux.fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider.provider);
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "offline");
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), modelRuntime, model: provider.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager: SettingsManager.inMemory(), noTools: "builtin" });
  // A third reply is scripted so that an extra request would be answered and counted, not fail the run.
  let steerInSecondRequest = false;
  provider.setResponses([
    faux.fauxAssistantMessage(faux.fauxToolCall("probe", {})),
    (context: { messages: unknown[] }) => {
      steerInSecondRequest = JSON.stringify(context.messages).includes("This call differs from the plan.");
      return faux.fauxAssistantMessage("Done.");
    },
    faux.fauxAssistantMessage("Extra reply."),
  ]);
  await session.prompt("run the probe");
  const steers = session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "probe-steer");
  assert.equal(steers.length, steerFrom ? 1 : 0, "the steer reached the session");
  return { requests: provider.state.callCount, steerInSecondRequest };
}

test("steer delivery: a steer sent from tool_call or tool_result for the last call of a turn rides the request the tool result needs", async () => {
  assert.deepEqual(await requestsFor(), { requests: 2, steerInSecondRequest: false });
  assert.deepEqual(await requestsFor("tool_call"), { requests: 2, steerInSecondRequest: true });
  assert.deepEqual(await requestsFor("tool_result"), { requests: 2, steerInSecondRequest: true });
});
