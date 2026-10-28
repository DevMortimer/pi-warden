import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultHostDirs } from "../host-dirs.js";
import { HostFileError, object, readText, replaceText } from "./io.js";

export const CLAUDE_HOOKS = [
  { event: "PreToolUse", matcher: "Edit" },
  { event: "PostToolUse", matcher: "Write|Edit" },
  { event: "PostToolUseFailure", matcher: "Edit" },
] as const;
type HookEvent = typeof CLAUDE_HOOKS[number]["event"];
interface OwnedHook { event: HookEvent; matcher: string; hook: Record<string, unknown> }
interface Receipt {
  version: 1;
  settings: string;
  owned: OwnedHook[];
  pending?: { before: string; after: string; added: OwnedHook[] };
}
interface ReceiptFile { path: string; text: string | undefined; value: Receipt }

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const fingerprint = (text: string | undefined): string => hash(JSON.stringify([text]));
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const handler = (event: HookEvent): Record<string, unknown> => ({ type: "command", command: `pi-warden hook claude ${event}`, timeout: 10 });

export function claudeSettingsPath(cwd: string, project: boolean): string {
  return join(project ? cwd : homedir(), ".claude", "settings.json");
}

function matches(value: unknown, expected: Record<string, unknown>): boolean {
  return object(value) && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => value[key] === item);
}

function ownedHook(value: unknown): value is OwnedHook {
  if (!object(value)) return false;
  const definition = CLAUDE_HOOKS.find(item => item.event === value.event);
  return definition !== undefined && value.matcher === definition.matcher && matches(value.hook, handler(definition.event));
}

function parseJson(text: string, path: string, kind: "settings" | "installation receipt"): unknown {
  try { return JSON.parse(text); }
  catch { throw new HostFileError(path, `Invalid Claude ${kind} JSON.`); }
}

async function receiptFor(path: string, settingsText: string | undefined): Promise<ReceiptFile> {
  const settings = hash(resolve(path));
  const receiptPath = join(defaultHostDirs().agentDir, "pi-warden", "hosts", "claude", `${settings}.json`);
  let text = await readText(receiptPath, undefined, 16 * 1024);
  const raw: unknown = text === undefined ? { version: 1, settings, owned: [] } : parseJson(text, receiptPath, "installation receipt");
  if (!object(raw) || raw.version !== 1 || raw.settings !== settings || !Array.isArray(raw.owned) || !raw.owned.every(ownedHook)) throw new HostFileError(receiptPath, "Invalid Claude installation receipt.");
  const value = raw as unknown as Receipt;
  if (value.pending !== undefined) {
    const pending = value.pending;
    if (!object(pending) || typeof pending.before !== "string" || typeof pending.after !== "string" || !Array.isArray(pending.added) || !pending.added.every(ownedHook)) throw new HostFileError(receiptPath, "Invalid pending Claude installation receipt.");
    const current = fingerprint(settingsText);
    if (current === pending.after) value.owned.push(...pending.added);
    else if (current !== pending.before) throw new HostFileError(receiptPath, "Interrupted Claude installation changed outside Warden; preserve it and inspect the settings.");
    delete value.pending;
    const next = json(value);
    await replaceText(receiptPath, next, text);
    text = next;
  }
  return { path: receiptPath, text, value };
}

function settingsFrom(text: string | undefined, path: string): Record<string, unknown> & { hooks: Record<string, unknown> } {
  const settings: unknown = text === undefined ? {} : parseJson(text, path, "settings");
  if (!object(settings) || (settings.hooks !== undefined && !object(settings.hooks))) throw new HostFileError(path, "Invalid Claude settings.");
  settings.hooks ??= {};
  const value = settings as Record<string, unknown> & { hooks: Record<string, unknown> };
  // Validate every group before a pending receipt can be reconciled on disk.
  for (const definition of CLAUDE_HOOKS) groupsFor(value.hooks, definition.event, path);
  return value;
}

function groupsFor(hooks: Record<string, unknown>, event: HookEvent, path: string): Array<Record<string, unknown> & { hooks: unknown[] }> {
  const groups = hooks[event] ?? [];
  if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks))) throw new HostFileError(path, "Invalid Claude settings hooks.");
  return groups;
}

export async function installClaude(path: string): Promise<void> {
  const text = await readText(path);
  const settings = settingsFrom(text, path);
  const receipt = await receiptFor(path, text);
  const added: OwnedHook[] = [];
  for (const definition of CLAUDE_HOOKS) {
    const groups = groupsFor(settings.hooks, definition.event, path);
    const hook = handler(definition.event);
    // A pre-existing command belongs to its author, even when it looks exactly like ours.
    if (groups.some(group => group.hooks.some(item => object(item) && item.command === hook.command))) continue;
    groups.push({ matcher: definition.matcher, hooks: [hook] });
    settings.hooks[definition.event] = groups;
    added.push({ ...definition, hook });
  }
  if (!added.length) return;
  const next = json(settings);
  // Persist intent first; a failure after the settings rename can be reconciled without guessing ownership.
  const pending: Receipt = { ...receipt.value, pending: { before: fingerprint(text), after: fingerprint(next), added } };
  const pendingText = json(pending);
  await replaceText(receipt.path, pendingText, receipt.text);
  await replaceText(path, next, text);
  await replaceText(receipt.path, json({ ...receipt.value, owned: [...receipt.value.owned, ...added] }), pendingText);
}

export async function uninstallClaude(path: string): Promise<number> {
  const text = await readText(path);
  const settings = settingsFrom(text, path);
  const receipt = await receiptFor(path, text);
  let changed = false;
  let retained = 0;
  for (const owned of receipt.value.owned) {
    const groups = groupsFor(settings.hooks, owned.event, path);
    const eligible = groups.filter(group => group.matcher === owned.matcher && Object.keys(group).every(key => key === "matcher" || key === "hooks"));
    const count = eligible.reduce((total, group) => total + group.hooks.filter(hook => matches(hook, owned.hook)).length, 0);
    // Ambiguous duplicates and user-modified handlers are retained.
    if (count !== 1) {
      if (groups.some(group => group.hooks.some(hook => object(hook) && hook.command === owned.hook.command))) retained++;
      continue;
    }
    const emptied = new Set<Record<string, unknown>>();
    for (const group of eligible) {
      if (!group.hooks.some(hook => matches(hook, owned.hook))) continue;
      group.hooks = group.hooks.filter(hook => !matches(hook, owned.hook));
      if (!group.hooks.length) emptied.add(group);
    }
    const remaining = groups.filter(group => !emptied.has(group));
    if (remaining.length) settings.hooks[owned.event] = remaining;
    else delete settings.hooks[owned.event];
    changed = true;
  }
  if (changed) {
    if (!Object.keys(settings.hooks).length) delete (settings as Record<string, unknown>).hooks;
    await replaceText(path, json(settings), text);
  }
  if (receipt.text !== undefined) {
    if (await readText(receipt.path) !== receipt.text) throw new HostFileError(receipt.path, "Claude installation receipt changed during removal.");
    await rm(receipt.path).catch(error => { throw HostFileError.from(receipt.path, error); });
  }
  return retained;
}
