/**
 * Standing preferences: corrections the user repeated in earlier sessions of the same project. Code only, no Jev
 * request, no model call. Pi keeps each working directory's sessions as JSONL files in one directory; the scan reads the
 * newest sessions of the project's directory and of the directories whose sessions ran in another worktree of the same
 * repository, keeps the imperative clauses of messages a human typed, groups near-duplicates, and lists the groups that
 * span two or more sessions. Only a group that passes every rule of `evaluatePrefs` reaches the agent: a wrong memory
 * is worse than none. Session files are never written; the agent's own lessons and the groups the user forgot are kept
 * in one small file per project under pi-warden's data folder.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { userConfigPath } from "./config.js";
import { redact } from "./redact.js";

/**
 * Short automated sessions fill a project's directory quickly: on real data the newest 50 sessions covered three to six
 * days and held no repeat at all. The 30-day window is the real bound; 200 sessions scanned in under 150 ms.
 */
export const MAX_SESSIONS = 200;
export const MAX_AGE_DAYS = 30;
/** Listed by `/warden prefs` from two sessions; injected only from INJECT_SESSIONS sessions on INJECT_DAYS days. */
export const MIN_SESSIONS = 2;
export const INJECT_SESSIONS = 3;
export const INJECT_DAYS = 2;
/** A preference not seen for this long is not current, and an agent lesson not confirmed for this long expires. */
export const CURRENT_DAYS = 30;
export const MAX_PREFS = 10;
export const MAX_INJECTED = 5;
export const CLAUSE_CHARS = 160;
export const LESSON_CHARS = CLAUSE_CHARS;
/** The whole injected message, lead and closing sentence included. */
export const MESSAGE_CHARS = 400;
/** An agent lesson is accepted only this many assistant turns after a correction or a stuck, repeat, or done-check steer. */
export const LESSON_TURNS = 5;
/** Stored lessons per project; the oldest go first. */
const MAX_LESSONS = 50;
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

export const PREFS_HINT = "Add the ones you want to keep to pi-warden.md as rules; /warden prefs forget <n> drops one for good.";
export const PREFS_LEAD = "Standing preferences for this project, quoted as said in earlier sessions:";
export const PREFS_CLOSING = "If the current request says otherwise, follow the current request.";
export const LESSON_MARK = "(agent lesson)";
export const WAS_INJECTED = "injected";
export const NOT_CONFIRMED = "agent lesson, not yet confirmed";

export interface PrefCandidate {
  clause: string;
  session: string;
  at: number;
  /** "Do use subagents here", "feel free to push": a later permission that only contradicts, never a preference. */
  permit?: boolean;
}

/** Why a clause may never reach the agent however often it is repeated: rules 3 and 6. */
export type PrefClass = "standing" | "task-bound" | "weakens";

export interface StandingPref {
  /** The newest wording of the preference, redacted, at most CLAUSE_CHARS characters. */
  text: string;
  sessions: number;
  /** Distinct calendar days (UTC) it was said on. */
  days: number;
  lastAt: number;
  kind: PrefClass;
  /** A later message of the opposite polarity matches it. */
  contradicted: boolean;
  /** Content words of every wording: the group's key for `forget` and for matching a lesson. */
  members: string[][];
  negated: boolean;
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
  /** The groups seen in MIN_SESSIONS or more sessions, before the rules of `evaluatePrefs`. */
  prefs: StandingPref[];
  /** Every clause and permission read, for matching the agent's lessons against what the user said. */
  candidates: PrefCandidate[];
  counts: WordCounts;
  /** The repository's main worktree, or the working directory: the key of the project's lesson file. */
  project: string;
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

/**
 * "Don't commit yet", "don't push until the checks pass", "never mind the tests on this branch": a hold on this task,
 * lifted later, not a standing preference. "From now on" opens one, and "for this project" names the project, not a task.
 */
const TEMPORARY = /\b(?:yet|now(?!\s+on\b)|today|this\s+time|at\s+the\s+moment|until|this\s+PR|this\s+branch|for\s+this\b(?!\s+(?:project|repo|repository|codebase)\b))\b/i;

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

/** The clauses in the standing forms (`don't`, `never`, `always`, `stop`, `from now on`, `next time`, `I told you`). */
function standingClauses(text: string): string[] {
  if (!isHumanTyped(text)) return [];
  const found: string[] = [];
  for (const sentence of sentences(text)) {
    if (isQuestion(sentence)) continue;
    const imperative = IMPERATIVE.exec(sentence);
    if (imperative) {
      const rest = imperative[2]!;
      if (!NOT_A_PREFERENCE.test(rest)) found.push(`${imperative[1]!.replace(/^please\s+/i, "")} ${rest}`);
      continue;
    }
    const repeated = REPEATED.exec(sentence);
    const clause = repeated ? repeated[1] ?? repeated[2]! : STANDING.exec(sentence)?.[1];
    if (clause) found.push(clause);
  }
  return found;
}

/** The preference clauses in one user message, redacted, each at most CLAUSE_CHARS characters. */
export function extractPreferences(text: string): string[] {
  return standingClauses(text).filter(substantive).map(tidy);
}

/**
 * The user corrected the agent: a typed message in one of the standing forms, temporary holds included ("don't commit
 * yet" corrects the agent as much as "never commit" does).
 */
export function isCorrection(text: string): boolean {
  return standingClauses(text).length > 0;
}

/** "Do use subagents here", "feel free to push", "you can skip it": a permission that lifts an earlier prohibition. */
const PERMISSION = new RegExp(String.raw`${LEAD}(?:please\s+)?(?:do\s+(?!not\b|you\b|we\b|i\b|they\b|it\b|that\b|this\b|the\b|a\b|an\b|so\b|some\b|any\b|what\b|as\b)|feel\s+free\s+to\s+|you\s+(?:can|may)\s+(?:now\s+)?|it${APOSTROPHE}?s\s+(?:fine|ok|okay)\s+to\s+)(.+)$`, "i");

/** Permissions in one user message. They only contradict an earlier preference; none of them is listed or injected. */
export function extractPermissions(text: string): string[] {
  if (!isHumanTyped(text)) return [];
  const found: string[] = [];
  for (const sentence of sentences(text)) {
    if (isQuestion(sentence)) continue;
    const clause = PERMISSION.exec(sentence)?.[1];
    if (clause && tokens(clause).length) found.push(tidy(clause));
  }
  return found;
}

/**
 * A pronoun as the whole object points at something in the task at hand: "don't commit or stage it", "never do that
 * again", "don't make it amber". In "don't let it spawn subagents" the pronoun is the agent itself, not an object. "This
 * file" and "that the build passes" name their object, so a demonstrative counts only when the clause ends, or an
 * adverb, a preposition, or a conjunction follows it.
 */
const PRONOUN_OBJECT = /^(?:(?:don['’]?t|do\s+not|never|stop|always)\s+)?(?:[\w-]+\s+(?:or|and)\s+)?(?!let\s)[\w-]+\s+(?:it|them|(?:this|that|these|those)(?=\s*$|[,.;!]|\s+(?:again|anymore|ever|please|yourself|here|back|to|in|on|into|for|with|or|and)\b))\b/i;
/** A ticket (`ABC-123`), a PR or issue number, a commit hash, or a branch name with a slash names one task. */
const SPECIFIC_REFERENCE = new RegExp([
  String.raw`\b[A-Z][A-Z0-9]{1,9}-\d+\b`,
  String.raw`(?:^|\s)#\d+\b`,
  String.raw`\b(?:PR|MR|pull\s+request|issue|ticket)\s*#?\d+\b`,
  String.raw`\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b`,
  String.raw`\bbranch\s+["'\x60]?[\w.-]+\/[\w./-]+`,
  String.raw`\b(?:feat|feature|fix|bugfix|hotfix|chore|release)\/[\w./-]+`,
].join("|"));

/**
 * Markers of a preference that weakens a safeguard: skipping tests, checks, reviews, or confirmations, turning warden
 * off, or pushing, deploying, or deleting without asking. Such a preference is listed, never injected. `asked` weakens
 * when the user asks for it ("skip the tests"); `refused` weakens when the user forbids the verification itself ("don't
 * run the tests", "never ask before pushing", "don't review it"). "Never skip the tests" keeps the check, so `asked`
 * markers do not count in a prohibition. A prohibition of a harmful action is a safety preference, not a weakened check:
 * "never check in secrets", "never test in production", and "don't commit to main" are injected. So a verification verb
 * (check, verify, review, test) counts only when the clause ends after it, or a verification object follows it.
 */
export const WEAKENS_CHECK: { readonly asked: readonly RegExp[]; readonly refused: readonly RegExp[] } = {
  asked: [
    /\b(?:skip\w*|bypass\w*|disabl\w*|ignor\w*|omit\w*|turn(?:ing)?\s+off|silenc\w*|mut(?:e|ing))\b.*\b(?:tests?|checks?|lint\w*|reviews?|verif\w*|confirm\w*|hooks?|ci|typecheck\w*|warden|guards?)\b/i,
    /--no-verify\b/i,
    /\bwithout\s+(?:asking|confirm\w*|approval|permission|(?:a\s+)?review\w*|testing|tests?|checks?|checking|verif\w*)\b/i,
  ],
  refused: [
    /^(?:don['’]?t|do\s+not|never|stop)\s+(?:(?:ever|even|bother(?:ing)?|need|have|to)\s+){0,2}(?:run\w*|writ\w*|add\w*|wait\w*(?:\s+for)?|do\w*|us(?:e|ing)|call\w*|request\w*)\s+(?:(?:the|any|a)\s+)?(?:[\w-]+\s+)?(?:tests?|checks?|lint\w*|reviews?|verif\w*|typecheck\w*|ci|warden)\b/i,
    /^(?:don['’]?t|do\s+not|never|stop)\s+(?:(?:ever|even|bother(?:ing)?|need|have|to)\s+){0,2}(?:ask\w*|confirm\w*)\b/i,
    /^(?:don['’]?t|do\s+not|never|stop)\s+(?:(?:ever|even|bother(?:ing)?|need|have|to)\s+){0,2}(?:check|verify|review|test)(?:s|ed|es|ied|ing)?(?=\s*$|\s+(?:before|after|first|anything|again|it|them|that|this|my|your|each|every|(?:the\s+)?(?:code|build|changes?|output|results?|diffs?|work|pr|pull\s+requests?|commits?))\b)/i,
  ],
};

/** Rules 3 and 6: a clause that names one task, or that weakens a check, is never a standing preference to inject. */
export function classifyClause(clause: string): PrefClass {
  const text = clause.trim();
  const negated = NEGATION.test(text);
  if ((negated ? WEAKENS_CHECK.refused : WEAKENS_CHECK.asked).some(marker => marker.test(text))) return "weakens";
  if (PRONOUN_OBJECT.test(text) || SPECIFIC_REFERENCE.test(text)) return "task-bound";
  return "standing";
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
  kind: PrefClass;
  text: string;
  sessions: Set<string>;
  days: Set<string>;
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

/** The same subject with the polarity set aside: "don't spawn subagents" and "do use subagents here". */
function sameSubject(a: readonly string[], b: readonly string[], rare: (word: string) => boolean): boolean {
  return samePreference(a.filter(word => word !== "not"), b.filter(word => word !== "not"), rare);
}

export type Rarity = (word: string) => boolean;

/** A word in fewer than RARE_SHARE of the typed messages is a subject word. Without counts, the clauses are the yardstick. */
export function rarity(candidates: readonly PrefCandidate[], counts?: WordCounts): Rarity {
  const yardstick = counts?.messages ? counts : emptyWordCounts();
  if (!counts?.messages) for (const candidate of candidates) countWords(yardstick, tokens(candidate.clause));
  return word => (yardstick.words.get(word) ?? 0) < RARE_SHARE * yardstick.messages;
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * Clauses that are the same preference as any member of a group join it; opposite polarity never does, since "never X"
 * and "always X" share most words, and neither does a clause of another class, so a task-bound "don't commit it" never
 * lends its sessions to "don't commit to main". A group seen in MIN_SESSIONS or more distinct sessions is listed; the
 * list is ranked by session count, then recency. A group is contradicted when any later clause or permission of the
 * opposite polarity has the same subject.
 */
export function groupPreferences(candidates: readonly PrefCandidate[], counts?: WordCounts, minSessions = MIN_SESSIONS, max = MAX_PREFS): StandingPref[] {
  const rare = rarity(candidates, counts);
  const groups: Group[] = [];
  const opposites: Array<{ words: string[]; negated: boolean; at: number }> = [];
  for (const candidate of [...candidates].sort((a, b) => b.at - a.at)) {
    const words = tokens(candidate.clause);
    if (!words.length) continue;
    const negated = !candidate.permit && words.includes("not");
    opposites.push({ words, negated, at: candidate.at });
    if (candidate.permit) continue;
    const kind = classifyClause(candidate.clause);
    const group = groups.find(existing => existing.negated === negated && existing.kind === kind && existing.members.some(member => samePreference(member, words, rare)));
    if (group) {
      group.members.push(words);
      group.sessions.add(candidate.session);
      group.days.add(day(candidate.at));
      group.lastAt = Math.max(group.lastAt, candidate.at);
    } else {
      groups.push({ members: [words], negated, kind, text: candidate.clause, sessions: new Set([candidate.session]), days: new Set([day(candidate.at)]), lastAt: candidate.at });
    }
  }
  return groups
    .filter(group => group.sessions.size >= minSessions)
    .sort((a, b) => b.sessions.size - a.sessions.size || b.lastAt - a.lastAt)
    .slice(0, max)
    .map(group => ({
      text: group.text,
      sessions: group.sessions.size,
      days: group.days.size,
      lastAt: group.lastAt,
      kind: group.kind,
      contradicted: opposites.some(other => other.at > group.lastAt && other.negated !== group.negated && group.members.some(member => sameSubject(member, other.words, rare))),
      members: group.members,
      negated: group.negated,
    }));
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
    for (const clause of extractPermissions(text)) found.push({ clause, session, at, permit: true });
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
export async function projectSessionDirs(dir: string, cwd: string | undefined, known?: readonly string[]): Promise<string[]> {
  const roots = known ?? (cwd ? await worktreeRoots(cwd) : []);
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
  const roots = options.cwd ? await worktreeRoots(options.cwd) : [];
  const directories = await projectSessionDirs(options.dir, options.cwd, roots);
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
  return {
    prefs: groupPreferences(candidates, counts),
    candidates,
    counts,
    project: roots[0] ?? options.cwd ?? options.dir,
    scanned,
    directories: directories.length,
    ms: performance.now() - started,
  };
}

/** A lesson or a confirmation recorded in one session. */
export interface LessonRecord {
  session: string;
  at: number;
}

/** A standing lesson the agent recorded with `warden_remember`, redacted. */
export interface Lesson {
  text: string;
  records: LessonRecord[];
}

/** A group the user dropped with `/warden prefs forget`: its wordings, so later rewordings stay dropped too. */
export interface Forgotten {
  text: string;
  members: string[][];
  at: number;
}

/**
 * The project's lesson file: the agent's lessons, its notes that repeated a listed user preference, and the groups the
 * user forgot. It lives under pi-warden's data folder, never in a rules file or a session file.
 */
export interface PrefsStore {
  lessons: Lesson[];
  confirmations: Lesson[];
  forgotten: Forgotten[];
}

export function emptyPrefsStore(): PrefsStore {
  return { lessons: [], confirmations: [], forgotten: [] };
}

export function prefsStorePath(project: string): string {
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 12);
  return join(dirname(userConfigPath()), "prefs", `${hash}.json`);
}

const isRecord = (value: unknown): value is LessonRecord =>
  typeof value === "object" && value !== null && typeof (value as LessonRecord).session === "string" && typeof (value as LessonRecord).at === "number";
const isLesson = (value: unknown): value is Lesson =>
  typeof value === "object" && value !== null && typeof (value as Lesson).text === "string" && Array.isArray((value as Lesson).records) && (value as Lesson).records.every(isRecord);
const isForgotten = (value: unknown): value is Forgotten =>
  typeof value === "object" && value !== null && typeof (value as Forgotten).text === "string" && typeof (value as Forgotten).at === "number"
  && Array.isArray((value as Forgotten).members) && (value as Forgotten).members.every(member => Array.isArray(member) && member.every(word => typeof word === "string"));

/**
 * A missing file is an empty store. An unreadable or malformed one throws: without the forgotten list, a group the
 * user dropped could reach the agent again, so the caller injects nothing and says why.
 */
export async function readPrefsStore(path: string): Promise<PrefsStore> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPrefsStore();
    throw error;
  }
  const raw = JSON.parse(text) as Partial<Record<keyof PrefsStore, unknown>>;
  if (typeof raw !== "object" || raw === null) throw new Error("the lesson file is not a JSON object");
  const list = <T>(value: unknown, valid: (item: unknown) => item is T): T[] => Array.isArray(value) ? value.filter(valid) : [];
  return { lessons: list(raw.lessons, isLesson), confirmations: list(raw.confirmations, isLesson), forgotten: list(raw.forgotten, isForgotten) };
}

/** Written whole to a temporary file and renamed, so a crash never leaves half a file. */
export async function writePrefsStore(path: string, store: PrefsStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

const DAY_MS = 86_400_000;
const lastAt = (lesson: Lesson) => Math.max(...lesson.records.map(record => record.at));
const sessionCount = (lesson: Lesson) => new Set(lesson.records.map(record => record.session)).size;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Same polarity, and the same preference as one of the wordings. */
function matches(members: readonly (readonly string[])[], words: readonly string[], rare: Rarity): boolean {
  const negated = words.includes("not");
  return members.some(member => member.includes("not") === negated && samePreference(member, words, rare));
}

function forgotten(store: PrefsStore, members: readonly (readonly string[])[], rare: Rarity): boolean {
  return store.forgotten.some(entry => members.some(words => matches(entry.members, words, rare)));
}

/** Lessons and confirmations with no record in the last CURRENT_DAYS days are dropped when the file is written. */
function pruned(store: PrefsStore, now: number): PrefsStore {
  const current = (lesson: Lesson) => lastAt(lesson) >= now - CURRENT_DAYS * DAY_MS;
  return { ...store, lessons: store.lessons.filter(current).slice(-MAX_LESSONS), confirmations: store.confirmations.filter(current).slice(-MAX_LESSONS) };
}

export type PrefSource = "user" | "agent";

/** One numbered line of `/warden prefs`. */
export interface PrefItem {
  source: PrefSource;
  text: string;
  sessions: number;
  /** Distinct days, for the user's preferences. */
  days?: number;
  lastAt: number;
  injected: boolean;
  /** WAS_INJECTED, or the rule that kept it out. */
  status: string;
  members: string[][];
  /** Sessions in which the agent's own lesson repeated this user preference. */
  agentConfirmations?: number;
}

const CAPPED = `not injected: over the ${MAX_INJECTED}-item or ${MESSAGE_CHARS}-character cap`;

function messageLine(item: Pick<PrefItem, "source" | "text" | "sessions">): string {
  return `\n- "${item.text}" (${plural(item.sessions, "session")})${item.source === "agent" ? ` ${LESSON_MARK}` : ""}`;
}

/**
 * Applies the injection rules to the listed groups and the agent's lessons. A user preference is injected only when it
 * is a standing, not task-bound instruction that keeps every check (rules 2, 3, 6; rule 1 and the standing form are
 * applied when the clause is read), was said in INJECT_SESSIONS or more sessions on INJECT_DAYS or more days (rule 4),
 * was last said within CURRENT_DAYS days and no later message lifts it (rule 5). An agent lesson must also be confirmed:
 * recorded in a later session again, or said by the user. User preferences fill the MAX_INJECTED and MESSAGE_CHARS
 * budget first (rule 7). Forgotten groups are not returned at all.
 */
export function evaluatePrefs(scan: Pick<PrefsScan, "prefs" | "candidates" | "counts">, store: PrefsStore, now = Date.now()): PrefItem[] {
  const rare = rarity(scan.candidates, scan.counts);
  const current = now - CURRENT_DAYS * DAY_MS;
  const items: PrefItem[] = [];
  for (const pref of scan.prefs) {
    if (forgotten(store, pref.members, rare)) continue;
    const status = pref.kind === "weakens" ? "not injected: weakens a check"
      : pref.kind === "task-bound" ? "not injected: task-bound"
      : pref.contradicted ? "not injected: contradicted by a later message"
      : pref.sessions < INJECT_SESSIONS ? `not injected: seen in ${plural(pref.sessions, "session")}`
      : pref.days < INJECT_DAYS ? `not injected: seen on ${plural(pref.days, "day")}`
      : pref.lastAt < current ? `not injected: last seen ${day(pref.lastAt)}, over ${CURRENT_DAYS} days ago`
      : WAS_INJECTED;
    const confirmations = store.confirmations.filter(entry => pref.members.some(member => matches([tokens(entry.text)], member, rare)));
    const agentConfirmations = new Set(confirmations.flatMap(entry => entry.records.map(record => record.session))).size;
    items.push({
      source: "user", text: pref.text, sessions: pref.sessions, days: pref.days, lastAt: pref.lastAt, injected: status === WAS_INJECTED, status, members: pref.members,
      ...(agentConfirmations ? { agentConfirmations } : {}),
    });
  }
  const said = scan.candidates.filter(candidate => !candidate.permit).map(candidate => ({ ...candidate, words: tokens(candidate.clause) }));
  const lifted = scan.candidates.map(candidate => ({ words: tokens(candidate.clause), negated: !candidate.permit && NEGATION.test(candidate.clause), at: candidate.at }));
  for (const lesson of store.lessons) {
    const words = tokens(lesson.text);
    if (!words.length || forgotten(store, [words], rare)) continue;
    const last = lastAt(lesson);
    const sessions = sessionCount(lesson);
    const negated = words.includes("not");
    const kind = classifyClause(lesson.text);
    const duplicate = items.find(item => item.source === "user" && item.injected && matches(item.members, words, rare));
    const confirmed = sessions >= 2 || said.some(candidate => classifyClause(candidate.clause) === "standing" && matches([candidate.words], words, rare));
    const status = last < current ? `not injected: agent lesson expired, not confirmed in ${CURRENT_DAYS} days`
      : kind === "weakens" ? "not injected: weakens a check"
      : kind === "task-bound" ? "not injected: task-bound"
      : lifted.some(other => other.at > last && other.negated !== negated && sameSubject(words, other.words, rare)) ? "not injected: contradicted by a later message"
      : duplicate ? `not injected: same as the user's preference "${duplicate.text}"`
      : !confirmed ? NOT_CONFIRMED
      : WAS_INJECTED;
    items.push({ source: "agent", text: lesson.text, sessions, lastAt: last, injected: status === WAS_INJECTED, status, members: [words] });
  }
  let length = PREFS_LEAD.length + 1 + PREFS_CLOSING.length;
  let injected = 0;
  for (const item of items) {
    if (!item.injected) continue;
    const line = messageLine(item).length;
    if (injected < MAX_INJECTED && length + line <= MESSAGE_CHARS) {
      length += line;
      injected++;
    } else {
      item.injected = false;
      item.status = CAPPED;
    }
  }
  return items;
}

/** `/warden prefs` output: every listed group and lesson, numbered for `forget`, with its status. */
export function formatPrefs(scan: Pick<PrefsScan, "scanned" | "directories">, items: readonly PrefItem[]): string {
  if (!items.length) {
    return `No standing preferences: nothing was repeated in ${MIN_SESSIONS} or more of the last ${plural(scan.scanned, "session")} of this project, and the agent recorded no lesson.`;
  }
  return [
    `Standing preferences (repeated in ${MIN_SESSIONS}+ of the last ${plural(scan.scanned, "session")} of this project${scan.directories > 1 ? " and its worktrees" : ""}; injected from ${INJECT_SESSIONS} sessions on ${INJECT_DAYS} days):`,
    ...items.map((item, index) => {
      const seen = item.source === "user"
        ? `${plural(item.sessions, "session")} on ${plural(item.days ?? 1, "day")}, last ${day(item.lastAt)}${item.agentConfirmations ? `; the agent noted it in ${plural(item.agentConfirmations, "session")}` : ""}`
        : `agent lesson, recorded in ${plural(item.sessions, "session")}, last ${day(item.lastAt)}`;
      return `${index + 1}. ${item.text} (${seen}): ${item.status}`;
    }),
    PREFS_HINT,
  ].join("\n");
}

/**
 * The session-start context message: the injected items quoted as said, each with its session count, and the closing
 * sentence. At most MAX_INJECTED items and MESSAGE_CHARS characters; `evaluatePrefs` keeps both. Undefined when nothing
 * is injected.
 */
export function prefsMessage(items: readonly PrefItem[]): string | undefined {
  const injected = items.filter(item => item.injected).slice(0, MAX_INJECTED);
  if (!injected.length) return undefined;
  return `${PREFS_LEAD}${injected.map(messageLine).join("")}\n${PREFS_CLOSING}`;
}

/** Drops the item for good: its wordings join the forgotten list, and an agent lesson leaves the file. */
export function forgetPref(store: PrefsStore, item: PrefItem, now = Date.now()): PrefsStore {
  const entry: Forgotten = { text: item.text, members: item.members, at: now };
  return {
    ...store,
    lessons: item.source === "agent" ? store.lessons.filter(lesson => lesson.text !== item.text) : store.lessons,
    forgotten: [...store.forgotten, entry],
  };
}

export const NO_LESSON_SIGNAL = "not recorded: no correction or failure to learn from";

export interface LessonInput {
  lesson: string;
  session: string;
  now: number;
  /** A user correction, or a stuck, repeat, or done-check steer, within the last LESSON_TURNS assistant turns of this run. */
  signal: boolean;
  scan: Pick<PrefsScan, "prefs" | "candidates" | "counts">;
  store: PrefsStore;
}

/**
 * The `warden_remember` gate. A lesson is recorded only after a correction or a failure, only in a standing form, not
 * task-bound, keeping every check, and within LESSON_CHARS. One that repeats a stored lesson confirms it; one that
 * repeats a listed user preference is counted for that preference. `store` is undefined when nothing changes.
 */
export function recordLesson(input: LessonInput): { reply: string; store?: PrefsStore } {
  if (!input.signal) return { reply: NO_LESSON_SIGNAL };
  const raw = input.lesson.trim();
  if (raw.length > LESSON_CHARS) return { reply: `not recorded: longer than ${LESSON_CHARS} characters` };
  const clauses = extractPreferences(raw);
  if (clauses.length !== 1) {
    return { reply: "not recorded: not one standing instruction; state it once, with don't, never, always, stop, from now on, or next time, and no temporary words such as yet, now, until, or this PR" };
  }
  const text = clauses[0]!;
  const kind = classifyClause(text);
  if (kind === "weakens") return { reply: "not recorded: weakens a check" };
  if (kind === "task-bound") return { reply: "not recorded: task-bound; name the standing rule, not a pronoun, ticket, branch, PR number, or hash" };
  const words = tokens(text);
  const rare = rarity(input.scan.candidates, input.scan.counts);
  if (forgotten(input.store, [words], rare)) return { reply: "not recorded: the user forgot this preference" };
  const record = { session: input.session, at: input.now };
  const confirm = (entries: Lesson[], entry: Lesson): Lesson[] =>
    entries.map(other => other === entry ? { ...other, records: other.records.some(old => old.session === record.session) ? other.records : [...other.records, record] } : other);
  const lesson = input.store.lessons.find(entry => matches([tokens(entry.text)], words, rare));
  if (lesson) {
    const lessons = confirm(input.store.lessons, lesson);
    const sessions = sessionCount(lessons.find(entry => entry.text === lesson.text)!);
    return { reply: `recorded as a confirmation of the agent lesson "${lesson.text}" (${plural(sessions, "session")})`, store: pruned({ ...input.store, lessons }, input.now) };
  }
  const pref = input.scan.prefs.find(group => matches(group.members, words, rare));
  if (pref) {
    const existing = input.store.confirmations.find(entry => entry.text === pref.text);
    const confirmations = existing ? confirm(input.store.confirmations, existing) : [...input.store.confirmations, { text: pref.text, records: [record] }];
    return { reply: `recorded as a confirmation of the user's preference "${pref.text}"`, store: pruned({ ...input.store, confirmations }, input.now) };
  }
  return {
    reply: `recorded: "${text}". It reaches later sessions only after it is confirmed: recorded again in a later session, or said by the user.`,
    store: pruned({ ...input.store, lessons: [...input.store.lessons, { text, records: [record] }] }, input.now),
  };
}
