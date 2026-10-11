/**
 * Ask gate: whether a judged call needs a Jev request at all.
 *
 * The action request is the largest single stream of TypeSafe requests, and most of it is spent on calls whose answer
 * cannot change what the agent sees: a read, a search, a build, a test run. The offline pattern pass and the floor
 * already decide those, and the judge only ever adds an irreversible warning, a hold, an intent steer, or a trace-only
 * note. This module answers one question before the request leaves the machine: could Jev change anything the agent
 * sees for this call?
 *
 * It asks when the call can be irreversible or visible, and it answers `false` for everything else. Recall matters more
 * than precision: a missed ask loses a real warning, an extra ask only costs money. Nothing here changes a level; the
 * caller still runs the pattern pass and the floor for a call the gate leaves unasked.
 *
 * Deliberately narrow and independent of `matchPatterns`: the pattern rules stay the offline floor, this only decides
 * whether a judge is worth a request.
 */
import { commandOf } from "./tools.js";
import { scriptSources, type ScriptSource } from "./script-bodies.js";

export interface AskDecision {
  /** True when the call goes to Jev; false when the offline pass decides it alone. */
  ask: boolean;
  /** Short, secret-free reason for the trace. Never the command text. */
  why: string;
}

/** Tools that always reach Jev: what a write or an edit leaves on disk is what every question is about. */
const ALWAYS_ASK = new Set(["write", "edit"]);

/** Heads that change version control or remote state, publish, deploy, or drive infrastructure. */
const EXTERNAL_HEADS = new Set([
  "ssh", "scp", "sftp", "rsync", "rclone", "nc", "ncat", "socat", "telnet", "ftp", "lftp", "curl", "wget", "http", "https", "xh", "aws", "gcloud", "az", "doctl",
  "heroku", "fly", "flyctl", "vercel", "netlify", "wrangler", "firebase", "kubectl", "helm", "terraform", "tofu", "pulumi", "ansible-playbook", "ansible", "nomad",
  "packer", "vagrant", "docker", "podman", "nerdctl", "docker-compose", "compose", "gh", "glab", "hub", "npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry",
  "conda", "gem", "go", "cargo", "brew", "apt", "apt-get", "dnf", "yum", "apk", "pacman", "snap", "port", "nix", "nix-env", "systemctl", "launchctl", "service",
  "supervisorctl", "pm2", "crontab", "at", "kill", "killall", "pkill", "sudo", "doas", "mount", "umount", "diskutil", "hdiutil", "defaults", "launchd", "osascript",
  // Build and packaging heads: read-only for their test and build subcommands, a write for deploy, publish, or install.
  "make", "gradle", "./gradlew", "flutter", "dotnet",
]);

/** A `curl -o` target that lands in a scratch path: a download there reads nothing the user depends on. */
const TEMP_TARGET = /^(?:\/tmp\/|\/var\/tmp\/|\/private\/tmp\/|\/dev\/null$|\/dev\/stdout$|\$TMPDIR\b|\$\{TMPDIR\}|~\/scratch\/)/;

/** Shell wrappers whose own command line names what runs. */
const WRAPPERS = new Set(["sudo", "doas", "nohup", "time", "env", "command", "builtin", "exec", "nice", "timeout", "stdbuf", "gtimeout"]);

/** Git subcommands that only read. Everything else changes the index, the working tree, the history, or a remote. */
const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "rev-parse", "rev-list", "ls-files", "ls-remote", "ls-tree", "grep", "blame", "describe", "shortlog", "cat-file", "for-each-ref",
  "show-ref", "reflog", "whatchanged", "check-ignore", "check-attr", "verify-commit", "name-rev", "merge-base", "diff-tree", "diff-index", "diff-files", "count-objects",
  "fsck", "help", "version", "var", "get-toplevel", "symbolic-ref", "hash-object", "archive", "format-patch", "range-diff", "cherry",
  // These read by default and write only through the flags the checks below look for.
  "branch", "tag", "remote", "worktree", "submodule", "stash", "config", "reflog", "notes",
]);

/** Subcommands whose effect others see on the heads that have harmless neighbours. */
const READ_ONLY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["ls", "list", "view", "show", "outdated", "why", "doctor", "config", "help", "explain", "run", "test", "audit"]),
  pnpm: new Set(["ls", "list", "view", "why", "outdated", "run", "test", "audit"]),
  yarn: new Set(["list", "why", "info", "run", "test", "audit"]),
  bun: new Set(["run", "test", "pm"]),
  pip: new Set(["list", "show", "freeze", "check", "download", "index"]),
  pip3: new Set(["list", "show", "freeze", "check", "download", "index"]),
  uv: new Set(["pip", "tree", "run"]),
  poetry: new Set(["show", "env", "run", "check"]),
  conda: new Set(["list", "info", "env"]),
  brew: new Set(["list", "info", "search", "outdated", "config", "doctor", "deps", "uses"]),
  cargo: new Set(["test", "check", "clippy", "fmt", "build", "run", "doc", "metadata", "tree"]),
  go: new Set(["test", "build", "vet", "env", "version", "list", "doc"]),
  docker: new Set(["ps", "images", "logs", "inspect", "version", "info", "stats", "top", "diff", "port", "history", "events"]),
  podman: new Set(["ps", "images", "logs", "inspect", "version", "info", "stats"]),
  kubectl: new Set(["get", "describe", "logs", "version", "config", "explain", "api-resources", "top", "diff", "auth", "cluster-info"]),
  helm: new Set(["list", "get", "show", "search", "version", "template", "lint", "status", "history", "repo"]),
  terraform: new Set(["plan", "validate", "show", "output", "fmt", "version", "providers", "graph", "state"]),
  tofu: new Set(["plan", "validate", "show", "output", "fmt", "version", "providers", "graph", "state"]),
  pulumi: new Set(["preview", "stack", "config", "version"]),
  gh: new Set(["pr", "issue", "run", "release", "repo", "api", "workflow", "gist", "search", "auth", "status", "version", "help"]),
  glab: new Set(["mr", "issue", "ci", "repo", "api", "auth", "version", "help", "config"]),
  aws: new Set(["s3api", "sts", "configure", "help"]),
  gcloud: new Set(["auth", "config", "version", "help", "info"]),
  az: new Set(["account", "config", "version", "help"]),
  systemctl: new Set(["status", "show", "is-active", "is-enabled", "list-units", "list-unit-files", "cat", "help"]),
  launchctl: new Set(["list", "print", "help"]),
  service: new Set(["status"]),
  curl: new Set([]),
  wget: new Set([]),
  kill: new Set([]),
  git: new Set([]),
  dotnet: new Set(["build", "test", "run", "restore", "list"]),
};

/**
 * A `gh` or `glab` subcommand that writes. Its read-only siblings (`gh pr view`, `gh run list`) are read-only; every
 * other second word (`gh pr create`, `gh release create`, `gh api -X POST`) changes something a user sees.
 */
const GH_READ_ONLY_SECONDS = new Set(["view", "list", "status", "diff", "checks", "watch", "download", "clone", "comment"]);
const GH_WRITE_SECONDS = new Set(["create", "merge", "close", "edit", "delete", "reopen", "review", "approve", "rerun", "cancel", "dispatch", "upload", "comment", "ready", "revert"]);

/** Interpreters that run a script given on the command line or on stdin; their text is scanned as a command. */
const SCRIPT_SINK = /(?:^|[\s;&|(])(?:python[\d.]*|node|deno|bun|tsx|ruby|perl|php|lua[\d.]*|rscript|osascript)\s+(?:-e|--eval|-(?=[\s;&|)]|$))|(?:^|[\s;&|(])(?:ba|z|k|da)?sh\s+-[a-zA-Z]*c\b|(?:^|[\s;&|(])eval\s/;

/**
 * Shapes that ask wherever they sit in the command, so a call nested in `for`, `do`, `if`, a substitution, or an
 * interpreter script is read the same as one at the head of a segment. Matched against the command with data text
 * blanked; when the command runs a script on the command line or on stdin, also against the raw command.
 */
const ANYWHERE: ReadonlyArray<{ why: string; test: RegExp }> = [
  { why: "deletes, moves, or overwrites", test: /(?:^|[\s;&|(`])(?:rm|rmdir|unlink|shred|truncate|dd|mv|cp|install|patch|chmod|chown|chgrp|mkfifo|mknod)\s/ },
  { why: "build, deploy, or install target", test: /(?:^|[\s;&|(])(?:make|gradle|\.\/gradlew|flutter|npm|pnpm|yarn|bun|poetry|uv|gem|cargo|go|dotnet)\s[^;|&\n]*\b(?:deploy|publish|release|install|uninstall|upload|push|ship|prod|production|provision|dist|archive|bundle|package)\b/ },
  { why: "writes through a shell redirect", test: /(?:^|[^0-9&\->=<])(?:>>|>)\s*(?!&)(?!\/dev\/null)(?!\/tmp\/)(?!\/var\/tmp\/)(?!\/private\/tmp\/)(?!\$TMPDIR)(?!\$\{TMPDIR\})(?!~\/scratch\/)[^\s;&|)]/ },
  { why: "gh write", test: /(?:^|[\s;&|(])(?:gh|glab)\s+(?:repo|release|issue|pr|run|workflow|cache|gist|mr|api)\s+([^\s;&|]+)/ },
  { why: "database client", test: /(?:^|[\s;&|(])(?:psql|pgcli|pg_restore|pg_dump|pg_dumpall|createdb|dropdb|mysql|mycli|mysqldump|mariadb|sqlite3|mongosh|mongo|redis-cli|clickhouse-client|cqlsh|sqlcmd|influx|supabase|firebase|cockroach)\s/ },
  { why: "network, publish, or infrastructure write", test: /(?:^|[\s;&|(])(?:ssh|scp|sftp|rsync|rclone|nc|ncat|socat|telnet|lftp|aws|gcloud|az|doctl|heroku|fly|flyctl|vercel|netlify|wrangler|kubectl|helm|terraform|tofu|pulumi|ansible-playbook|ansible|packer|vagrant|docker|podman|nerdctl|docker-compose|npm|pnpm|yarn|bun|pip|pip3|uv|poetry|conda|gem|go|cargo|brew|apt|apt-get|dnf|yum|apk|pacman|snap|port|nix|nix-env|systemctl|launchctl|service|supervisorctl|pm2|crontab|mount|umount|diskutil|hdiutil|defaults|osascript|make|gradle|\.\/gradlew|flutter)\s/ },
  { why: "sends an HTTP write", test: /(?:^|[\s;&|(])(?:curl|wget|http|xh)\s[^;&|]*(?:-X\s*(?!GET\b)|--request\s+(?!GET\b)|-d\s|--data|-F\s|--form|-T\s|--upload-file|--post-data|--post-file|-O\s|--output-document)/ },
  { why: "interpreter script with a write", test: /(?:open\s*\([^)\n]{0,120}['"][wa]|writeFile\w*|appendFile\w*|createWriteStream|rmSync|rmdirSync|unlinkSync|shutil\.rmtree|shutil\.move|os\.remove|os\.unlink|os\.rename|os\.replace|subprocess|child_process|os\.system|execSync|spawnSync|execFileSync|Deno\.write|Bun\.write|requests\.(?:post|put|patch|delete)|axios\.(?:post|put|patch|delete)|fetch\s*\(|\.exec\s*\(|DROP\s+TABLE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|TRUNCATE\s+TABLE)/i },
  { why: "in-place edit", test: /(?:^|[\s;&|(])(?:sed|gsed|perl|ruby)\s+(?:-[^\s]*\s+)*-i(?![a-zA-Z])/ },
  { why: "find -delete", test: /\bfind\b[^\n;&|]*(?:-delete\b|-exec\w*\s+rm\b)/ },
  { why: "kills a process", test: /(?:^|[\s;&|(])(?:kill|killall|pkill|killall5)\s/ },
];

/** Quote a head word for a regex. */
const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Runs `decide` on every segment that names `head` anywhere, so a call nested in `for`, `do`, `if`, a substitution, or
 * a pipeline is read the same as one at the head of a segment. Segments split on newlines, `;`, `&&`, and `||`, never on
 * a pipe, so a head's own words stay together.
 */
function anySegmentWith(text: string, heads: readonly string[], decide: (segment: string, head: string) => boolean): boolean {
  for (const part of text.split(/[\n;]|&&|\|\|/)) {
    for (const head of heads) {
      const match = new RegExp(`(?:^|[\\s;&|(\"\'\`])${escapeWord(head)}\\s`).exec(part);
      if (!match) continue;
      const segment = part.slice(match.index).trimStart();
      if (decide(segment, head)) return true;
    }
  }
  return false;
}

function splitSegments(command: string): string[] {
  return command.split(/\n|;|&&|\|\||\||&/).map(part => part.trim()).filter(Boolean);
}

/** The head word of a segment, past `VAR=value` prefixes and wrappers such as `sudo` and `timeout 5`. */
function headOf(segment: string): string | undefined {
  const tokens = segment.trim().split(/\s+/);
  let index = 0;
  while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!) || WRAPPERS.has(tokens[index]!))) index++;
  const head = tokens[index];
  return head ? head.replace(/^.*\//, "") : undefined;
}

/** The first non-flag word after `head` in a segment; option values are skipped for the flags that take one. */
function subcommandOf(segment: string, head: string): string | undefined {
  const tokens = segment.trim().split(/\s+/);
  let index = tokens.findIndex(token => token.replace(/^.*\//, "") === head) + 1;
  for (; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "-C" || token === "-c" || token === "-R" || token === "--repo" || token === "-m" || token === "--message" || token === "-n" || token === "--namespace") { index++; continue; }
    if (token.startsWith("-")) continue;
    return token.replace(/[)`]+$/, "");
  }
  return undefined;
}

function gitAsks(segment: string): boolean {
  const sub = subcommandOf(segment, "git");
  if (sub === undefined) return false;
  if (GIT_READ_ONLY.has(sub)) {
    // `git branch -D`, `git tag -d`, `git remote add`: the read-only subcommand has writing flags.
    if (sub === "branch" && /\s-[dDmMcC]\b|--delete\b|--move\b|--copy\b|--force\b/.test(segment)) return true;
    if (sub === "tag" && /\s-[dDafm]\b|--delete\b|--force\b|--annotate\b/.test(segment)) return true;
    if (sub === "remote" && /\s(?:add|remove|rm|set-url|rename|prune)\b/.test(segment.replace(/\bremote\b/, ""))) return true;
    if (sub === "worktree" && /\s(?:add|remove|move|prune)\b/.test(segment)) return true;
    if (sub === "submodule" && !/\sstatus\b/.test(segment)) return true;
    // A bare `git stash` saves state; only `list` and `show` read.
    if (sub === "stash") return !/\s(?:list|show)\b/.test(segment);
    if (sub === "notes") return !/\s(?:list|show)\b/.test(segment);
    if (sub === "config" && /\s(?:set|add|unset|remove-section|rename-section)\b/.test(segment)) return true;
    if (sub === "reflog" && /\s(?:delete|expire)\b/.test(segment)) return true;
    return false;
  }
  return true;
}

function externalAsks(head: string, segment: string): boolean {
  const sub = subcommandOf(segment, head);
  if (head === "make" || head === "gradle" || head === "./gradlew") return /\b(?:deploy|publish|release|install|uninstall|upload|push|ship|prod|production|provision|apply|destroy)\b/.test(segment);
  if (head === "flutter") return /\s(?:build|pub|run|install|clean|drive|emulators?)\b/.test(segment);
  if (head === "curl") return curlAsks(segment);
  if (head === "wget") return /\s--post-data\b|\s--post-file\b|\s--method\b|\s-O\b|\s--output-document\b|\s--delete-after\b/.test(segment);
  if (head === "kill") return true;
  if (head === "gh" || head === "glab") return ghAsks(sub, segment);
  if (head === "aws") return !/^(?:s3api\s+(?:list|get-object|head-object|describe)|sts\s+get-caller-identity)/.test(restAfter(segment, head));
  if (head === "gcloud" || head === "az") return !/^(?:auth\b|config\b|version\b|info\b)/.test(restAfter(segment, head));
  const readOnly = READ_ONLY_SUBCOMMANDS[head];
  if (sub === undefined) {
    // `terraform state list` and `pulumi stack` are read only; every other bare call of these heads can write.
    return readOnly === undefined || head === "sudo" || head === "doas" || head === "mount" || head === "umount" || head === "defaults";
  }
  if (readOnly === undefined) return true;
  return !readOnly.has(sub);
}

/** The segment after its head word, for heads whose second word carries the read-only nature. */
function restAfter(segment: string, head: string): string {
  const index = segment.indexOf(head);
  return index < 0 ? segment : segment.slice(index + head.length).trim();
}

/** curl writes when it sends a body or a non-GET method, or names an output file other than stdout. */
function curlAsks(segment: string): boolean {
  if (/\s-X\s*(?!GET\b)\w+|\s--request\s+(?!GET\b)\w+|\s-d\b|\s--data\w*|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s--post\w*/.test(segment)) return true;
  const output = /\s-o\s*(\S+)|\s--output\s+(\S+)/.exec(segment);
  if (output) {
    const target = output[1] ?? output[2]!;
    return target !== "-" && !TEMP_TARGET.test(target);
  }
  return false;
}

function ghAsks(sub: string | undefined, segment: string): boolean {
  if (sub === undefined) return false;
  // `gh api` with a write method or a field writes; a bare `gh api .../repos` reads.
  if (sub === "api") return /\s-X\s*(?!GET\b)|\s--method\s+(?!GET\b)|\s-f\b|\s--field\b|\s-F\b|\s--raw-field\b/.test(segment);
  const second = segment.trim().split(/\s+/).find((token, index, all) => index > all.findIndex(item => item === sub) && !token.startsWith("-"));
  if (sub === "pr" || sub === "issue" || sub === "release" || sub === "run" || sub === "workflow" || sub === "gist" || sub === "cache") {
    if (second === undefined) return false;
    if (GH_WRITE_SECONDS.has(second)) return true;
    return !GH_READ_ONLY_SECONDS.has(second);
  }
  if (sub === "repo") return second !== undefined && GH_WRITE_SECONDS.has(second);
  return false;
}

/**
 * Whether this call needs a Jev request, and the short reason when it does not.
 * `text` is the command with data text blanked (`stripDataText`), so a commit message that mentions a push is not a push.
 */
export function actionAskGate(tool: string, input: Record<string, unknown>, text: string | undefined, cwd?: string, scripts?: readonly ScriptSource[]): AskDecision {
  if (ALWAYS_ASK.has(tool)) return { ask: true, why: tool };
  const view = commandOf(tool, input);
  const command = view?.command ?? text;
  if (command === undefined) {
    // A command-shaped tool with no readable command is judged from its JSON input only, so nothing can be left out.
    return { ask: true, why: `${tool} input` };
  }
  const scanned = text ?? command;
  const httpTool = /^(?:ctx_execute|ctx_batch_execute|ctx_execute_file)$/.test(tool);
  if (!httpTool && !view?.shell) return { ask: true, why: `${tool} code` };
  return gateCommand(scanned, command, cwd, scripts);
}

/** The decision for one shell command. Exported for the replay and for tests. A command that runs a body from disk
 * also asks when that body holds a shape the gate would ask a typed command for. */
export function gateCommand(scanned: string, raw: string = scanned, cwd?: string, scripts?: readonly ScriptSource[]): AskDecision {
  const direct = gateText(scanned, raw);
  if (direct.ask) return direct;
  const sources = scripts ?? (cwd === undefined ? [] : scriptSources(scanned, cwd));
  for (const source of sources) {
    const decision = gateText(source.body, source.body);
    if (decision.ask) return { ask: true, why: `runs a script with ${decision.why}` };
  }
  return direct;
}

/** The gate for one text, before any body it runs is read. */
function gateText(scanned: string, raw: string = scanned): AskDecision {
  // A script given on the command line or on stdin is scanned as a command: `python3 -c "shutil.rmtree(...)"` asks.
  const sink = SCRIPT_SINK.test(raw);
  const texts = sink && scanned !== raw ? [scanned, raw] : [scanned];
  for (const text of texts) {
    if (anySegmentWith(text, ["git"], segment => gitAsks(segment))) return { ask: true, why: "git history or remote write" };
    for (const rule of ANYWHERE) {
      if (!rule.test.test(text)) continue;
      // The pattern only proves a `gh`-shaped word; the subcommand decides, as it does at the head of a segment.
      if (rule.why === "gh write" && !anySegmentWith(text, ["gh", "glab"], (segment, head) => ghAsks(subcommandOf(segment, head), segment))) continue;
      // A read-only sibling of a risky head does not ask: `helm list`, `docker ps`, `npm view`.
      if (rule.why === "network, publish, or infrastructure write" && readOnlyHead(text)) continue;
      return { ask: true, why: rule.why };
    }
    for (const segment of splitSegments(text)) {
      const head = headOf(segment);
      if (head === undefined) continue;
      if (head === "git") { if (gitAsks(segment)) return { ask: true, why: "git history or remote write" }; continue; }
      if (head === "tee") return { ask: true, why: "tee" };
      if (EXTERNAL_HEADS.has(head) && externalAsks(head, segment)) return { ask: true, why: `external or infrastructure command (${head})` };
    }
  }
  return { ask: false, why: "no reversible-or-visible shape" };
}

/** True when every risky head word in the command is used with a read-only subcommand (`docker ps`, `helm list`, `npm view`). */
function readOnlyHead(text: string): boolean {
  let sawRisky = false;
  for (const segment of splitSegments(text)) {
    const head = headOf(segment);
    if (head === undefined || !EXTERNAL_HEADS.has(head)) continue;
    sawRisky = true;
    if (externalAsks(head, segment)) return false;
  }
  return sawRisky;
}
