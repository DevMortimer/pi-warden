import { createHash } from "node:crypto";

const REPLACEMENT = "[redacted]";

/** Credential-key names that appear in assignments and config values: `api_key=`, `password:`, `secret`, etc. */
const CREDENTIAL_KEYS = /(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|passw(?:or)?d|passphrase|token|secret|credentials?)/i.source;

/** Best-effort credential scrubbing for text that leaves the machine. Ordered: multi-token shapes before bare tokens. */
const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REPLACEMENT],
  [/(authorization\s*[:=]\s*)(?:basic|bearer|token)?\s*\S+/gi, `$1${REPLACEMENT}`],
  [/\b(bearer\s+)\S+/gi, `$1${REPLACEMENT}`],
  // Quoted values can hold spaces (passphrases), so a quoted value is redacted whole before the unquoted rule.
  [new RegExp(`((?:${CREDENTIAL_KEYS})[a-z0-9_-]*\\s*[=:]\\s*)(["'])[^"'\\n]*\\2`, "gi"), `$1$2${REPLACEMENT}$2`],
  [new RegExp(`((?:${CREDENTIAL_KEYS})[a-z0-9_-]*\\s*[=:]\\s*["']?)([^\\s"'&;]+)`, "gi"), `$1${REPLACEMENT}`],
  // Any scheme, not just http(s): database and broker URLs (postgres://, mysql://, redis://, amqp://) carry passwords too.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REPLACEMENT}@`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REPLACEMENT],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REPLACEMENT],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REPLACEMENT],
  [/\bAKIA[0-9A-Z]{16}\b/g, REPLACEMENT],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REPLACEMENT],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REPLACEMENT],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REPLACEMENT],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------------------
// Detection: what earns the "possible credentials" notice. Redaction above stays broad on purpose (it protects what
// leaves the machine); the notice must not fire on a name. `secret: boolean`, `TYPESAFE_API_KEY`, `savedKey`,
// `token: string` and `password=<your password>` are code and prose about credentials, not credentials.

/** Token shapes that are a credential by construction. */
const TOKEN_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
/** Assignments and headers whose value must still look like a secret. */
const ASSIGNMENTS: RegExp[] = [
  new RegExp(`(?:${CREDENTIAL_KEYS})[a-z0-9_-]*\\s*[=:]\\s*["']?([^\\s"'&;,)]+)`, "gi"),
  /authorization\s*[:=]\s*(?:basic|bearer|token)?\s*([^\s"']+)/gi,
  /\bbearer\s+([^\s"']+)/gi,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:([^\s/@]+)@/gi,
];
/** Words that sit after `secret:` in code and docs. */
const NOT_VALUES = new Set(["boolean", "string", "number", "object", "any", "unknown", "null", "undefined", "true", "false", "none", "nil", "void", "never", "required", "optional", "redacted", "hidden", "masked", "omitted", "unset", "missing", "empty", "changeme", "example", "placeholder", "password", "secret", "token", "value", "text", "str", "int", "bytes", "yes", "no", "on", "off", "auto", "default", "bearer", "basic", "env", "process", "os", "environ", "config", "settings", "input", "output", "prompt"]);

/**
 * A value shape, not a name: at least 8 characters, not a type word or placeholder, not a reference to somewhere the
 * value lives (`$VAR`, `${...}`, `process.env.X`, `<your key>`, `[redacted]`, `***`), not an all-caps identifier, and
 * with the mixture of character classes that keys have (digits with letters, or both cases with punctuation).
 */
export function looksLikeSecretValue(value: string): boolean {
  const text = value.trim().replace(/^[`"'([{<]+|[`"')\]}>.,;]+$/g, "");
  if (text.length < 8 || text.length > 512) return false;
  const lower = text.toLowerCase();
  if (NOT_VALUES.has(lower)) return false;
  if (/^[$%<\[{*]|^(?:process|os|env|settings|config|secrets?|vault|keychain|import\.meta)\.|^\$?\{|^\*+$|^x+$|^(?:your|my|the|a|an)[-_ ]/i.test(text)) return false;
  if (/^[A-Z][A-Z0-9_]{6,}$/.test(text)) return false; // an environment variable name
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(text) && !/\d{3,}/.test(text)) return false; // a camelCase identifier
  if (/^[a-z]+(?:[_-][a-z]+)+$/.test(text)) return false; // snake or kebab words such as synthetic-secret
  if (/^\/|^\.\.?\//.test(text)) return false; // a path
  const digits = /\d/.test(text), lowerCase = /[a-z]/.test(text), upperCase = /[A-Z]/.test(text), symbol = /[^A-Za-z0-9]/.test(text);
  const classes = [digits, lowerCase, upperCase, symbol].filter(Boolean).length;
  return classes >= 2 && (digits || (lowerCase && upperCase));
}

/**
 * Words that name the value as a stand-in. They are rare in a real key and common in fixtures, docs, and tests.
 * `distinctive` markers are unambiguous enough to match inside a value; the rest must sit between separators.
 */
const SYNTHETIC_MARKERS = ["synthetic", "devtok", "example", "sample", "dummy", "fake", "placeholder", "changeme", "hunter2", "deadbeef", "cafebabe", "notreal", "foobar", "lorem", "acme"];
const SYNTHETIC_SEGMENTS = new Set(["test", "tests", "demo", "sample", "fake", "dummy", "staging", "sandbox", "localdev", "example", "examples", "placeholder", "notreal", "redacted", "masked", "changeme", "hunter2"]);
/** Values a doc or a fixture pastes as an example body: a run of the alphabet, a digit ladder, or one repeated unit. */
const SEQUENCE_RUN = 6;

/** An ascending or descending run of consecutive code points, such as `0123456789` or `abcdefghij`. */
function hasSequenceRun(text: string, min = SEQUENCE_RUN): boolean {
  let ascending = 1;
  let descending = 1;
  for (let index = 1; index < text.length; index++) {
    const step = text.charCodeAt(index) - text.charCodeAt(index - 1);
    ascending = step === 1 ? ascending + 1 : 1;
    descending = step === -1 ? descending + 1 : 1;
    if (ascending >= min || descending >= min) return true;
  }
  return false;
}

/** One unit repeated to fill the value (`abcabcabc`) or three or fewer distinct characters (`aaaa1111`). */
function isRepetitive(text: string): boolean {
  return new Set(text.toLowerCase()).size <= 3 || /^(.{1,4})\1+$/.test(text.toLowerCase());
}

/**
 * True for a credential-shaped value that is a stand-in rather than a credential: a name that says so
 * (`sk-synthetic-`, `devtok_`), a sequence or repeat used as an example body (`sk-live-abcdefghij123456`,
 * `0123456789abcdef`), or a documented dummy (`AKIAIOSFODNN7EXAMPLE`). Test fixtures and docs are full of these,
 * and announcing them costs the user a steer per read. Judged from the value alone, in the offline pattern layer.
 */
export function syntheticish(value: string): boolean {
  const text = value.trim().replace(/^[`"'([{<]+|[`"')]}>.,;]+$/g, "");
  if (!text) return false;
  const lower = text.toLowerCase();
  if (SYNTHETIC_MARKERS.some(marker => lower.includes(marker))) return true;
  for (const segment of lower.split(/[^a-z0-9]+/)) if (SYNTHETIC_SEGMENTS.has(segment)) return true;
  const body = lower.replace(/^[a-z0-9]{2,6}[^a-z0-9]+/, "").replace(/[^a-z0-9]/g, "");
  return hasSequenceRun(text) || hasSequenceRun(body) || isRepetitive(body);
}

/** Split credentials into the ones worth announcing and the stand-ins that are only traced. */
export function partitionSecrets(secrets: readonly string[]): { real: string[]; synthetic: string[] } {
  const real: string[] = [];
  const synthetic: string[] = [];
  for (const value of secrets) (syntheticish(value) ? synthetic : real).push(value);
  return { real, synthetic };
}

/** The credential-shaped values in `text`, deduplicated. Empty when the text only talks about credentials. */
export function findSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const shape of TOKEN_SHAPES) for (const match of text.matchAll(shape)) found.add(match[0]);
  for (const rule of ASSIGNMENTS) for (const match of text.matchAll(rule)) if (match[1] && looksLikeSecretValue(match[1])) found.add(match[1]);
  return [...found];
}

/** A short, stable id for a set of secrets; the values themselves never leave `findSecrets`. */
export function secretFingerprint(secrets: readonly string[]): string {
  return createHash("sha256").update([...secrets].sort().join("\n")).digest("hex").slice(0, 12);
}

/** One fingerprint per distinct value, so repeats are detectable even when the surrounding set changes. */
export function secretIds(secrets: readonly string[]): string[] {
  return [...new Set(secrets)].map((s) => createHash("sha256").update(s).digest("hex").slice(0, 12)).sort();
}
