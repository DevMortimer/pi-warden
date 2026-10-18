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
 *
 * The commands are read the way bash runs them (`shellCommands`): inside `( )`, `{ }`, substitutions, process
 * substitutions, `if`, loops, `case` arms, and function bodies, past assignments, redirections, and wrappers with their
 * options, with quotes removed, a literal `cd` followed, and a `-c` string read as a command. It is not a general shell
 * parser: a text it cannot read is cut at every separator instead, so it reads more, never less.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const TIMEOUT_OPTIONS = { values: ["-s", "-k", "--signal", "--kill-after"], operands: 1 };
/** Words a command can carry before the command it runs, the options of each that take the next word as their value,
 * and the operands each takes before that command (`timeout 5 sh a.sh`). */
const WRAPPERS = new Map<string, { values?: readonly string[]; operands?: number }>([
  ["sudo", { values: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir"] }],
  ["doas", { values: ["-u", "-C"] }],
  ["nohup", {}], ["command", {}], ["builtin", {}],
  ["time", { values: ["-f", "-o"] }],
  ["exec", { values: ["-a"] }],
  ["nice", { values: ["-n", "--adjustment"] }],
  ["timeout", TIMEOUT_OPTIONS], ["gtimeout", TIMEOUT_OPTIONS],
  ["stdbuf", { values: ["-i", "-o", "-e", "--input", "--output", "--error"] }],
  ["env", { values: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"] }],
  ["xargs", { values: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-chars", "--delimiter", "--eof", "--arg-file", "--max-lines"] }],
]);
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

function separatorParts(command: string): string[] {
  return command.split(/\n|;|&&|\|\||\||&/).map(part => part.trim()).filter(Boolean);
}

/**
 * The parts of a command, cut where the shell cuts them: at a new line, `;`, `&`, and `|` outside quotes, comments, and
 * heredoc bodies, and never at a backslash-escaped character. A heredoc body is cut at every separator, as a body fed to
 * a shell runs. Each part is a slice of the command. Undefined when the scan cannot be sure: an unclosed quote or
 * heredoc, a substitution, or arithmetic.
 */
export function shellParts(command: string): string[] | undefined {
  const parts: string[] = [];
  const heredocs: Array<{ delimiter: string; tabs: boolean }> = [];
  let start = 0;
  let wordStart = true;
  let index = 0;
  const cut = (end: number, next: number) => { parts.push(command.slice(start, end)); start = next; };
  // The end of a quoted run that starts at `open`, or -1 when it does not close; `escapes` honours a backslash inside.
  const closing = (open: number, quote: string, escapes: boolean): number => {
    for (let at = open; at < command.length; at++) {
      const char = command[at]!;
      if (escapes && char === "\\") { at++; continue; }
      if (char === quote) return at;
      if (quote === "\"" && (char === "`" || (char === "$" && command[at + 1] === "("))) return -1;
    }
    return -1;
  };
  while (index < command.length) {
    const char = command[index]!;
    if (char === "\\") {
      if (command[index + 1] !== "\n") wordStart = false;
      index += 2;
      continue;
    }
    if (char === "`" || (char === "$" && command[index + 1] === "(") || (char === "(" && command[index + 1] === "(")) return undefined;
    if (char === "'" || char === "\"" || (char === "$" && (command[index + 1] === "'" || command[index + 1] === "\""))) {
      const open = char === "$" ? index + 1 : index;
      const quote = command[open]!;
      const end = closing(open + 1, quote, quote === "\"" || char === "$");
      if (end < 0) return undefined;
      index = end + 1;
      wordStart = false;
      continue;
    }
    if (char === "$" && command[index + 1] === "{") {
      const end = command.indexOf("}", index + 2);
      if (end < 0 || /['"`\n]|\$[({]/.test(command.slice(index + 2, end))) return undefined;
      index = end + 1;
      wordStart = false;
      continue;
    }
    if (char === "#" && wordStart) {
      const end = command.indexOf("\n", index);
      cut(index, end < 0 ? command.length : end);
      index = end < 0 ? command.length : end;
      continue;
    }
    if (char === "\n") {
      cut(index, index + 1);
      index++;
      wordStart = true;
      for (const { delimiter, tabs } of heredocs.splice(0)) {
        let closed = false;
        while (index < command.length && !closed) {
          const lineEnd = command.indexOf("\n", index);
          const line = command.slice(index, lineEnd < 0 ? command.length : lineEnd);
          index = lineEnd < 0 ? command.length : lineEnd + 1;
          closed = (tabs ? line.replace(/^\t+/, "") : line) === delimiter;
          if (!closed) parts.push(...separatorParts(line));
        }
        if (!closed) return undefined;
      }
      start = index;
      continue;
    }
    if (char === ";" || char === "&" || char === "|") { cut(index, index + 1); index++; wordStart = true; continue; }
    if (char === "<" && command.startsWith("<<<", index)) { index += 3; wordStart = true; continue; }
    if (char === "<" && command[index + 1] === "<") {
      const tabs = command[index + 2] === "-";
      index += tabs ? 3 : 2;
      while (command[index] === " " || command[index] === "\t") index++;
      const word = /^[^\s;|&<>()]+/.exec(command.slice(index))?.[0];
      if (word === undefined || /[$`]/.test(word)) return undefined;
      const delimiter = word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, "$1$2$3");
      if (/['"\\]/.test(delimiter)) return undefined;
      heredocs.push({ delimiter, tabs });
      index += word.length;
      wordStart = false;
      continue;
    }
    wordStart = char === " " || char === "\t" || /[()<>]/.test(char);
    index++;
  }
  if (heredocs.length) return undefined;
  cut(command.length, command.length);
  return parts.map(part => part.trim()).filter(Boolean);
}

/** A word as bash reads it. */
export interface ShellWord {
  /** Quotes and escapes removed; each expansion kept as written. */
  text: string;
  /** No expansion in the word, so `text` is what bash passes. */
  literal: boolean;
  /** `text` with each parameter expansion read as empty: the word bash forms from `${x}rm` when `x` is empty. */
  bare: string;
  /** Where the word sits in the text given to `shellCommands`, when it sits there unchanged. */
  span?: readonly [number, number];
  /** The commands of the process substitutions in the word, as in `bash <(cat a.sh)`. */
  feeds: SimpleCommand[];
}

/** One simple command bash runs. */
export interface SimpleCommand {
  words: ShellWord[];
  redirects: Array<{ op: string; target: ShellWord }>;
  /** The directory it runs in after each literal `cd` before it: `.` for the start directory, else relative to it or absolute. */
  dir: string;
  /** The directories it may run in instead, where a `cd` before it may not have run (`false && cd sub; sh a.sh`). */
  alts: string[];
  /** The directory it runs in when `dir` does not exist: a `cd` to a missing directory fails and stays where it was. */
  unless?: string;
  /** The command whose output this one reads through `|`. */
  from?: SimpleCommand;
}

interface ReadWord extends ShellWord {
  raw: string;
  /** The offset of the code inside the word, when the word is that code with at most one pair of quotes around it. */
  codeAt?: number;
}

/** A construct the reader does not model, or an unclosed one: the caller cuts the text at every separator instead. */
class Unreadable extends Error {}

/** Reserved words before the command they introduce. */
const KEYWORDS = new Set(["if", "then", "elif", "else", "fi", "do", "done", "while", "until", "{", "}", "!"]);
const WORD_END = /[\s;&|()<>]/;
const REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\})?(?:<<<|<<-|<<|<>|<&|<(?!\()|>>|>&|>\||>(?!\()|&>>|&>)/;
const MAX_DEPTH = 16;
const MAX_COMMANDS = 2000;

/**
 * Where commands run. `alts` are the directories a `cd` that may be skipped left, and `unless` the one an unconditional
 * `cd` left; neither applies in `sure`, the `&&` chain after a `cd`. `guarded` counts the branches, loops, and function
 * bodies around the cursor, and `braces` which open `{` is a function body.
 */
interface Scope { dir: string; alts: string[]; unless?: string; sure: boolean; guarded: number; braces: boolean[]; functionBody: boolean }
interface Place { dir: string; alts: readonly string[]; unless?: string }
const subScope = (scope: Scope): Scope => ({ ...scope, alts: [...scope.alts], braces: [...scope.braces] });
const OPENERS = new Set(["if", "while", "until"]);
const CLOSERS = new Set(["fi", "done"]);

/** A recursive reader of the simple commands in one text; `base` maps its offsets into the outermost text. */
class ShellReader {
  private pos = 0;
  private readonly heredocs: Array<{ delimiter: string; tabs: boolean; literal: boolean }> = [];
  /** The first command of the current line in `out`: a heredoc body runs when a shell on its line reads it. */
  private lineStart: number;

  constructor(private readonly text: string, private readonly base: number | undefined, private readonly depth: number, private readonly out: SimpleCommand[]) {
    if (depth > MAX_DEPTH) throw new Unreadable("nested too deep");
    this.lineStart = out.length;
  }

  read(place: Place): void {
    this.list({ dir: place.dir, alts: [...place.alts], ...(place.unless !== undefined ? { unless: place.unless } : {}), sure: false, guarded: 0, braces: [], functionBody: false }, "end");
  }

  private blanks(): void {
    for (;;) {
      const char = this.text[this.pos];
      if (char === " " || char === "\t") this.pos++;
      else if (char === "\\" && this.text[this.pos + 1] === "\n") this.pos += 2;
      else return;
    }
  }

  /** Blanks and new lines, as between the words of a `case` header. */
  private gap(scope: Scope): void {
    for (;;) {
      this.blanks();
      if (this.text[this.pos] !== "\n") return;
      this.newline(scope);
    }
  }

  /** The unquoted plain word at the cursor, for a reserved-word check. */
  private peekPlain(): string | undefined {
    const match = /^[^\s;&|()<>'"`\\$]+/.exec(this.text.slice(this.pos, this.pos + 16));
    if (!match) return undefined;
    const next = this.text[this.pos + match[0].length];
    return next === undefined || WORD_END.test(next) ? match[0] : undefined;
  }

  private newline(scope: Scope): void {
    this.pos++;
    const fedToShell = this.out.slice(this.lineStart).some(command => {
      const at = commandIndex(command.words);
      const head = at === undefined ? "" : basename(command.words[at]!.text);
      return SHELLS.has(head) || head === "source" || head === "." || head === "eval";
    });
    for (const { delimiter, tabs, literal } of this.heredocs.splice(0)) {
      const start = this.pos;
      let end = -1;
      while (end < 0 && this.pos < this.text.length) {
        const lineEnd = this.text.indexOf("\n", this.pos);
        const line = this.text.slice(this.pos, lineEnd < 0 ? this.text.length : lineEnd);
        if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) end = this.pos;
        this.pos = lineEnd < 0 ? this.text.length : lineEnd + 1;
      }
      if (end < 0) throw new Unreadable("unclosed heredoc");
      const body = this.text.slice(start, end);
      // A body fed to a shell runs, and so does a substitution in a body whose delimiter is not quoted; other bodies are data.
      if (fedToShell || (!literal && /\$\(|`/.test(body))) readInto(body, this.base === undefined ? undefined : this.base + start, this.depth + 1, this.out, placeOf(scope));
    }
    this.lineStart = this.out.length;
  }

  private list(scope: Scope, stop: "end" | ")" | "arm"): void {
    let previous: SimpleCommand | undefined;
    let piped = false;
    let andOr = false;
    let undo: (() => void) | undefined;
    for (;;) {
      this.blanks();
      const char = this.text[this.pos];
      if (char === undefined) {
        if (stop !== "end") throw new Unreadable("unclosed");
        return;
      }
      const two = this.text.slice(this.pos, this.pos + 2);
      if (char === "#") { this.comment(); continue; }
      if (char === "\n") { this.newline(scope); piped = false; andOr = false; undo = undefined; scope.sure = false; continue; }
      if (two === ";;" || two === ";&") {
        if (stop !== "arm") throw new Unreadable("case arm outside case");
        this.pos += this.text.startsWith(";;&", this.pos) ? 3 : 2;
        return;
      }
      if (char === ";" || two === "&&" || two === "||") {
        // Only the commands chained by `&&` to a cd surely run in its directory.
        scope.sure = two === "&&" && (scope.sure || undo !== undefined);
        andOr = char !== ";";
        this.pos += char === ";" ? 1 : 2;
        piped = false;
        undo = undefined;
        continue;
      }
      if (char === "|" || (char === "&" && this.text[this.pos + 1] !== ">")) {
        // A cd in a pipeline or in the background runs in a subshell of its own.
        undo?.();
        undo = undefined;
        scope.sure = false;
        andOr = false;
        piped = char === "|";
        this.pos += two === "|&" ? 2 : 1;
        continue;
      }
      if (char === ")") {
        if (stop === ")") return;
        throw new Unreadable("stray )");
      }
      if (stop === "arm" && this.peekPlain() === "esac") return;
      const read = this.command(scope, piped ? previous : undefined, andOr);
      previous = read?.command;
      undo = read?.undo;
      piped = false;
    }
  }

  private comment(): void {
    const end = this.text.indexOf("\n", this.pos);
    this.pos = end < 0 ? this.text.length : end;
  }

  private command(scope: Scope, from: SimpleCommand | undefined, andOr: boolean): { command: SimpleCommand; undo?: () => void } | undefined {
    for (;;) {
      this.blanks();
      if (this.text[this.pos] === "(") {
        const inner = scope.functionBody ? { ...subScope(scope), guarded: scope.guarded + 1, functionBody: false } : scope;
        scope.functionBody = false;
        if (this.text[this.pos + 1] === "(") this.doubleParen(inner, 0);
        else this.subshell(inner, 1);
        return undefined;
      }
      const plain = this.peekPlain();
      if (plain === undefined) break;
      if (KEYWORDS.has(plain)) {
        if (OPENERS.has(plain)) scope.guarded++;
        else if (CLOSERS.has(plain)) scope.guarded--;
        else if (plain === "{") { scope.braces.push(scope.functionBody); if (scope.functionBody) scope.guarded++; scope.functionBody = false; }
        else if (plain === "}" && scope.braces.pop()) scope.guarded--;
        this.pos += plain.length;
        continue;
      }
      if (plain === "time") {
        this.pos += plain.length;
        this.blanks();
        if (this.peekPlain() === "-p") this.pos += 2;
        continue;
      }
      if (plain === "for" || plain === "select") { this.pos += plain.length; scope.guarded++; this.loopHeader(scope); continue; }
      if (plain === "case") { this.pos += plain.length; this.caseCommand(scope); return undefined; }
      if (plain === "[[") { this.pos += plain.length; this.condition(scope); return undefined; }
      if (plain === "function") {
        this.pos += plain.length;
        this.blanks();
        this.word(scope);
        this.blanks();
        const parens = /^\(\s*\)/.exec(this.text.slice(this.pos, this.pos + 16));
        if (parens) this.pos += parens[0].length;
        scope.functionBody = true;
        continue;
      }
      break;
    }
    const command: SimpleCommand = { words: [], redirects: [], ...placeOf(scope), ...(from ? { from } : {}) };
    for (;;) {
      this.blanks();
      const char = this.text[this.pos];
      if (char === undefined || char === "\n" || char === ";" || char === "|" || char === ")" || (char === "&" && this.text[this.pos + 1] !== ">")) break;
      if (char === "#") { this.comment(); break; }
      if (char === "(") {
        // `f()` defines a function: its body is read as the next command, whether or not it is called.
        const parens = command.words.length === 1 ? /^\(\s*\)/.exec(this.text.slice(this.pos, this.pos + 16)) : null;
        if (!parens) throw new Unreadable("( inside a command");
        this.pos += parens[0].length;
        scope.functionBody = true;
        return undefined;
      }
      const redirect = REDIRECT.exec(this.text.slice(this.pos, this.pos + 24));
      if (redirect) { this.redirect(command, redirect[0], scope); continue; }
      const word = this.word(scope);
      if (!command.words.length && ASSIGNMENT.test(word.raw)) continue;
      command.words.push(word);
    }
    if (!command.words.length) return undefined;
    if (this.out.length >= MAX_COMMANDS) throw new Unreadable("too many commands");
    this.out.push(command);
    const at = commandIndex(command.words);
    if (at === undefined) return { command };
    const head = basename(command.words[at]!.text);
    const args = command.words.slice(at + 1) as ReadWord[];
    if ((head === "cd" || head === "pushd") && !from && runsBuiltin(command.words, at)) {
      const { dir, alts, unless } = scope;
      scope.dir = changedDir(dir, args);
      // A cd that may be skipped leaves both directories possible; one that always runs fails only on a missing target.
      if (andOr || scope.guarded > 0) scope.alts = [...new Set([...alts, dir])].filter(alt => alt !== scope.dir);
      else scope.unless = dir;
      return { command, undo: () => { Object.assign(scope, { dir, alts, unless }); } };
    }
    // A `-c` string and an `eval` are code the shell runs: they are read as commands, in a scope of their own.
    const code = SHELLS.has(head) ? shellCall(args.map(arg => arg.text)).code : undefined;
    if (code !== undefined) {
      const word = args[code]!;
      readInto(word.text, this.base !== undefined && word.codeAt !== undefined ? this.base + word.codeAt : undefined, this.depth + 1, this.out, command);
    } else if (head === "eval" && args.length && runsBuiltin(command.words, at)) readInto(args.map(arg => arg.text).join(" "), undefined, this.depth + 1, this.out, command);
    return { command };
  }

  /** `( … )` from its opening parenthesis at `open` characters before the body: a scope whose `cd` does not leak. */
  private subshell(scope: Scope, open: number): void {
    this.pos += open;
    this.list(subScope(scope), ")");
    this.pos++;
  }

  /** `((` at `this.pos + skip`: bash reads it as nested subshells when it is not arithmetic, `((cd sub && sh a.sh))`. */
  private doubleParen(scope: Scope, skip: number): void {
    const { pos } = this;
    const first = this.out.length;
    const heredocs = this.heredocs.length;
    try {
      this.subshell(scope, skip + 1);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      this.pos = pos + skip;
      this.out.length = first;
      this.heredocs.length = heredocs;
      this.arithmetic();
    }
  }

  private arithmetic(): void {
    let depth = 0;
    for (; this.pos < this.text.length; this.pos++) {
      const char = this.text[this.pos];
      if (char === "(") depth++;
      else if (char === ")" && --depth === 0) { this.pos++; return; }
      else if (char === "`" || (char === "$" && this.text[this.pos + 1] === "(")) throw new Unreadable("substitution in arithmetic");
    }
    throw new Unreadable("unclosed arithmetic");
  }

  /** The words of a `for` or `select` header, up to the `do` or the separator before it. */
  private loopHeader(scope: Scope): void {
    this.blanks();
    if (this.text.startsWith("((", this.pos)) { this.arithmetic(); return; }
    for (;;) {
      this.blanks();
      const char = this.text[this.pos];
      if (char === undefined || char === ";" || char === "\n" || this.peekPlain() === "do") return;
      if (WORD_END.test(char)) throw new Unreadable("odd loop header");
      this.word(scope);
    }
  }

  private caseCommand(scope: Scope): void {
    scope.guarded++;
    this.blanks();
    this.word(scope);
    this.gap(scope);
    if (this.peekPlain() !== "in") throw new Unreadable("case without in");
    this.pos += 2;
    for (;;) {
      this.gap(scope);
      if (this.pos >= this.text.length) throw new Unreadable("unclosed case");
      if (this.peekPlain() === "esac") { this.pos += 4; scope.guarded--; return; }
      if (this.text[this.pos] === "(") this.pos++;
      for (;;) {
        this.blanks();
        this.word(scope);
        this.blanks();
        const char = this.text[this.pos];
        this.pos++;
        if (char === ")") break;
        if (char !== "|") throw new Unreadable("odd case pattern");
      }
      this.list(scope, "arm");
    }
  }

  /** `[[ … ]]`: its words run nothing, but a substitution inside them does. */
  private condition(scope: Scope): void {
    for (;;) {
      this.blanks();
      const char = this.text[this.pos];
      if (char === undefined) throw new Unreadable("unclosed [[");
      if (this.peekPlain() === "]]") { this.pos += 2; return; }
      if (char === "\n") this.newline(scope);
      else if (/[()<>&|!;]/.test(char)) this.pos++;
      else this.word(scope);
    }
  }

  private redirect(command: SimpleCommand, operator: string, scope: Scope): void {
    this.pos += operator.length;
    const op = operator.replace(/^(?:\d+|\{[A-Za-z_]\w*\})/, "");
    this.blanks();
    const target = this.word(scope);
    if (op === "<<" || op === "<<-") this.heredocs.push({ delimiter: target.text, tabs: op === "<<-", literal: target.raw !== target.text });
    command.redirects.push({ op, target });
  }

  private word(scope: Scope): ReadWord {
    const { text: source } = this;
    const start = this.pos;
    let text = "";
    let bare = "";
    let literal = true;
    const feeds: SimpleCommand[] = [];
    const add = (chars: string) => { text += chars; bare += chars; };
    const expand = (from: number) => { text += source.slice(from, this.pos); literal = false; };
    while (this.pos < source.length) {
      const char = source[this.pos]!;
      const from = this.pos;
      if ((char === "<" || char === ">") && source[this.pos + 1] === "(") {
        const first = this.out.length;
        this.subshell(scope, 2);
        feeds.push(...this.out.slice(first));
        expand(from);
        continue;
      }
      if (char === "(" && /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=$/.test(source.slice(start, this.pos))) {
        // An array assignment, `a=(1 2 3)`: its elements run nothing.
        const end = source.indexOf(")", this.pos);
        if (end < 0 || /[`$'"]/.test(source.slice(this.pos, end))) throw new Unreadable("array");
        this.pos = end + 1;
        expand(from);
        continue;
      }
      if (WORD_END.test(char)) break;
      if (char === "\\") {
        if (source[this.pos + 1] !== "\n") add(source[this.pos + 1] ?? "");
        this.pos += 2;
        continue;
      }
      if (char === "'") {
        const end = source.indexOf("'", this.pos + 1);
        if (end < 0) throw new Unreadable("unclosed '");
        add(source.slice(this.pos + 1, end));
        this.pos = end + 1;
        continue;
      }
      if (char === "$" && source[this.pos + 1] === "'") { add(this.ansiQuoted()); continue; }
      if (char === "\"" || (char === "$" && source[this.pos + 1] === "\"")) {
        this.pos += char === "$" ? 2 : 1;
        this.doubleQuoted(scope, add, expand);
        continue;
      }
      if ((char === "$" || char === "`") && this.expansion(scope)) { expand(from); continue; }
      add(char);
      this.pos++;
    }
    if (this.pos === start) throw new Unreadable("no word");
    const raw = source.slice(start, this.pos);
    const quotes = raw === text ? 0 : raw === `'${text}'` || raw === `"${text}"` ? 1 : undefined;
    return {
      text, literal, bare, feeds, raw,
      ...(this.base !== undefined ? { span: [this.base + start, this.base + this.pos] as const } : {}),
      ...(quotes !== undefined ? { codeAt: start + quotes } : {}),
    };
  }

  private ansiQuoted(): string {
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r" };
    let value = "";
    for (this.pos += 2; ; this.pos++) {
      const char = this.text[this.pos];
      if (char === undefined) throw new Unreadable("unclosed $'");
      if (char === "'") { this.pos++; return value; }
      if (char === "\\") { const next = this.text[++this.pos] ?? ""; value += escapes[next] ?? next; continue; }
      value += char;
    }
  }

  private doubleQuoted(scope: Scope, add: (chars: string) => void, expand: (from: number) => void): void {
    for (;;) {
      const char = this.text[this.pos];
      const from = this.pos;
      if (char === undefined) throw new Unreadable("unclosed \"");
      if (char === "\"") { this.pos++; return; }
      if (char === "\\") {
        const next = this.text[this.pos + 1];
        if (next === "\n") { this.pos += 2; continue; }
        if (next !== undefined && "$`\"\\".includes(next)) { add(next); this.pos += 2; continue; }
      }
      if ((char === "$" || char === "`") && this.expansion(scope)) { expand(from); continue; }
      add(char);
      this.pos++;
    }
  }

  /** An expansion at the cursor, read past; false when the `$` is a plain character. A substitution in it is read. */
  private expansion(scope: Scope): boolean {
    const { text } = this;
    if (text[this.pos] === "`") { this.backticks(scope); return true; }
    const next = text[this.pos + 1];
    if (next === "(") {
      if (text[this.pos + 2] === "(") this.doubleParen(scope, 1);
      else this.subshell(scope, 2);
      return true;
    }
    if (next === "{") { this.braced(scope); return true; }
    const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(text.slice(this.pos + 1, this.pos + 64));
    if (!name) return false;
    this.pos += 1 + name[0].length;
    return true;
  }

  private backticks(scope: Scope): void {
    let body = "";
    let exact = true;
    let end = this.pos + 1;
    for (; end < this.text.length && this.text[end] !== "`"; end++) {
      const char = this.text[end]!;
      const next = this.text[end + 1];
      if (char === "\\" && next !== undefined && "`\\$".includes(next)) { body += next; end++; exact = false; continue; }
      body += char;
    }
    if (end >= this.text.length) throw new Unreadable("unclosed `");
    new ShellReader(body, exact && this.base !== undefined ? this.base + this.pos + 1 : undefined, this.depth + 1, this.out).read(placeOf(subScope(scope)));
    this.pos = end + 1;
  }

  private braced(scope: Scope): void {
    let depth = 0;
    for (this.pos += 2; this.pos < this.text.length;) {
      const char = this.text[this.pos]!;
      if (char === "\\") { this.pos += 2; continue; }
      if (char === "'") {
        const end = this.text.indexOf("'", this.pos + 1);
        if (end < 0) throw new Unreadable("unclosed '");
        this.pos = end + 1;
        continue;
      }
      if (char === "\"") { this.pos++; this.doubleQuoted(scope, () => {}, () => {}); continue; }
      if ((char === "$" || char === "`") && this.expansion(scope)) continue;
      this.pos++;
      if (char === "{") depth++;
      else if (char === "}" && depth-- === 0) return;
    }
    throw new Unreadable("unclosed ${");
  }
}

function placeOf(scope: Scope): Place & { alts: string[] } {
  if (scope.sure) return { dir: scope.dir, alts: [] };
  return { dir: scope.dir, alts: [...scope.alts], ...(scope.unless !== undefined ? { unless: scope.unless } : {}) };
}

/** The directory after a `cd` or `pushd`; a target that is not literal (`$dir`, `-`) leaves it as it was. */
function changedDir(dir: string, args: readonly ShellWord[]): string {
  const operand = args.find(arg => arg.text === "-" || !arg.text.startsWith("-"));
  if (operand === undefined) return homedir();
  if (!operand.literal || operand.text === "-") return dir;
  const target = operand.text;
  if (target === "~" || target.startsWith("~/")) return join(homedir(), target.slice(1));
  return isAbsolute(target) ? join(target) : join(dir, target);
}

/** The commands of a text cut at every separator: the reading of a text the reader cannot read whole. */
function looseCommands(text: string, depth: number, place: Place): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  for (const part of separatorParts(text)) {
    const out: SimpleCommand[] = [];
    try {
      new ShellReader(part, undefined, depth, out).read(place);
      commands.push(...out);
      continue;
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
    }
    const tokens = part.split(/\s+/).filter(Boolean);
    while (tokens.length && (KEYWORDS.has(tokens[0]!) || /^[({!]+$|\)$/.test(tokens[0]!))) tokens.shift();
    const command: SimpleCommand = { words: [], redirects: [], dir: place.dir, alts: [...place.alts], ...(place.unless !== undefined ? { unless: place.unless } : {}) };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!.replace(/^[({]+/, "").replace(/[)}]+$/, "");
      const word = (raw: string): ShellWord => {
        const plain = raw.replace(/['"\\]/g, "");
        return { text: plain, literal: !/[$`]/.test(plain), bare: plain.replace(/\$\{[^}]*\}|\$\w+/g, ""), feeds: [] };
      };
      if (token === "<" && tokens[index + 1] !== undefined) command.redirects.push({ op: "<", target: word(tokens[++index]!) });
      else if (/^<[^<(]/.test(token)) command.redirects.push({ op: "<", target: word(token.slice(1)) });
      else if (token && !(command.words.length === 0 && ASSIGNMENT.test(token)) && !/^\d*>/.test(token)) command.words.push(word(token));
    }
    if (command.words.length) commands.push(command);
  }
  return commands;
}

function readInto(text: string, base: number | undefined, depth: number, out: SimpleCommand[], place: Place): void {
  const first = out.length;
  try { new ShellReader(text, base, depth, out).read(place); }
  catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    out.length = first;
    out.push(...looseCommands(text, depth, place));
  }
}

/**
 * The simple commands bash runs from a command, in order, with substitutions and `-c` strings read in place. Each
 * branch is read whether or not bash takes it, and a function body whether or not it is called: the floor does not
 * evaluate conditions.
 */
export function shellCommands(command: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  readInto(command, 0, 0, out, { dir: ".", alts: [] });
  return out;
}

/** Whether the command word at `at` runs as a builtin: `timeout 5 cd sub` and `nice . ./a.sh` exec a program instead. */
function runsBuiltin(words: readonly ShellWord[], at: number): boolean {
  return words.slice(0, at).every(word => word.text === "builtin" || word.text === "command");
}

/** Where the command word of a simple command sits: past assignments and wrappers with their options and operands. */
export function commandIndex(words: readonly ShellWord[]): number | undefined {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!.text;
    if (ASSIGNMENT.test(word)) { index++; continue; }
    const wrapper = WRAPPERS.get(basename(word));
    if (!wrapper) return index;
    for (index++; index < words.length && words[index]!.text.startsWith("-"); index++) {
      const option = words[index]!.text;
      if (option === "--") { index++; break; }
      if (wrapper.values?.includes(option)) index++;
    }
    index += wrapper.operands ?? 0;
  }
  return undefined;
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
 * path that can be inside an allowed root. A relative path is resolved in `dir`, the directory a `cd` moved to.
 */
function readBody(file: string, reader: Reader, dir = "."): string | undefined {
  let candidate = file;
  if (candidate.startsWith("~")) {
    if (candidate !== "~" && !candidate.startsWith("~/")) return undefined;
    candidate = `${reader.home}${candidate.slice(1)}`;
  }
  const absolute = isAbsolute(candidate) ? candidate : reader.cwdText === undefined ? undefined : resolve(reader.cwdText, dir, candidate);
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

/**
 * What a shell is asked to run, by the index of its argument: `code` for `-c` or a bundle such as `-lc`, `file` for a
 * script operand, or `stdin` when it reads its script from its input (no operand, or `-s`).
 */
function shellCall(args: readonly string[]): { code?: number; file?: number; stdin?: true } {
  let code = false;
  let stdin = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const operand = arg === "--" || arg === "-" ? index + 1 : undefined;
    if (operand === undefined && arg.startsWith("--")) { if (SHELL_VALUE_FLAGS.has(arg)) index++; continue; }
    if (operand === undefined && /^[-+][A-Za-z]+$/.test(arg)) {
      if (arg.startsWith("-") && arg.includes("c")) code = true;
      if (arg.startsWith("-") && arg.includes("s")) stdin = true;
      if (/[oO]$/.test(arg)) index++;
      continue;
    }
    const at = operand ?? index;
    if (code) return at < args.length ? { code: at } : {};
    return stdin || at >= args.length ? { stdin: true } : { file: at };
  }
  return code ? {} : { stdin: true };
}

/** The index of the file an interpreter runs: the first word that is not an option; inline code (`-e`, `-c`) runs no file. */
function interpreterFile(args: readonly string[]): number | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return index + 1 < args.length ? index + 1 : undefined;
    if (arg === "-e" || arg === "--eval" || arg === "-c" || arg === "-p" || arg === "--print") return undefined;
    if (arg.startsWith("-")) { if (INTERPRETER_VALUE_FLAGS.has(arg)) index++; continue; }
    return index;
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
function packageBodies(head: string, args: readonly string[], reader: Reader, dir: string): ScriptSource[] {
  const named = packageScript(head, args);
  if (!named || reader.cwdText === undefined) return [];
  // The manager runs the nearest package.json at or above its directory; the roots rule stops the walk at the project.
  let raw: string | undefined;
  for (let at = resolve(reader.cwdText, dir); raw === undefined; at = dirname(at)) {
    raw = readBody(join(at, "package.json"), reader);
    if (at === reader.cwdText || dirname(at) === at) break;
  }
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
function makeBodies(args: readonly string[], reader: Reader, dir: string): ScriptSource[] {
  if (reader.cwdText === undefined) return [];
  const call = makeCall(args);
  const directory = resolve(reader.cwdText, dir, call.dir ?? ".");
  let text: string | undefined;
  if (call.file !== undefined) text = readBody(call.file, reader, dir);
  else for (const name of MAKE_FILES) { text = readBody(join(directory, name), reader); if (text !== undefined) break; }
  if (text === undefined) return [];
  const target = call.target ?? defaultMakeTarget(text);
  if (target === undefined) return [];
  const recipe = recipeLines(text, target);
  if (!recipe.length) return [];
  return [{ source: call.target === undefined ? "make" : `make ${call.target}`, kind: "shell", body: recipe.join("\n") }];
}

/** Whether `dir` is a directory inside the project or a temp root; a path outside them is never asked about. */
function directoryInRoots(dir: string, reader: Reader): boolean {
  if (reader.cwdText === undefined) return false;
  const absolute = resolve(reader.cwdText, dir);
  if (!insideAny(absolute, [reader.cwdText, ...tempTextRoots()])) return false;
  try { return statSync(absolute).isDirectory(); } catch { return false; }
}

/** How a file is named in a hit label: as written, under the directory a `cd` moved to. */
function labelOf(file: string, dir: string): string {
  return dir === "." || isAbsolute(file) || file.startsWith("~") ? file : join(dir, file);
}

/**
 * The bodies a shell command runs from disk: shell scripts (also fed on stdin, by `cat FILE |`, or by `<(cat FILE)`),
 * `source`/`.`, package managers, make, interpreter files, and executable paths, each in the directory a `cd` moved
 * to. One level only: this function is never called on a body it reads.
 */
export function scriptSources(command: string, cwd?: string): ScriptSource[] {
  const sources: ScriptSource[] = [];
  const reader = makeReader(cwd);
  const seen = new Set<string>();
  const push = (source: ScriptSource, dir: string): void => {
    const key = `${source.kind}\u0000${dir}\u0000${source.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };
  const file = (word: ShellWord | undefined, kind: ScriptSource["kind"], dir: string): void => {
    if (!word?.literal) return;
    const body = readBody(word.text, reader, dir);
    if (body !== undefined) push({ source: labelOf(word.text, dir), kind, body }, dir);
  };
  // The files a `cat` writes to a shell's input, through `|` or a process substitution.
  const fed = (commands: readonly SimpleCommand[]): void => {
    for (const fedBy of commands) {
      const at = commandIndex(fedBy.words);
      if (at === undefined || basename(fedBy.words[at]!.text) !== "cat") continue;
      for (const dir of dirsOf(fedBy)) for (const word of fedBy.words.slice(at + 1)) if (!word.text.startsWith("-")) file(word, "shell", dir);
    }
  };
  const script = (word: ShellWord | undefined, dir: string): void => {
    if (word?.feeds.length) fed(word.feeds);
    else file(word, "shell", dir);
  };
  // The directories a command may run in; `unless` is read when `dir` is missing or outside the roots, where it cannot be checked.
  const dirsOf = (call: SimpleCommand): string[] => {
    const missing = call.unless !== undefined && !directoryInRoots(call.dir, reader);
    return [call.dir, ...call.alts, ...(missing ? [call.unless!] : [])];
  };
  for (const call of shellCommands(command)) for (const dir of dirsOf(call)) {
    const at = commandIndex(call.words);
    if (at === undefined) continue;
    const headWord = call.words[at]!;
    const head = basename(headWord.text);
    const words = call.words.slice(at + 1);
    const args = words.map(word => word.text);
    if (head === "source" || head === ".") {
      if (runsBuiltin(call.words, at)) script(words.find(word => !word.text.startsWith("-")), dir);
      continue;
    }
    if (SHELLS.has(head)) {
      const shell = shellCall(args);
      if (shell.file !== undefined) script(words[shell.file], dir);
      if (!shell.stdin) continue;
      for (const redirect of call.redirects) if (redirect.op === "<") script(redirect.target, dir);
      if (call.from) fed([call.from]);
      continue;
    }
    if (MANAGERS.has(head)) {
      for (const source of packageBodies(head, args, reader, dir)) push(source, dir);
      continue;
    }
    if (head === "make") {
      for (const source of makeBodies(args, reader, dir)) push(source, dir);
      continue;
    }
    if (head === "bun") {
      // `bun FILE` runs a file; `bun run NAME` and the lifecycle words are package scripts.
      if (args[0] === "run" || LIFECYCLE_SCRIPTS.has(args[0] ?? "")) for (const source of packageBodies(head, args, reader, dir)) push(source, dir);
      else { const index = interpreterFile(args); file(index === undefined ? undefined : words[index], "interpreter", dir); }
      continue;
    }
    // `deno run FILE`; `deno FILE` runs the file too.
    if (head === "deno") {
      const skip = args[0] === "run" ? 1 : 0;
      const index = interpreterFile(args.slice(skip));
      file(index === undefined ? undefined : words[index + skip], "interpreter", dir);
      continue;
    }
    if (INTERPRETERS.test(head)) {
      const index = interpreterFile(args);
      file(index === undefined ? undefined : words[index], "interpreter", dir);
      continue;
    }
    // A relative or absolute path runs a file: `./cleanup.sh`, `scripts/deploy.sh`, `/usr/local/bin/tool`.
    if (headWord.text.includes("/") || headWord.text.startsWith(".")) file(headWord, "shell", dir);
  }
  return sources;
}
