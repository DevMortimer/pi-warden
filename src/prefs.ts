/**
 * Standing preferences: corrections the user repeated in earlier sessions of the same project. Code only, no Jev
 * request, no model call. Pi keeps each working directory's sessions as JSONL files in one directory; the scan reads the
 * newest sessions of the project's directory and of the directories whose sessions ran in another worktree of the same
 * repository, keeps the imperative clauses of messages a human typed, groups near-duplicates, and keeps the groups that
 * span two or more sessions. Nothing is written anywhere.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { redact } from "./redact.js";

/**
 * Short automated sessions fill a project's directory quickly: on real data the newest 50 sessions covered three to six
 * days and held no repeat at all. The 30-day window is the real bound; 200 sessions scanned in under 150 ms.
 */
export const MAX_SESSIONS = 200;
export const MAX_AGE_DAYS = 30;
export const MIN_SESSIONS = 2;
export const MAX_PREFS = 10;
export const CLAUSE_CHARS = 160;
export const MESSAGE_CHARS = 600;
export const SIMILARITY = 0.6;
/**
 * The same preference in other words ("don't spawn subagents", "do the review yourself, no subagents") shares its
 * subject word and little else. A word in fewer than RARE_SHARE of the user's typed messages is a subject; two clauses
 * that share one, with at least RARE_OVERLAP of their other content words in common, are one preference. On real data,
 * a subject like "subagent" sat in 1 to 2% of messages and "commit" near 5%, so the share alone would merge
 * "commit and push" with "commit and bump the version"; the overlap floor keeps them apart.
 */
export const RARE_SHARE = 0.05;
export const RARE_OVERLAP = 0.3;
/** Reading stops after this long; the newest sessions come first, so a slow disk loses only the oldest. */
export const SCAN_BUDGET_MS = 250;
/** Longer user messages are pasted orders, reports, or logs; a correction typed by hand is short. */
const HUMAN_MAX_CHARS = 2000;
/** Buffer search instead of parsing every line: user messages are a small share of a session file's bytes. */
const USER_MARKER = Buffer.from('{"role":"user"');

export const PREFS_HINT = "Add the ones you want to keep to pi-warden.md as rules.";
export const PREFS_LEAD = "Preferences this user repeated in earlier sessions of this project:";

export interface PrefCandidate {
  clause: string;
  session: string;
  at: number;
}

export interface StandingPref {
  /** The newest wording of the preference, redacted, at most CLAUSE_CHARS characters. */
  text: string;
  sessions: number;
  lastAt: number;
}

/** How often each word appears in the user's typed messages: the yardstick for a rare word. */
export interface WordCounts {
  messages: number;
  words: Map<string, number>;
}

export function emptyWordCounts(): WordCounts {
  return { messages: 0, words: new Map() };
}

export interface PrefsScan {
  prefs: StandingPref[];
  /** Session files read. */
  scanned: number;
  /** Session directories searched: this worktree's and those of the repository's other worktrees. */
  directories: number;
  ms: number;
}

export interface ScanOptions {
  /** The project's session directory (`ctx.sessionManager.getSessionDir()`). */
  dir: string;
  /** The current session file; it is not an earlier session. */
  exclude?: string | undefined;
  /** The session's working directory. Inside a git repository, sessions of its other worktrees are read too. */
  cwd?: string | undefined;
  maxSessions?: number;
  maxAgeDays?: number;
  now?: number;
  budgetMs?: number;
}

/** "From Lead agent:" or "Heads up from the Planner:": another agent's message delivered as a user turn. */
const SENDER_LINE = /^[^\n]{0,40}\b[Ff]rom (?:the )?[A-Z][\w-]*(?: [\w-]+)?:/;
/** "Added by the owner:", "Owner change:": an agent passing the user's words on; the user said them once, elsewhere. */
const ON_BEHALF = /\b(?:by|from) the owner\b|^owner\b[^\n:]{0,30}:/im;
/** `PROJECT: …` / `BRANCH: …` field lines: the header block of an order or report. */
const HEADER_FIELD = /^\W*[A-Z][A-Z']{2,}(?: [A-Z']+)*:\s/gm;

/**
 * A message a person typed, not one relayed into the prompt: a skill block or tagged paste (`<name ...>`), a document
 * with markdown headings, an order or report with a header block of `FIELD:` lines or a first line with `FIELD:`
 * labels or `·` separators, a message from another agent or passed on for the user, or anything longer than a
 * hand-typed correction.
 */
export function isHumanTyped(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > HUMAN_MAX_CHARS) return false;
  if (trimmed.startsWith("<")) return false;
  if (/^#{1,6}\s/m.test(trimmed)) return false;
  if (/<([a-z][\w-]*)[^>]*>[\s\S]*<\/\1>/i.test(trimmed)) return false;
  const first = trimmed.split("\n", 1)[0]!;
  if (/\b[A-Z]{2,}:\s/.test(first) || /\s·\s/.test(first)) return false;
  if (SENDER_LINE.test(first) || ON_BEHALF.test(trimmed)) return false;
  if ((trimmed.match(HEADER_FIELD) ?? []).length >= 2) return false;
  return true;
}

/**
 * A question is not a preference: "why don't you run the tests?" asks for a reason or suggests a one-off step, and
 * reading it as "run the tests, always" would put words in the user's mouth. A sentence that ends with `?` or starts
 * with a question word is skipped.
 */
function isQuestion(sentence: string): boolean {
  return /\?\s*$/.test(sentence) || /^(?:why|how|what|when|where|who|which|can|could|would|should|will|is|are|did|does|do\s+(?:you|we|i|they))\b/i.test(sentence);
}

const APOSTROPHE = "['’]";
/** An imperative starts its clause: at the start of a sentence, after a separator, or after a joining word. */
const LEAD = String.raw`(?:^|[,:;–—-]\s*|\b(?:and|but|so|just|also|then|again|ok|okay|pls|please|btw)\s+)`;
const NEGATIVE = String.raw`(?:please\s+)?(?:don${APOSTROPHE}?t|do\s+not|never|stop(?=\s+\w+ing\b))`;
const IMPERATIVE = new RegExp(String.raw`${LEAD}(${NEGATIVE}|(?:please\s+)?always)\s+(.+)$`, "i");
/** These open a standing preference at the start of a clause; "agents created from now on would …" is a statement. */
const STANDING = new RegExp(String.raw`${LEAD}(?:next\s+time|from\s+now\s+on)\b[,:]?(?:\s+too\b)?[,:]?\s+(?!(?:would|will|should|could|might|may|is|are|was|were)\b)(.+)$`, "i");
/** "I said" and "I told you" also narrate ("I told you I did"); only an instruction after them counts. */
const REPEATED = new RegExp(String.raw`\bi\s+(?:said|told\s+you)\b[,:]?\s+(?:to\s+(.+)|((?:${NEGATIVE}|always)\s+.+))$`, "i");
/**
 * "Don't worry" is kindness, and "don't like", "don't know", "don't think" drop the "I" of a statement about the user;
 * none of them asks the agent to do anything. A third-person or past form after the trigger ("never closes", "never
 * printed") describes something instead of asking for it.
 */
const NOT_A_PREFERENCE = /^(?:worry|mind|panic|like|know|think|see|care|get|understand|remember|want|need|have|feel|recall)\b|^(?!always\b)(?:[a-z]+[^s\W]s|[a-z]+[^e\W]ed)\b/i;

/** "Don't commit yet", "never mind the tests for now": a hold on this task, lifted later, not a standing preference. */
const TEMPORARY = /\b(?:yet|for\s+now|right\s+now|today|this\s+time|at\s+the\s+moment)\b/i;

/** Two content words at least ("don't order" or "never main" is a fragment), and not a temporary hold. */
function substantive(clause: string): boolean {
  return !TEMPORARY.test(clause) && tokens(clause).filter(word => word !== "not").length >= 2;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+|;\s*/).map(part => part.trim()).filter(Boolean);
}

function tidy(clause: string): string {
  const cleaned = redact(clause.replace(/\s+/g, " ").trim().replace(/[\s.,;:!]+$/, ""));
  const capped = cleaned.length > CLAUSE_CHARS ? `${cleaned.slice(0, CLAUSE_CHARS - 1).trimEnd()}…` : cleaned;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/** The preference clauses in one user message, redacted, each at most CLAUSE_CHARS characters. */
export function extractPreferences(text: string): string[] {
  if (!isHumanTyped(text)) return [];
  const found: string[] = [];
  for (const sentence of sentences(text)) {
    if (isQuestion(sentence)) continue;
    const imperative = IMPERATIVE.exec(sentence);
    if (imperative) {
      const rest = imperative[2]!;
      if (NOT_A_PREFERENCE.test(rest)) continue;
      const clause = `${imperative[1]!.replace(/^please\s+/i, "")} ${rest}`;
      if (substantive(clause)) found.push(tidy(clause));
      continue;
    }
    const repeated = REPEATED.exec(sentence);
    const clause = repeated ? repeated[1] ?? repeated[2]! : STANDING.exec(sentence)?.[1];
    if (clause && substantive(clause)) found.push(tidy(clause));
  }
  return found;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "to", "of", "in", "on", "at", "for", "with", "by", "from", "as", "into",
  "i", "me", "my", "we", "us", "our", "you", "your", "it", "its", "this", "that", "these", "those", "there", "here",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have", "has", "had", "will", "would", "can",
  "could", "should", "please", "pls", "just", "also", "then", "again", "ok", "okay", "any", "some", "all", "more",
  "very", "really", "always", "ever", "next", "time", "now", "anymore", "yourself", "itself", "them", "they",
  // Generic verbs: "don't use the cache", "don't run the cache", and "don't let it make a cache" are one preference.
  "use", "run", "let", "make", "get",
  // Filler: rare enough to pass for a subject word, and says nothing about one.
  "stuff", "thing", "anything", "everything", "something", "nothing", "though", "first", "actually", "even",
]);
const NEGATION = /^(?:don['’]?t|do\s+not|never|stop|no|not)\b/i;

/**
 * Lowercased content words with a light plural strip. A clause that starts with a negation gets a `not` token, so
 * "never use X" and "always use X" do not merge.
 */
export function tokens(clause: string): string[] {
  const negated = NEGATION.test(clause.trim());
  const words = clause.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .filter(word => word && !STOP_WORDS.has(word) && !/^(?:dont|not|never|stop|no)$/.test(word))
    .map(word => word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
  const set = new Set(words);
  if (negated && set.size) set.add("not");
  return [...set];
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 1;
  const right = new Set(b);
  let shared = 0;
  for (const word of a) if (right.has(word)) shared++;
  return shared / (a.length + right.size - shared);
}

interface Group {
  members: string[][];
  negated: boolean;
  text: string;
  sessions: Set<string>;
  lastAt: number;
}

/**
 * Two clauses of the same polarity are one preference when their words mostly match (Jaccard at or above SIMILARITY),
 * or when they share a rare word and RARE_OVERLAP of their content words. Without counts, the clauses themselves are
 * the yardstick.
 */
function samePreference(a: readonly string[], b: readonly string[], rare: (word: string) => boolean): boolean {
  if (jaccard(a, b) >= SIMILARITY) return true;
  const left = a.filter(word => word !== "not");
  const right = b.filter(word => word !== "not");
  return left.some(word => rare(word) && right.includes(word)) && jaccard(left, right) >= RARE_OVERLAP;
}

/**
 * Clauses that are the same preference as any member of a group join it; opposite polarity never does, since "never X"
 * and "always X" share most words. A group seen in MIN_SESSIONS or more distinct sessions is a standing preference;
 * the list is ranked by session count, then recency.
 */
export function groupPreferences(candidates: readonly PrefCandidate[], counts?: WordCounts, minSessions = MIN_SESSIONS, max = MAX_PREFS): StandingPref[] {
  const yardstick = counts?.messages ? counts : emptyWordCounts();
  if (!counts?.messages) for (const candidate of candidates) countWords(yardstick, tokens(candidate.clause));
  const rare = (word: string) => (yardstick.words.get(word) ?? 0) < RARE_SHARE * yardstick.messages;
  const groups: Group[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.at - a.at)) {
    const words = tokens(candidate.clause);
    if (!words.length) continue;
    const negated = words.includes("not");
    const group = groups.find(existing => existing.negated === negated && existing.members.some(member => samePreference(member, words, rare)));
    if (group) {
      group.members.push(words);
      group.sessions.add(candidate.session);
      group.lastAt = Math.max(group.lastAt, candidate.at);
    } else {
      groups.push({ members: [words], negated, text: candidate.clause, sessions: new Set([candidate.session]), lastAt: candidate.at });
    }
  }
  return groups
    .filter(group => group.sessions.size >= minSessions)
    .sort((a, b) => b.sessions.size - a.sessions.size || b.lastAt - a.lastAt)
    .slice(0, max)
    .map(group => ({ text: group.text, sessions: group.sessions.size, lastAt: group.lastAt }));
}

function countWords(counts: WordCounts, words: readonly string[]): void {
  counts.messages++;
  for (const word of new Set(words)) counts.words.set(word, (counts.words.get(word) ?? 0) + 1);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}

/**
 * Preference candidates in one session file's user messages. Only `message` entries with role `user` are read. Every
 * typed message also adds its words to `counts`, when given.
 */
export function candidatesInSession(data: Buffer, session: string, fallbackAt: number, counts?: WordCounts): PrefCandidate[] {
  const found: PrefCandidate[] = [];
  let from = 0;
  for (;;) {
    const hit = data.indexOf(USER_MARKER, from);
    if (hit < 0) break;
    const start = data.lastIndexOf(10, hit) + 1;
    const newline = data.indexOf(10, hit);
    const end = newline < 0 ? data.length : newline;
    from = end + 1;
    let entry: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(data.toString("utf8", start, end));
    } catch {
      // A torn last line in a session that is still being written: the complete lines before it still count.
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const at = Number.isFinite(parsed) ? parsed : fallbackAt;
    const text = messageText(entry.message.content);
    if (counts && isHumanTyped(text)) countWords(counts, tokens(text));
    for (const clause of extractPreferences(text)) found.push({ clause, session, at });
  }
  return found;
}

/** Worktree roots of the repository that holds `cwd`, from one `git worktree list`. */
export function worktreeRoots(cwd: string, timeoutMs = 2000): Promise<string[]> {
  return new Promise(resolve => {
    execFile("git", ["-C", cwd, "worktree", "list", "--porcelain"], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // Not a repository, or no git on this machine: the project is its own session directory only.
      if (error) resolve([]);
      else resolve(stdout.split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length)));
    });
  });
}

/** True when `cwd` is a worktree root or a directory inside one that is not a nested repository of its own. */
export function inWorktree(cwd: string, roots: readonly string[]): boolean {
  return roots.some(root => {
    const path = relative(root, cwd);
    if (path === "") return true;
    if (path.startsWith("..") || isAbsolute(path)) return false;
    for (let dir = cwd; dir !== root && dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, ".git"))) return false;
    return true;
  });
}

/** The `cwd` of a session directory, from the header line of one of its files. */
async function sessionCwd(dir: string): Promise<string | undefined> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl"));
  for (const name of names.slice(0, 3)) {
    const file = await open(join(dir, name), "r").catch(() => undefined);
    if (!file) continue;
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(4096), 0, 4096, 0);
      const header = JSON.parse(buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0]!) as { type?: unknown; cwd?: unknown };
      if (header.type === "session" && typeof header.cwd === "string") return header.cwd;
    } catch {
      // A header cut at 4 KB or an empty file: try the next file of the directory.
      continue;
    } finally {
      await file.close();
    }
  }
  return undefined;
}

/**
 * Pi files sessions by working directory, so each worktree of a repository has its own session directory. The sibling
 * directories whose sessions ran in a worktree of the same repository belong to the project too.
 */
export async function projectSessionDirs(dir: string, cwd: string | undefined): Promise<string[]> {
  const roots = cwd ? await worktreeRoots(cwd) : [];
  if (!roots.length) return [dir];
  const parent = dirname(dir);
  const siblings = (await readdir(parent, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && join(parent, entry.name) !== dir);
  const found = await Promise.all(siblings.map(async entry => {
    const path = join(parent, entry.name);
    const where = await sessionCwd(path);
    return where && inWorktree(where, roots) ? path : undefined;
  }));
  return [dir, ...found.filter((path): path is string => path !== undefined)];
}

/**
 * Reads the newest earlier sessions of this project and its worktrees (at most maxSessions, none older than
 * maxAgeDays). Read-only.
 */
export async function scanPreferences(options: ScanOptions): Promise<PrefsScan> {
  const started = performance.now();
  const now = options.now ?? Date.now();
  const oldest = now - (options.maxAgeDays ?? MAX_AGE_DAYS) * 86_400_000;
  const exclude = options.exclude ? basename(options.exclude) : undefined;
  const directories = await projectSessionDirs(options.dir, options.cwd);
  const files: Array<{ path: string; mtime: number }> = [];
  for (const dir of directories) {
    // No session directory yet (a first session, or an in-memory session): nothing earlier to learn from there.
    const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl") && name !== exclude);
    const infos = await Promise.all(names.map(async name => {
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      return info?.isFile() && info.mtimeMs >= oldest ? { path, mtime: info.mtimeMs } : undefined;
    }));
    for (const info of infos) if (info) files.push(info);
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const candidates: PrefCandidate[] = [];
  const counts = emptyWordCounts();
  let scanned = 0;
  const deadline = started + (options.budgetMs ?? SCAN_BUDGET_MS);
  for (const file of files.slice(0, options.maxSessions ?? MAX_SESSIONS)) {
    if (performance.now() > deadline) break;
    const data = await readFile(file.path).catch(() => undefined);
    if (!data) continue;
    scanned++;
    candidates.push(...candidatesInSession(data, basename(file.path), file.mtime, counts));
  }
  return { prefs: groupPreferences(candidates, counts), scanned, directories: directories.length, ms: performance.now() - started };
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** `/warden prefs` output. */
export function formatPrefs(scan: PrefsScan): string {
  if (!scan.prefs.length) {
    return `No standing preferences: nothing was repeated in ${MIN_SESSIONS} or more of the last ${scan.scanned} session${scan.scanned === 1 ? "" : "s"} of this project.`;
  }
  return [
    `Standing preferences (repeated in ${MIN_SESSIONS}+ of the last ${scan.scanned} sessions of this project${scan.directories > 1 ? ` and its worktrees` : ""}):`,
    ...scan.prefs.map((pref, index) => `${index + 1}. ${pref.text} (${pref.sessions} sessions, last ${day(pref.lastAt)})`),
    PREFS_HINT,
  ].join("\n");
}

/** The session-start context message, at most MESSAGE_CHARS characters; whole items only. Undefined when there is nothing to say. */
export function prefsMessage(prefs: readonly StandingPref[]): string | undefined {
  let message = PREFS_LEAD;
  let added = 0;
  for (const pref of prefs) {
    const line = `\n- ${pref.text}`;
    if (message.length + line.length > MESSAGE_CHARS) break;
    message += line;
    added++;
  }
  return added ? message : undefined;
}
