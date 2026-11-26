import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { userConfigPath } from "./config.js";

export const SENSITIVE_PATH = /(?:^|[\s/"'=:(])\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w.-]+)?(?=$|[\s"';|&)])|(?:^|[\s"'=:/~])\.?(?:ssh\/(?:id_\w+|authorized_keys|known_hosts)|aws\/credentials|gnupg\/|netrc\b|npmrc\b|pypirc\b|docker\/config\.json|kube\/config\b|pi\/agent\/auth\.json|pi\/agent\/pi-typesafe\/auth\.json)|\b\w+\.(?:pem|p12|pfx|keystore|jks)\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i;

/** Whether `child` is `parent` or lies under it. */
export function underPath(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * The real path of an absolute path: the realpath of its deepest existing ancestor plus the missing rest. Undefined when
 * a component exists but cannot be resolved (a dangling symlink, a loop, no permission).
 */
export function realTarget(path: string): string | undefined {
  const rest: string[] = [];
  let head = resolve(path);
  for (;;) {
    try { return join(realpathSync(head), ...rest.reverse()); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      try { lstatSync(head); return undefined; } catch { /* missing: resolve the parent */ }
      const parent = dirname(head);
      if (parent === head) return undefined;
      rest.push(basename(head));
      head = parent;
    }
  }
}

/** Whether a target lies in a host path, after `..` and symlinks are resolved. An unresolvable target is not in one. */
export function inHostPath(target: string, roots: readonly string[]): boolean {
  if (!roots.length) return false;
  const real = realTarget(target);
  return real !== undefined && roots.some(root => {
    const canonical = realTarget(root) ?? root;
    return real === canonical || real.startsWith(canonical + sep);
  });
}

const FORBIDDEN_CREDENTIAL_DIRS = [".ssh", ".aws", ".gnupg"];
const FORBIDDEN_CONFIG_SUFFIXES = [
  join("pi-warden", "config.json"),
  join("pi-typesafe", "auth.json"),
];

export function resolveActionPath(target: string, cwd: string, home: string = homedir()): string {
  if (target === "~") return home;
  if (target.startsWith("~/")) return resolve(home, target.slice(2));
  return resolve(cwd, target);
}

/**
 * Resolve configured ephemeral scratch roots (`~/scratch`, `/tmp`, ...) to canonical and lexical paths.
 * Rejects relative entries, filesystem roots, and the home directory itself so misconfiguration fails closed.
 */
export function resolveEphemeralRoots(entries: readonly string[] | undefined, home: string = homedir()): string[] {
  if (!entries?.length) return [];
  const roots = new Set<string>();
  const homeReal = realTarget(home);
  const tmpLex = resolve(tmpdir());
  const tmpReal = realTarget(tmpLex);
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry || entry === "~") continue;
    let expanded: string;
    if (entry.startsWith("~/")) expanded = resolve(home, entry.slice(2));
    else if (isAbsolute(entry)) expanded = resolve(entry);
    else continue;
    if (dirname(expanded) === expanded) continue;
    const real = realTarget(expanded);
    if (!real || dirname(real) === real) continue;
    if (homeReal !== undefined && (real === homeReal || expanded === homeReal)) continue;
    roots.add(real);
    roots.add(expanded);
    if (tmpReal && (real === tmpReal || expanded === tmpLex)) {
      roots.add(tmpReal);
      roots.add(tmpLex);
    }
  }
  return [...roots];
}

/**
 * Forbid-before-allow containment: credential directories, warden/typesafe config files, `cwd`, and ancestors of `cwd`
 * never inherit ephemeral scratch exemptions even when they sit under an ephemeral root.
 */
function isForbiddenEphemeralPath(targetPath: string, cwd: string | undefined, home: string = homedir()): boolean {
  const lex = resolve(targetPath);
  const real = realTarget(lex);
  if (real === undefined) return true;
  if (cwd !== undefined) {
    const realCwd = realTarget(cwd);
    if (realCwd === undefined || underPath(realCwd, real)) return true;
  }
  if (SENSITIVE_PATH.test(real) || SENSITIVE_PATH.test(lex)) return true;
  if (/(?:^|[\\/])\.(?:ssh|aws|gnupg)(?:[\\/]|$)/i.test(real) || /(?:^|[\\/])\.(?:ssh|aws|gnupg)(?:[\\/]|$)/i.test(lex)) return true;
  for (const dir of FORBIDDEN_CREDENTIAL_DIRS) {
    const cred = resolve(home, dir);
    const credReal = realTarget(cred);
    if (underPath(real, cred) || (credReal !== undefined && underPath(real, credReal)) || underPath(lex, cred)) return true;
  }
  const wardenCfg = resolve(userConfigPath());
  const wardenCfgReal = realTarget(wardenCfg);
  if (real === wardenCfg || (wardenCfgReal !== undefined && real === wardenCfgReal) || lex === wardenCfg) return true;
  for (const suffix of FORBIDDEN_CONFIG_SUFFIXES) {
    if (real.endsWith(sep + suffix) || lex.endsWith(sep + suffix)) return true;
  }
  return false;
}

/** True only when `targetPath` lies strictly inside an ephemeral root subtree and passes forbid-before-allow checks. */
export function inEphemeralRoot(targetPath: string, roots: readonly string[], cwd: string | undefined): boolean {
  if (!roots.length) return false;
  if (isForbiddenEphemeralPath(targetPath, cwd)) return false;
  const real = realTarget(targetPath);
  if (real === undefined) return false;
  return roots.some(root => real !== root && underPath(real, root));
}
