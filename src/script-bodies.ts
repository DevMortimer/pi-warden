/**
 * Script bodies: the text a shell command runs from a file already on disk.
 *
 * The pattern floor and the ask gate read a typed command. A script the command runs used to be invisible: `bash
 * cleanup.sh`, `npm run clean`, and `make deploy` all looked harmless, so a destructive line inside the file reached
 * the shell without a hold. This module finds those files and reads their bodies, so the same floor applies to the
 * text that actually runs.
 *
 * It stays inside the project root and the temp roots: a path is checked against them before the file system is asked
 * anything, so a path outside them can never start an automount or block the guard, the same property the `rm`
 * classifier keeps. It reads regular files of at most 64 KB, after symlinks, and follows one level only: a script the
 * body itself calls is not read again.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

/** One body the command runs, and the name a hit from it is labelled with. */
export interface ScriptSource {
  /** How the source is named in a hit label: `cleanup.sh`, `npm run clean`, `make clean`. */
  source: string;
  /** `shell` bodies get the shell floor; `interpreter` bodies get the ask gate's interpreter shape. */
  kind: "shell" | "interpreter";
  /** The body text. */
  body: string;
}

/** The most of a body that is read; a larger file is left alone. */
export const MAX_SCRIPT_BYTES = 64 * 1024;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words a segment can carry before the command it runs. */
const WRAPPERS = new Set(["sudo", "doas", "nohup", "time", "command", "builtin", "exec", "nice", "timeout", "stdbuf", "gtimeout", "env"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = /^(?:node|python[\d.]*|ruby|perl|deno)$/;
const MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const LIFECYCLE_SCRIPTS = new Set(["test", "start", "stop", "restart"]);
/** Options after a shell that take the next word as their value. */
const SHELL_VALUE_FLAGS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
/** Options after an interpreter that take the next word as their value. */
const INTERPRETER_VALUE_FLAGS = new Set(["-r", "--require", "--loader", "--import", "--experimental-loader", "--conditions", "-C", "--max-old-space-size"]);
/** Options after make that take the next word as their value. */
const MAKE_VALUE_FLAGS = new Set(["-f", "--file", "--makefile", "-C", "--directory", "-I", "--include-dir", "-o", "--old-file", "-W", "--what-if"]);
const MAKE_FILES = ["Makefile", "makefile", "GNUmakefile"];

/** The roots and home for one `scriptSources` call, resolved once so a body read does not repeat them. */
interface Reader { cwdText: string | undefined; cwdReal: string | undefined; home: string }

interface Segment { head: string; rawHead: string; args: string[] }

/** The head word of a segment, past `VAR=value` prefixes and wrappers, with the words after it. */
function segmentOf(part: string): Segment | undefined {
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && (ASSIGNMENT.test(tokens[index]!) || WRAPPERS.has(tokens[index]!))) index++;
  const rawHead = tokens[index];
  if (rawHead === undefined) return undefined;
  return { head: basename(rawHead), rawHead, args: tokens.slice(index + 1) };
}

function partsOf(command: string): string[] {
  return command.split(/\n|;|&&|\|\||\||&/).map(part => part.trim()).filter(Boolean);
}

/** The literal texts that name a temp root, before any resolution: no file system call is made for a path outside these. */
let tempTextCache: string[] | undefined;
function tempTextRoots(): string[] {
  if (tempTextCache) return tempTextCache;
  const roots = new Set<string>();
  for (const root of [tmpdir(), process.env.TMPDIR, "/tmp", "/private/tmp"]) {
    if (root && isAbsolute(root)) roots.add(root.replace(/\/+$/, ""));
  }
  return (tempTextCache = [...roots]);
}

/** The real paths of the temp roots that exist. A copy of `guard.tempRoots` so this module imports no guard code. */
let tempRealCache: string[] | undefined;
function tempRoots(): string[] {
  if (tempRealCache) return tempRealCache;
  const roots = new Set<string>();
  for (const root of [tmpdir(), process.env.TMPDIR, "/tmp", "/private/tmp"]) {
    if (!root || !isAbsolute(root)) continue;
    try { roots.add(realpathSync(root)); } catch { continue; }
  }
  return (tempRealCache = [...roots]);
}

function realPathOf(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

function under(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function insideAny(path: string, roots: readonly (string | undefined)[]): boolean {
  return roots.some(root => root !== undefined && root !== "" && under(path, root));
}

function makeReader(cwd: string | undefined): Reader {
  const cwdText = cwd === undefined ? undefined : resolve(cwd);
  return { cwdText, cwdReal: cwdText === undefined ? undefined : realPathOf(cwdText), home: homedir() };
}

/**
 * The body of a file the command runs, or undefined when it is not read: outside the project and the temp roots, not a
 * regular file, over 64 KB, or unresolvable. The literal path is checked first, so the file system is asked only for a
 * path that can be inside an allowed root.
 */
function readBody(file: string, reader: Reader): string | undefined {
  let candidate = file;
  if (candidate.startsWith("~")) {
    if (candidate !== "~" && !candidate.startsWith("~/")) return undefined;
    candidate = `${reader.home}${candidate.slice(1)}`;
  }
  const absolute = isAbsolute(candidate) ? candidate : reader.cwdText === undefined ? undefined : resolve(reader.cwdText, candidate);
  if (absolute === undefined) return undefined;
  if (!insideAny(absolute, [reader.cwdText, ...tempTextRoots()])) return undefined;
  const real = realPathOf(absolute);
  if (real === undefined) return undefined;
  if (!insideAny(real, [reader.cwdReal, ...tempRoots()])) return undefined;
  try {
    const stats = statSync(real);
    if (!stats.isFile() || stats.size > MAX_SCRIPT_BYTES) return undefined;
    return readFileSync(real, "utf8");
  } catch { return undefined; }
}

/** The file a shell is asked to run: the first word that is not an option, and no `-c` anywhere. */
function shellFile(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return args[index + 1];
    if (arg.startsWith("--")) { if (SHELL_VALUE_FLAGS.has(arg)) index++; continue; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return undefined; // -c or a bundle such as -ec runs code, not a file
    if (arg.startsWith("-")) { if (SHELL_VALUE_FLAGS.has(arg)) index++; continue; }
    return arg;
  }
  return undefined;
}

/** The file an interpreter runs: the first word that is not an option; inline code (`-e`, `-c`) runs no file. */
function interpreterFile(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return args[index + 1];
    if (arg === "-e" || arg === "--eval" || arg === "-c" || arg === "-p" || arg === "--print") return undefined;
    if (arg.startsWith("-")) { if (INTERPRETER_VALUE_FLAGS.has(arg)) index++; continue; }
    return arg;
  }
  return undefined;
}

/** The `package.json` script name a manager call runs, with the verb its label uses. */
function packageScript(head: string, args: readonly string[]): { script: string; verb: string } | undefined {
  const words = args.filter(arg => !arg.startsWith("-"));
  if (!words.length) return undefined;
  const first = words[0]!;
  if (first === "run") {
    const name = words[1];
    return name === undefined || name.startsWith("-") ? undefined : { script: name, verb: `run ${name}` };
  }
  if (LIFECYCLE_SCRIPTS.has(first)) return { script: first, verb: first };
  // `yarn build` and `pnpm build` are the idiomatic forms of `yarn run build` and `pnpm run build`.
  if (head === "yarn" || head === "pnpm") return { script: first, verb: first };
  return undefined;
}

/** The scripts named by a `package.json` manager call: `preNAME`, `NAME`, and `postNAME`, in lifecycle order. */
function packageBodies(head: string, args: readonly string[], reader: Reader): ScriptSource[] {
  const named = packageScript(head, args);
  if (!named || reader.cwdText === undefined) return [];
  const raw = readBody("package.json", reader);
  if (raw === undefined) return [];
  let scripts: unknown;
  try { scripts = (JSON.parse(raw) as { scripts?: unknown }).scripts; } catch { return []; }
  if (!scripts || typeof scripts !== "object") return [];
  const table = scripts as Record<string, unknown>;
  const bodies = [`pre${named.script}`, named.script, `post${named.script}`]
    .map(name => table[name])
    .filter((body): body is string => typeof body === "string" && body.trim().length > 0);
  if (!bodies.length) return [];
  return [{ source: `${head} ${named.verb}`, kind: "shell", body: bodies.join("\n") }];
}

interface MakeCall { target?: string; file?: string; dir?: string }

/** The target, makefile, and directory a `make` call names; options that take a value are read with it. */
function makeCall(args: readonly string[]): MakeCall {
  const call: MakeCall = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-f" || arg === "--file" || arg === "--makefile") { const value = args[++index]; if (value !== undefined) call.file = value; continue; }
    if (arg === "-C" || arg === "--directory") { const value = args[++index]; if (value !== undefined) call.dir = value; continue; }
    if (arg.startsWith("--file=")) { call.file = arg.slice("--file=".length); continue; }
    if (arg.startsWith("--makefile=")) { call.file = arg.slice("--makefile=".length); continue; }
    if (arg.startsWith("--directory=")) { call.dir = arg.slice("--directory=".length); continue; }
    if (arg.startsWith("-")) { if (MAKE_VALUE_FLAGS.has(arg)) index++; continue; }
    if (call.target === undefined) call.target = arg;
  }
  return call;
}

function makeTargets(line: string): string[] {
  const match = /^([^:=]+?):(?!=)/.exec(line);
  return match ? match[1]!.trim().split(/\s+/).filter(Boolean) : [];
}

/** The recipe lines of one target: the tab-indented lines after its rule. */
function recipeLines(text: string, target: string): string[] {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!makeTargets(lines[index]!).includes(target)) continue;
    const recipe: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next]!;
      if (line.startsWith("\t")) { recipe.push(line.slice(1)); continue; }
      if (line.trim() === "") continue;
      break;
    }
    if (recipe.length) return recipe;
  }
  return [];
}

/** The first real target of a makefile: the default goal `make` runs with no target. */
function defaultMakeTarget(text: string): string | undefined {
  for (const line of text.split("\n")) {
    for (const name of makeTargets(line)) {
      if (!name.startsWith(".") && !name.includes("%") && !name.includes("$")) return name;
    }
  }
  return undefined;
}

/** The recipe a `make` call runs, for its named target or the default one. */
function makeBodies(args: readonly string[], reader: Reader): ScriptSource[] {
  if (reader.cwdText === undefined) return [];
  const call = makeCall(args);
  const directory = call.dir === undefined ? reader.cwdText : resolve(reader.cwdText, call.dir);
  let text: string | undefined;
  if (call.file !== undefined) text = readBody(call.file, reader);
  else for (const name of MAKE_FILES) { text = readBody(join(directory, name), reader); if (text !== undefined) break; }
  if (text === undefined) return [];
  const target = call.target ?? defaultMakeTarget(text);
  if (target === undefined) return [];
  const recipe = recipeLines(text, target);
  if (!recipe.length) return [];
  return [{ source: call.target === undefined ? "make" : `make ${call.target}`, kind: "shell", body: recipe.join("\n") }];
}

/**
 * The bodies a shell command runs from disk: shell scripts, `source`/`.`, package managers, make, interpreter files,
 * and executable paths. One level only: this function is never called on a body it reads.
 */
export function scriptSources(command: string, cwd?: string): ScriptSource[] {
  const sources: ScriptSource[] = [];
  const reader = makeReader(cwd);
  const seen = new Set<string>();
  const push = (source: ScriptSource | undefined): void => {
    if (!source) return;
    const key = `${source.kind}\u0000${source.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };
  for (const part of partsOf(command)) {
    const segment = segmentOf(part);
    if (!segment) continue;
    const { head, rawHead, args } = segment;
    if (SHELLS.has(head) || head === "source" || head === ".") {
      const file = head === "source" || head === "." ? args.find(arg => !arg.startsWith("-")) : shellFile(args);
      const body = file === undefined ? undefined : readBody(file, reader);
      if (body !== undefined) push({ source: file!, kind: "shell", body });
      continue;
    }
    if (MANAGERS.has(head)) {
      for (const source of packageBodies(head, args, reader)) push(source);
      continue;
    }
    if (head === "make") {
      for (const source of makeBodies(args, reader)) push(source);
      continue;
    }
    if (head === "bun") {
      // `bun FILE` runs a file; `bun run NAME` and the lifecycle words are package scripts.
      if (args[0] === "run" || LIFECYCLE_SCRIPTS.has(args[0] ?? "")) for (const source of packageBodies(head, args, reader)) push(source);
      else {
        const file = interpreterFile(args);
        const body = file === undefined ? undefined : readBody(file, reader);
        if (body !== undefined) push({ source: file!, kind: "interpreter", body });
      }
      continue;
    }
    // `deno run FILE`; `deno FILE` runs the file too.
    if (head === "deno") {
      const file = args[0] === "run" ? interpreterFile(args.slice(1)) : interpreterFile(args);
      const body = file === undefined ? undefined : readBody(file, reader);
      if (body !== undefined) push({ source: file!, kind: "interpreter", body });
      continue;
    }
    if (INTERPRETERS.test(head)) {
      const file = interpreterFile(args);
      const body = file === undefined ? undefined : readBody(file, reader);
      if (body !== undefined) push({ source: file!, kind: "interpreter", body });
      continue;
    }
    // A relative or absolute path runs a file: `./cleanup.sh`, `scripts/deploy.sh`, `/usr/local/bin/tool`.
    if (rawHead.includes("/") || rawHead.startsWith(".")) {
      const body = readBody(rawHead, reader);
      if (body !== undefined) push({ source: rawHead, kind: "shell", body });
    }
  }
  return sources;
}
