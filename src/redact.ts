const REPLACEMENT = "[redacted]";

/** Best-effort credential scrubbing for text that leaves the machine. Ordered: multi-token shapes before bare tokens. */
const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REPLACEMENT],
  [/(authorization\s*[:=]\s*)(?:basic|bearer|token)?\s*\S+/gi, `$1${REPLACEMENT}`],
  [/\b(bearer\s+)\S+/gi, `$1${REPLACEMENT}`],
  [/((?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|passw(?:or)?d|passphrase|token|secret|credentials?)[a-z0-9_-]*\s*[=:]\s*["']?)([^\s"'&;]+)/gi, `$1${REPLACEMENT}`],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REPLACEMENT}@`],
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
