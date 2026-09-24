/**
 * Standing preferences: corrections the user repeated in earlier sessions of the same project. Code only, no Jev
 * request, no model call. Pi keeps each project's sessions as JSONL files in one directory; the scan reads the newest of
 * them, keeps the imperative clauses of messages a human typed, groups near-duplicates, and keeps the groups that span
 * two or more sessions. Nothing is written anywhere.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
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

export interface PrefsScan {
  prefs: StandingPref[];
  /** Session files read. */
  scanned: number;
  ms: number;
}

export interface ScanOptions {
  /** The project's session directory (`ctx.sessionManager.getSessionDir()`). */
  dir: string;
  /** The current session file; it is not an earlier session. */
  exclude?: string | undefined;
  maxSessions?: number;
  maxAgeDays?: number;
  now?: number;
}

/**
 * A message a person typed, not one relayed into the prompt: a skill block or tagged paste (`<name ...>`), a document
 * with markdown headings, a report whose first line carries `FIELD:` labels or `·` separators, or anything longer
 * than a hand-typed correction.
 */
export function isHumanTyped(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > HUMAN_MAX_CHARS) return false;
  if (trimmed.startsWith("<")) return false;
  if (/^#{1,6}\s/m.test(trimmed)) return false;
  if (/<([a-z][\w-]*)[^>]*>[\s\S]*<\/\1>/i.test(trimmed)) return false;
  const first = trimmed.split("\n", 1)[0]!;
  if (/\b[A-Z]{2,}:\s/.test(first) || /\s·\s/.test(first)) return false;
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

/** Two content words at least: "don't order" or "never main" is a fragment, not a preference. */
function substantive(clause: string): boolean {
  return tokens(clause).filter(word => word !== "not").length >= 2;
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
  tokens: string[];
  text: string;
  sessions: Set<string>;
  lastAt: number;
}

/**
 * Near-duplicate clauses form one group (token-set Jaccard at or above SIMILARITY with the group's newest wording).
 * A group seen in MIN_SESSIONS or more distinct sessions is a standing preference; the list is ranked by session count,
 * then recency.
 */
export function groupPreferences(candidates: readonly PrefCandidate[], minSessions = MIN_SESSIONS, max = MAX_PREFS): StandingPref[] {
  const groups: Group[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.at - a.at)) {
    const words = tokens(candidate.clause);
    if (!words.length) continue;
    const negated = words.includes("not");
    // "never X" and "always X" share most words; opposite polarity is never the same preference.
    const group = groups.find(existing => existing.tokens.includes("not") === negated && jaccard(existing.tokens, words) >= SIMILARITY);
    if (group) {
      group.sessions.add(candidate.session);
      group.lastAt = Math.max(group.lastAt, candidate.at);
    } else {
      groups.push({ tokens: words, text: candidate.clause, sessions: new Set([candidate.session]), lastAt: candidate.at });
    }
  }
  return groups
    .filter(group => group.sessions.size >= minSessions)
    .sort((a, b) => b.sessions.size - a.sessions.size || b.lastAt - a.lastAt)
    .slice(0, max)
    .map(group => ({ text: group.text, sessions: group.sessions.size, lastAt: group.lastAt }));
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}

/** Preference candidates in one session file's user messages. Only `message` entries with role `user` are read. */
export function candidatesInSession(data: Buffer, session: string, fallbackAt: number): PrefCandidate[] {
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
    for (const clause of extractPreferences(messageText(entry.message.content))) found.push({ clause, session, at });
  }
  return found;
}

/** Reads the newest earlier sessions of this project (at most maxSessions, none older than maxAgeDays). Read-only. */
export async function scanPreferences(options: ScanOptions): Promise<PrefsScan> {
  const started = performance.now();
  const now = options.now ?? Date.now();
  const oldest = now - (options.maxAgeDays ?? MAX_AGE_DAYS) * 86_400_000;
  let names: string[];
  try {
    names = (await readdir(options.dir)).filter(name => name.endsWith(".jsonl"));
  } catch {
    // No session directory yet (a first session, or an in-memory session): no earlier sessions to learn from.
    return { prefs: [], scanned: 0, ms: performance.now() - started };
  }
  const exclude = options.exclude ? basename(options.exclude) : undefined;
  const files: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    if (name === exclude) continue;
    const path = join(options.dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs >= oldest) files.push({ path, mtime: info.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const candidates: PrefCandidate[] = [];
  let scanned = 0;
  for (const file of files.slice(0, options.maxSessions ?? MAX_SESSIONS)) {
    const data = await readFile(file.path).catch(() => undefined);
    if (!data) continue;
    scanned++;
    candidates.push(...candidatesInSession(data, basename(file.path), file.mtime));
  }
  return { prefs: groupPreferences(candidates), scanned, ms: performance.now() - started };
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** `/warden prefs` output. */
export function formatPrefs(scan: PrefsScan): string {
  if (!scan.prefs.length) {
    return `No standing preferences: nothing was repeated in ${MIN_SESSIONS} or more of the last ${scan.scanned} session${scan.scanned === 1 ? "" : "s"} of this project.`;
  }
  return [
    `Standing preferences (repeated in ${MIN_SESSIONS}+ of the last ${scan.scanned} sessions of this project):`,
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
