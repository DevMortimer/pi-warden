import { isAbsolute } from "node:path";

/**
 * File writes whose content is literal in a shell command: heredocs into `cat`/`tee`, `echo`/`printf` redirections,
 * here-strings, and `>>` appends. The rules, slop, and security guards judge them as `write` calls, so a heredoc is not a
 * way around the checks a `write` gets. Nothing is executed; a write whose content the command text does not hold is
 * skipped with a reason for the trace.
 */

export interface ShellWrite {
  /** The target as written, with a leading unquoted `~` expanded. */
  path: string;
  /** The text the shell writes: for an append, only the appended text. */
  content: string;
  append: boolean;
  /** The command that produces the content. */
  via: "heredoc" | "here-string" | "echo" | "printf";
}

export interface ShellSkip {
  path?: string;
  reason: string;
}

export interface ShellWriteScan {
  writes: ShellWrite[];
  skips: ShellSkip[];
}

interface Word {
  text: string;
  /** The shell substitutes into this word ($VAR, $(...), backticks, $'...'), so its value is not in the command text. */
  expanded: boolean;
  /** Starts with an unquoted `~`, which the shell expands to the home directory. */
  tilde: boolean;
}

interface Redirect { fd: "1" | "2" | "&" | string; append: boolean; target?: Word }

interface Segment {
  words: Word[];
  redirects: Redirect[];
  /** The last heredoc or here-string wins stdin, as in the shell. */
  input?: { kind: "heredoc" | "here-string"; text: string; expanded: boolean };
  stdin?: "pipe" | "file";
  substitution: boolean;
}

const EXPANSION_START = /[A-Za-z_{(0-9@*#?$!-]/;
const EXPANSION_REASON = "the content uses shell expansion ($VAR, $(...), or backticks), so it is not in the command text";

/** Index just past the `)` that closes the `(` at `open`, skipping quoted text. */
function closeParen(command: string, open: number): number {
  let depth = 0;
  for (let index = open; index < command.length; index++) {
    const char = command[index]!;
    if (char === "\\") { index++; continue; }
    if (char === "'") { const end = command.indexOf("'", index + 1); index = end < 0 ? command.length : end; continue; }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) return index + 1;
  }
  return command.length;
}

/** Bash's heredoc rules for an unquoted delimiter: `\$`, `` \` ``, `\\` and a line continuation are escapes; other backslashes stay. */
function heredocText(body: string, literal: boolean): { text: string; expanded: boolean } {
  if (literal) return { text: body, expanded: false };
  let text = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    const next = body[index + 1];
    if (char === "\\" && next !== undefined && "$`\\\n".includes(next)) { if (next !== "\n") text += next; index++; continue; }
    if (char === "`" || (char === "$" && next !== undefined && EXPANSION_START.test(next))) return { text: body, expanded: true };
    text += char;
  }
  return { text, expanded: false };
}

function scan(command: string): Segment[] {
  const segments: Segment[] = [];
  const fresh = (stdin?: "pipe"): Segment => ({ words: [], redirects: [], substitution: false, ...(stdin ? { stdin } : {}) });
  let segment = fresh();
  let word: Word | undefined;
  let redirect: Redirect | undefined;
  /** The word after `<` names an input file, not an argument. */
  let inputFile = false;
  let hereString = false;
  let pending: Array<{ segment: Segment; delimiter: string; tabs: boolean; literal: boolean }> = [];
  const endWord = () => {
    if (!word) return;
    if (redirect) { redirect.target = word; segment.redirects.push(redirect); redirect = undefined; }
    else if (hereString) { segment.input = { kind: "here-string", text: `${word.text}\n`, expanded: word.expanded }; hereString = false; }
    else if (inputFile) { segment.stdin = "file"; inputFile = false; }
    else segment.words.push(word);
    word = undefined;
  };
  const endSegment = (piped = false) => {
    endWord();
    redirect = undefined;
    inputFile = hereString = false;
    if (segment.words.length || segment.redirects.length || segment.input) segments.push(segment);
    segment = fresh(piped ? "pipe" : undefined);
  };
  const append = (text: string, expanded = false, tilde = false) => {
    word ??= { text: "", expanded: false, tilde };
    word.text += text;
    word.expanded ||= expanded;
  };
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    const next = command[index + 1];
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      const stop = end < 0 ? command.length : end;
      append(command.slice(index + 1, stop));
      index = stop + 1;
      continue;
    }
    if (char === "\"") {
      let end = index + 1;
      let text = "";
      let expanded = false;
      while (end < command.length && command[end] !== "\"") {
        const at = command[end]!;
        const after = command[end + 1];
        if (at === "\\" && after !== undefined && "\"\\$`\n".includes(after)) { if (after !== "\n") text += after; end += 2; continue; }
        if (at === "`" || (at === "$" && after !== undefined && EXPANSION_START.test(after))) expanded = true;
        if (at === "$" && after === "(") { const close = closeParen(command, end + 1); text += command.slice(end, close); end = close; continue; }
        text += at;
        end++;
      }
      append(text, expanded);
      index = end + 1;
      continue;
    }
    if (char === "\\") {
      if (next !== "\n") append(next ?? "");
      index += 2;
      continue;
    }
    if (char === "#" && !word) {
      while (index < command.length && command[index] !== "\n") index++;
      continue;
    }
    if (char === "\n") {
      endSegment();
      index++;
      for (const heredoc of pending) {
        const lines: string[] = [];
        while (index < command.length) {
          const lineEnd = command.indexOf("\n", index);
          const stop = lineEnd < 0 ? command.length : lineEnd;
          const raw = command.slice(index, stop);
          const line = heredoc.tabs ? raw.replace(/^\t+/, "") : raw;
          index = stop + 1;
          if (line === heredoc.delimiter) break;
          lines.push(line);
        }
        const body = heredocText(lines.map(line => `${line}\n`).join(""), heredoc.literal);
        heredoc.segment.input = { kind: "heredoc", ...body };
      }
      pending = [];
      continue;
    }
    if (char === "$" && next === "'") {
      const end = command.indexOf("'", index + 2);
      const stop = end < 0 ? command.length : end;
      append(command.slice(index + 2, stop), true);
      index = stop + 1;
      continue;
    }
    if (char === "$" && next === "(") {
      const close = closeParen(command, index + 1);
      append(command.slice(index, close), true);
      index = close;
      continue;
    }
    if (char === "$" && next !== undefined && EXPANSION_START.test(next)) { append(char, true); index++; continue; }
    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      const stop = end < 0 ? command.length : end;
      append(command.slice(index, stop + 1), true);
      index = stop + 1;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      endWord();
      segment.substitution = true;
      index = closeParen(command, index + 1);
      continue;
    }
    if (char === "<") {
      endWord();
      const heredoc = /^<<(-?)[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|\\?([^\s;&|<>()]+))/.exec(command.slice(index));
      if (command.startsWith("<<<", index)) { hereString = true; index += 3; continue; }
      if (heredoc) {
        pending.push({ segment, delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4]!, tabs: heredoc[1] === "-", literal: heredoc[4] === undefined || heredoc[0].includes("\\") });
        index += heredoc[0].length;
        continue;
      }
      inputFile = true;
      index++;
      continue;
    }
    if (char === ">" || (char === "&" && next === ">")) {
      let fd = "1";
      if (char === "&") { fd = "&"; index++; }
      else if (word && /^\d+$/.test(word.text) && !word.expanded) { fd = word.text; word = undefined; }
      endWord();
      index++;
      const appending = command[index] === ">";
      if (appending) index++;
      if (command[index] === "|") index++;
      if (command[index] === "&") {
        index++;
        // `>&2` and `2>&1` duplicate a descriptor and name no file; `>&file` is `&>file`.
        const dup = /^(?:\d+|-)/.exec(command.slice(index));
        if (dup) { index += dup[0].length; continue; }
        fd = "&";
      }
      redirect = { fd, append: appending };
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
      const double = (char === "&" || char === "|" || char === ";") && next === char;
      const piped = char === "|" && !double;
      endSegment(piped);
      index += double || (piped && next === "&") ? 2 : 1;
      continue;
    }
    if (/\s/.test(char)) { endWord(); index++; continue; }
    append(char, false, !word && char === "~");
    index++;
  }
  endSegment();
  return segments;
}

const WRAPPERS = new Set(["command", "builtin", "exec"]);

function headIndex(words: readonly Word[]): number {
  let index = 0;
  while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.text) || WRAPPERS.has(words[index]!.text))) index++;
  return index;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", "\\": "\\", "\"": "\"", "'": "'" };

/** Backslash escapes as `echo -e`, `printf` formats, and `%b` read them; an unknown escape stays as written. */
function unescape(text: string): { text: string; stop: boolean } {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char !== "\\" || index + 1 >= text.length) { out += char; continue; }
    const next = text[index + 1]!;
    if (next === "c") return { text: out, stop: true };
    const octal = /^0[0-7]{0,3}/.exec(text.slice(index + 1));
    if (octal) { out += String.fromCharCode(parseInt(octal[0], 8)); index += octal[0].length; continue; }
    out += ESCAPES[next] ?? `\\${next}`;
    index++;
  }
  return { text: out, stop: false };
}

function echoText(args: readonly string[]): string {
  let index = 0;
  let newline = true;
  let escapes = false;
  for (; index < args.length && /^-[neE]+$/.test(args[index]!); index++) {
    for (const flag of args[index]!.slice(1)) {
      if (flag === "n") newline = false;
      else escapes = flag === "e";
    }
  }
  const joined = args.slice(index).join(" ");
  if (!escapes) return newline ? `${joined}\n` : joined;
  const { text, stop } = unescape(joined);
  return newline && !stop ? `${text}\n` : text;
}

/** The output of `printf` for the conversions `%s`, `%b`, `%d`, `%i`, and `%%`; undefined for any other format. */
function printfText(args: readonly string[]): string | undefined {
  const rest = args[0] === "--" ? args.slice(1) : args;
  const format = rest[0];
  if (format === undefined) return undefined;
  const values = rest.slice(1);
  let out = "";
  let used = 0;
  do {
    let consumed = 0;
    for (let index = 0; index < format.length; index++) {
      const char = format[index]!;
      if (char === "\\") {
        const end = format[index + 1] === "0" ? index + 2 + (/^[0-7]{0,3}/.exec(format.slice(index + 2))![0].length) : index + 2;
        const { text, stop } = unescape(format.slice(index, end));
        out += text;
        if (stop) return out;
        index = end - 1;
        continue;
      }
      if (char !== "%") { out += char; continue; }
      const conversion = format[++index];
      if (conversion === "%") { out += "%"; continue; }
      const value = values[used + consumed] ?? "";
      if (conversion === "s") out += value;
      else if (conversion === "b") { const { text, stop } = unescape(value); out += text; if (stop) return out; }
      else if (conversion === "d" || conversion === "i") { if (value && !/^[+-]?\d+$/.test(value)) return undefined; out += value ? String(parseInt(value, 10)) : "0"; }
      else return undefined;
      consumed++;
    }
    if (!consumed) break;
    used += consumed;
  } while (used < values.length);
  return out;
}

function expandHome(word: Word, home: string | undefined): string | undefined {
  if (!word.tilde) return word.text;
  if (word.text !== "~" && !word.text.startsWith("~/")) return undefined;
  return home === undefined ? undefined : `${home}${word.text.slice(1)}`;
}

/** Where the written text comes from, or why the command text does not hold it. */
function contentOf(segment: Segment, name: string, args: readonly Word[]): { content: string; via: ShellWrite["via"] } | { reason: string } {
  if (segment.substitution) return { reason: "process substitution supplies the content" };
  if (name === "echo" || name === "printf") {
    if (args.some(arg => arg.expanded)) return { reason: EXPANSION_REASON };
    if (name === "echo") return { content: echoText(args.map(arg => arg.text)), via: "echo" };
    if (args[0]?.text === "-v") return { reason: "printf -v writes a variable, not a file" };
    const content = printfText(args.map(arg => arg.text));
    return content === undefined ? { reason: "the printf format uses a conversion that is not judged" } : { content, via: "printf" };
  }
  if (name === "cat" && args.some(arg => arg.text !== "-" && !arg.text.startsWith("-"))) return { reason: "cat copies files, whose content is not in the command text" };
  if (name !== "cat" && name !== "tee") return { reason: `the output of ${name || "the command"} is not in the command text` };
  if (segment.input) {
    if (segment.input.expanded) return { reason: EXPANSION_REASON };
    return { content: segment.input.text, via: segment.input.kind };
  }
  if (segment.stdin === "pipe") return { reason: "the content arrives through a pipe" };
  if (segment.stdin === "file") return { reason: "the content is read from a file" };
  return { reason: "the command text holds no content" };
}

/**
 * Writes whose content is literal in `command`, and the writes skipped with a reason. Pure: the command is only read.
 * `home` expands a leading `~` in a target; without it such a target is skipped.
 */
export function shellWrites(command: string, options: { home?: string } = {}): ShellWriteScan {
  const writes: ShellWrite[] = [];
  const skips: ShellSkip[] = [];
  let movedDirectory = false;
  for (const segment of scan(command)) {
    const head = headIndex(segment.words);
    const name = (segment.words[head]?.text ?? "").replace(/^.*\//, "");
    const args = segment.words.slice(head + 1);
    if (name === "cd" || name === "pushd" || name === "popd") { movedDirectory = true; continue; }
    // `> file` and `: > file` truncate: an empty file has nothing to judge.
    if (name === "" || name === ":" || name === "true") continue;
    if (name === "sed" && args.some(arg => /^-[A-Za-z]*i/.test(arg.text) || arg.text.startsWith("--in-place"))) { skips.push({ reason: "sed -i edits a file in place; the new content is not in the command text" }); continue; }
    if (name === "patch") { skips.push({ reason: "patch applies a diff; the resulting file is not in the command text" }); continue; }
    if (name === "git" && args.find(arg => !arg.text.startsWith("-"))?.text === "apply") { skips.push({ reason: "git apply applies a diff; the resulting file is not in the command text" }); continue; }
    const targets = segment.redirects.filter(item => item.fd === "1" || item.fd === "&").map(item => ({ word: item.target!, append: item.append }));
    if (name === "tee") {
      const append = args.some(arg => /^-[A-Za-z]*a/.test(arg.text) || arg.text === "--append");
      for (const arg of args) if (!arg.text.startsWith("-") || arg.text === "-") targets.push({ word: arg, append });
    }
    const files = targets.filter(target => !/^\/dev\//.test(target.word.text));
    if (!files.length) continue;
    const source = contentOf(segment, name, name === "tee" ? [] : args);
    for (const target of files) {
      const path = target.word.expanded ? undefined : expandHome(target.word, options.home);
      if (path === undefined || !path) { skips.push({ path: target.word.text, reason: "the target path uses shell expansion" }); continue; }
      if (movedDirectory && !isAbsolute(path)) { skips.push({ path, reason: "the command changes directory first, so the relative target is not resolved" }); continue; }
      if ("reason" in source) { skips.push({ path, reason: source.reason }); continue; }
      writes.push({ path, content: source.content, append: target.append, via: source.via });
    }
  }
  return { writes, skips };
}
