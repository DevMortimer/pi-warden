import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** A probe tool that fails the same way every time, so the offline repeat detector fires without a judge. */
const probe: InlineExtension = ((pi: ExtensionAPI) => {
  pi.registerTool({
    name: "probe",
    label: "probe",
    description: "Fails the same way every call.",
    parameters: Type.Object({}),
    execute: async () => { throw new Error("probe failed identically"); },
  });
}) as unknown as InlineExtension;

/**
 * Runs one prompt in a session with pi-warden loaded, the agent calling the failing probe twice, and returns every
 * message list the model was sent plus the trace file's lines.
 */
async function runWithWarden(): Promise<{ requests: unknown[][]; trace: string; calls: number }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-notices-"));
  dirs.push(dir);
  const agentDir = join(dir, "agent");
  const traceDir = join(dir, "trace");
  await mkdir(join(agentDir, "pi-warden"), { recursive: true });
  await writeFile(join(agentDir, "pi-warden", "config.json"), JSON.stringify({ typesafe: false, notices: false, stuck: { enabled: true, nudge: true, repeatSteer: true } }));
  process.env.PI_WARDEN_TRACE_DIR = traceDir;
  try {
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [probe], additionalExtensionPaths: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, [], "the warden loads beside the probe");
    assert.equal(loaded.extensions.length, 2, "the probe and pi-warden are both loaded");
    const provider = faux.fauxProvider();
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(provider.provider);
    await modelRuntime.setRuntimeApiKey(provider.provider.id, "offline");
    const { session } = await createAgentSession({ cwd: dir, agentDir, modelRuntime, model: provider.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager: SettingsManager.inMemory(), noTools: "builtin" });
    const requests: unknown[][] = [];
    // Three replies so an extra request a notice started would be answered and counted, not fail the run.
    provider.setResponses([
      faux.fauxAssistantMessage(faux.fauxToolCall("probe", {})),
      (context: { messages: unknown[] }) => { requests.push(context.messages); return faux.fauxAssistantMessage(faux.fauxToolCall("probe", {})); },
      (context: { messages: unknown[] }) => { requests.push(context.messages); return faux.fauxAssistantMessage("Done."); },
      faux.fauxAssistantMessage("Extra reply."),
    ]);
    await session.prompt("run the probe twice");
    const trace = (await readdir(traceDir).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl")).map(name => readFile(join(traceDir, name), "utf8")).length
      ? (await Promise.all((await readdir(traceDir)).filter(name => name.endsWith(".jsonl")).map(name => readFile(join(traceDir, name), "utf8")))).join("")
      : "";
    const custom = session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && String((entry as { customType?: string }).customType ?? "").startsWith("pi-warden-"));
    assert.deepEqual(custom, [], "no pi-warden custom message is in the session");
    return { requests, trace, calls: provider.state.callCount };
  } finally {
    delete process.env.PI_WARDEN_TRACE_DIR;
  }
}

test("with pi-warden loaded, no model request carries a pi-warden message and no notice starts a turn", async () => {
  const { requests, trace, calls } = await runWithWarden();
  for (const messages of requests) {
    const ours = messages.filter(message => String((message as { customType?: unknown }).customType ?? "").startsWith("pi-warden-"));
    assert.deepEqual(ours, [], "no request the model saw carries a pi-warden custom message");
  }
  assert.equal(calls, 3, "the notice starts no turn of its own");

});
