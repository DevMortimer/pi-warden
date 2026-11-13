import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultHostDirs } from "../host-dirs.js";
import { HostFileError, object, readText, replaceText } from "./io.js";
import type { HostName } from "./state.js";

/** What differs between hosts that read Claude-style `{ hooks: { <event>: [{ matcher, hooks: [...] }] } }` JSON. */
export interface HookHost {
  name: HostName;
  /** Nouns for diagnostics: the host, its file, and the hook groups inside it. */
  title: string;
  file: string;
  groups: string;
  hooks: ReadonlyArray<{ event: string; matcher: string }>;
}

export const CLAUDE_HOST: HookHost = {
  name: "claude", title: "Claude", file: "settings", groups: "settings hooks",
  hooks: [
    { event: "PreToolUse", matcher: "Edit" },
    { event: "PostToolUse", matcher: "Write|Edit" },
    { event: "PostToolUseFailure", matcher: "Edit" },
  ],
};

/** Codex reports every file edit as `apply_patch`, and runs `PostToolUse` only after the patch applied. */
export const CODEX_HOST: HookHost = {
  name: "codex", title: "Codex", file: "hooks", groups: "hook groups",
  hooks: [{ event: "PostToolUse", matcher: "apply_patch" }],
};

interface OwnedHook { event: string; matcher: string; hook: Record<string, unknown> }
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
const handler = (host: HookHost, event: string): Record<string, unknown> => ({ type: "command", command: `pi-warden hook ${host.name} ${event}`, timeout: 10 });

/** Claude: `~/.claude/settings.json`. Codex: `hooks.json` in `$CODEX_HOME` (default `~/.codex`). `--project` uses the project's folder. */
export function hookSettingsPath(host: HookHost, cwd: string, project: boolean): string {
  if (host.name === "claude") return join(project ? cwd : homedir(), ".claude", "settings.json");
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(project ? join(cwd, ".codex") : codexHome ? resolve(codexHome) : join(homedir(), ".codex"), "hooks.json");
}

function matches(value: unknown, expected: Record<string, unknown>): boolean {
  return object(value) && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => value[key] === item);
}

function ownedHook(host: HookHost): (value: unknown) => value is OwnedHook {
  return (value): value is OwnedHook => {
    if (!object(value)) return false;
    const definition = host.hooks.find(item => item.event === value.event);
    return definition !== undefined && value.matcher === definition.matcher && matches(value.hook, handler(host, definition.event));
  };
}

function parseJson(text: string, path: string, kind: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new HostFileError(path, `Invalid ${kind} JSON.`); }
}

async function receiptFor(host: HookHost, path: string, settingsText: string | undefined): Promise<ReceiptFile> {
  const settings = hash(resolve(path));
  const receiptPath = join(defaultHostDirs().agentDir, "pi-warden", "hosts", host.name, `${settings}.json`);
  const owned = ownedHook(host);
  const kind = `${host.title} installation receipt`;
  let text = await readText(receiptPath, undefined, 16 * 1024);
  const raw: unknown = text === undefined ? { version: 1, settings, owned: [] } : parseJson(text, receiptPath, kind);
  if (!object(raw) || raw.version !== 1 || raw.settings !== settings || !Array.isArray(raw.owned) || !raw.owned.every(owned)) throw new HostFileError(receiptPath, `Invalid ${kind}.`);
  const value = raw as unknown as Receipt;
  if (value.pending !== undefined) {
    const pending = value.pending;
    if (!object(pending) || typeof pending.before !== "string" || typeof pending.after !== "string" || !Array.isArray(pending.added) || !pending.added.every(owned)) throw new HostFileError(receiptPath, `Invalid pending ${kind}.`);
    const current = fingerprint(settingsText);
    if (current === pending.after) value.owned.push(...pending.added);
    else if (current !== pending.before) throw new HostFileError(receiptPath, `Interrupted ${host.title} installation changed outside Warden; preserve it and inspect the ${host.file}.`);
    delete value.pending;
    const next = json(value);
    await replaceText(receiptPath, next, text);
    text = next;
  }
  return { path: receiptPath, text, value };
}

function settingsFrom(host: HookHost, text: string | undefined, path: string): Record<string, unknown> & { hooks: Record<string, unknown> } {
  const settings: unknown = text === undefined ? {} : parseJson(text, path, `${host.title} ${host.file}`);
  if (!object(settings) || (settings.hooks !== undefined && !object(settings.hooks))) throw new HostFileError(path, `Invalid ${host.title} ${host.file}.`);
  settings.hooks ??= {};
  const value = settings as Record<string, unknown> & { hooks: Record<string, unknown> };
  // Validate every group before a pending receipt can be reconciled on disk.
  for (const definition of host.hooks) groupsFor(host, value.hooks, definition.event, path);
  return value;
}

function groupsFor(host: HookHost, hooks: Record<string, unknown>, event: string, path: string): Array<Record<string, unknown> & { hooks: unknown[] }> {
  const groups = hooks[event] ?? [];
  if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks))) throw new HostFileError(path, `Invalid ${host.title} ${host.groups}.`);
  return groups;
}

export async function installHooks(host: HookHost, path: string): Promise<void> {
  const text = await readText(path);
  const settings = settingsFrom(host, text, path);
  const receipt = await receiptFor(host, path, text);
  const added: OwnedHook[] = [];
  for (const definition of host.hooks) {
    const groups = groupsFor(host, settings.hooks, definition.event, path);
    const hook = handler(host, definition.event);
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

export async function uninstallHooks(host: HookHost, path: string): Promise<number> {
  const text = await readText(path);
  const settings = settingsFrom(host, text, path);
  const receipt = await receiptFor(host, path, text);
  let changed = false;
  let retained = 0;
  for (const owned of receipt.value.owned) {
    const groups = groupsFor(host, settings.hooks, owned.event, path);
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
    if (await readText(receipt.path) !== receipt.text) throw new HostFileError(receipt.path, `${host.title} installation receipt changed during removal.`);
    await rm(receipt.path).catch(error => { throw HostFileError.from(receipt.path, error); });
  }
  return retained;
}
