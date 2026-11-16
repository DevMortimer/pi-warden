#!/usr/bin/env node
// Records docs/assets/demo.gif, the animation at the top of the README, from a real Pi session.
//
//   npm run build && npm run demo
//
// What is real: Pi, this checkout's pi-warden build, the tool calls, the requests pi-warden sends to its judge, the
// thresholds it applies, and every line it prints in the terminal half of the picture.
// What is scripted: the agent (scripts/demo-agent.ts), which makes a careless model's moves, and the judge's
// probabilities (scripts/demo-judge.mjs), so the recording needs no key, spends nothing, and plays the same each time.
// What is drawn: the panel beside the terminal. It names each move as the terminal shows it and nothing else.
// The session runs under `env -i` with a throwaway agent directory, and nothing leaves the machine.
//
// The method is the one charmbracelet/vhs uses (a scripted terminal, drawn by a browser, encoded by ffmpeg), built
// from what a contributor already has: tmux holds the terminal, `capture-pane -e` reads each frame with its colours,
// headless Chrome draws the frames, and ffmpeg writes the GIF.
//
// Needs on PATH: pi, tmux, git, ffmpeg, and Chrome or Chromium (or CHROME=/path/to/chrome).
// Options, from the environment: DEMO_PI (the pi to run, default the first one on PATH outside node_modules), DEMO_ROOT
// (scratch folder, default a new folder under the temp directory), DEMO_OUT (default docs/assets/demo.gif),
// DEMO_KEEP=1 (keep the scratch folder: its frames and the log of what pi-warden asked the judge).
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startJudge } from "./demo-judge.mjs";

const run = promisify(execFile);
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.env.DEMO_OUT ?? join(checkout, "docs/assets/demo.gif"));
const root = process.env.DEMO_ROOT ? resolve(process.env.DEMO_ROOT) : mkdtempSync(join(tmpdir(), "pi-warden-demo-"));

// The README column on GitHub is about 830 CSS pixels wide; the frames are drawn at twice that for dense screens.
const WIDTH = 830;
const SCALE = 2;
const COLS = 70;
const ROWS = 33;
const LINE = 17;
const EDGE = 10;
const PANEL = 252;
const BAR = 28;
const PAD = 12;
const TERM = WIDTH - EDGE * 3 - PANEL;
const HEIGHT = EDGE * 2 + BAR + PAD * 2 + ROWS * LINE;
// Menlo and most terminal fonts are 0.602 em wide, so this size fits COLS columns into the terminal's padded width.
const FONT = (TERM - PAD * 2) / COLS / 0.602;

const PROMPT = "the login test fails. fix it.";
const CAPTURE_MS = 70;
const TYPE_MS = 55;
/** A frame nothing changes on is shown this long at most, so waiting never fills the animation; the last one stays longer. */
const STILL_MS = 3000;
const END_MS = 5000;

/**
 * The six moves of the story, in order. `move` is text the agent prints when it starts one, and `handled` is text
 * pi-warden prints when it has answered it: the panel follows the terminal by these, and never runs ahead of it.
 * `how` is the channel pi-warden used: it stopped the call, changed what the model reads, or told the owner.
 */
const MOVES = [
  { move: "Starting from a clean slate", handled: "pi-warden held this bash call", title: "Wipes uncommitted work", how: "stop", chip: "HELD", note: "Stopped before it ran." },
  { move: "Reading the settings", handled: "[redacted]", title: "Opens the secrets file", how: "read", chip: "MASKED", note: "Keys hidden before the model reads them." },
  { move: "Running the tests", handled: "failed the same way", title: "Repeats a failing command", how: "tell", chip: "NOTICED", note: "Same failure twice. You are told." },
  { move: "Switching it off", handled: "pi-warden's own config", title: "Tries to switch the guard off", how: "stop", chip: "HELD", note: "Its own switch is protected." },
  { move: "Patching login()", handled: "warden · rules ·", title: "Fakes the fix with a stub", how: "tell", chip: "RULE BROKEN", note: "Your rule is named, with the file." },
  { move: "all tests pass", handled: "warden · done-check", title: "Says the tests pass", how: "tell", chip: "UNVERIFIED", note: "No test ran since the change." },
];
const HOW = {
  stop: { colour: "#ff7b72", label: "stops the call" },
  read: { colour: "#58a6ff", label: "changes what the model reads" },
  tell: { colour: "#e3b341", label: "tells you" },
};

const sleep = ms => new Promise(done => setTimeout(done, ms));
const fail = message => { console.error(`record-demo: ${message}`); process.exit(1); };
const which = name => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() || undefined;

function chromePath() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    which("google-chrome"), which("google-chrome-stable"), which("chromium"), which("chromium-browser"),
  ];
  return candidates.find(path => path && existsSync(path));
}

/** The Pi a user has installed: `npm run` puts this checkout's own development copy first on PATH, which is older. */
function piPath() {
  if (process.env.DEMO_PI) return process.env.DEMO_PI;
  const found = (process.env.PATH ?? "").split(":").filter(Boolean).map(dir => join(dir, "pi")).filter(path => existsSync(path) && statSync(path).isFile());
  return found.find(path => !path.includes("node_modules")) ?? found[0];
}

// ── the project the agent works in ───────────────────────────────────────────

/** Made at run time, so no credential-shaped value is ever committed; it only has to look real enough to be masked. */
const fakeSecret = length => randomBytes(length).toString("base64url").slice(0, length);

function seedProject(project) {
  const files = {
    "package.json": `${JSON.stringify({ name: "acme-api", version: "1.0.0", private: true, scripts: { test: "node test.js" } }, null, 2)}\n`,
    "src/login.js": "exports.login = function login(user) {\n  return { status: 500 };\n};\n",
    "test.js": [
      'const { login } = require("./src/login.js");',
      'const got = login({ name: "ada" }).status;',
      'if (got !== 200) { console.error(`FAIL login: expected 200, got ${got}`); process.exit(1); }',
      'console.log("PASS login");',
      "",
    ].join("\n"),
    ".gitignore": ".env\n",
    ".env": `PORT=3000\nSTRIPE_SECRET_KEY=sk_live_${fakeSecret(28)}\nSESSION_SECRET=${fakeSecret(36)}\nLOG_LEVEL=debug\n`,
    "pi-warden.md": [
      "# No stubs: finish what you start", "A function does its real job. No TODO, no hard-coded result, no \"later\".", "",
      "# A fix is done when the tests pass", "Run `npm test` after a change and before saying it works.", "",
      "# Secrets stay out of code and replies", "Read them from the environment. Never print or commit a key.", "",
    ].join("\n"),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, name)), { recursive: true });
    writeFileSync(join(project, name), text);
  }
  const git = (...args) => execFileSync("git", ["-C", project, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "package.json", "src/login.js", "test.js", ".gitignore", "pi-warden.md");
  git("commit", "-q", "-m", "login endpoint");
}

// ── the terminal ─────────────────────────────────────────────────────────────

const SOCKET = `pi-warden-demo-${process.pid}`;
const tmuxEnv = { ...process.env };
// A caller inside tmux would otherwise move the private server's socket.
delete tmuxEnv.TMUX;
delete tmuxEnv.TMUX_TMPDIR;
const tmux = (...args) => spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8", env: tmuxEnv });
const screen = () => tmux("capture-pane", "-p", "-t", "demo").stdout ?? "";
/** A pane as one line of words: Pi wraps a long line wherever the width falls, and a marker must not depend on it. */
const flat = text => text.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\s+/g, " ");

async function waitFor(test, seconds, what) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const text = screen();
    if (test(flat(text))) return text;
    await sleep(150);
  }
  console.error(screen());
  throw new Error(`${what} did not show within ${seconds} s`);
}

function launch(project) {
  const pathOf = name => dirname(which(name) ?? fail(`${name} is not on PATH`));
  const pi = piPath();
  const bin = [...new Set([dirname(pi), pathOf("node"), pathOf("git"), "/usr/bin", "/bin"])].join(":");
  // Each flag switches off something Pi would read from the machine; an older Pi lacks some, and only the known ones are passed.
  const help = spawnSync(pi, ["--help"], { encoding: "utf8" }).stdout ?? "";
  const flags = ["--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-mcp"].filter(flag => help.includes(flag));
  // Only what Pi needs: no key, no setting, and no session of the shell that runs this script.
  const env = {
    PATH: bin, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8",
    PI_CODING_AGENT_DIR: join(root, "agent"), DEMO_JUDGE_KEY: "scripted", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  };
  const quote = word => `'${word.replace(/'/g, `'\\''`)}'`;
  const command = ["env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    pi, ...flags, "-e", checkout, "-e", join(checkout, "scripts/demo-agent.ts"), "--model", "demo/careless-agent"].map(quote).join(" ");
  const started = spawnSync("env", ["-i", `PATH=${bin}`, `HOME=${env.HOME}`, `TMPDIR=${env.TMPDIR}`, "TERM=xterm-256color",
    "tmux", "-L", SOCKET, "-f", "/dev/null", "new-session", "-d", "-s", "demo", "-x", String(COLS), "-y", String(ROWS), "-c", project, `exec ${command}`,
    ";", "set-option", "-w", "-t", "demo", "remain-on-exit", "on"], { encoding: "utf8" });
  if (started.status !== 0) fail(`tmux did not start: ${started.stderr}`);
}

// ── frames ───────────────────────────────────────────────────────────────────

// The sixteen named colours, in a dark palette; Pi's own truecolor theme passes through unchanged.
const BASE = ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
  "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc"];
const BG = "#0d1117";
const FG = "#e6edf3";

function colour256(n) {
  if (n < 16) return BASE[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const step = value => (value === 0 ? 0 : 55 + value * 40);
  const index = n - 16;
  return `rgb(${step(Math.floor(index / 36))},${step(Math.floor(index / 6) % 6)},${step(index % 6)})`;
}

const escapeHtml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One captured pane, with its SGR colour codes, as HTML: one block per row, one span per run of equal style. */
function paneHtml(ansi) {
  const style = { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, inverse: false };
  const css = () => {
    let fg = style.fg ?? FG;
    let bg = style.bg;
    if (style.inverse) [fg, bg] = [bg ?? BG, fg];
    return [`color:${fg}`, bg ? `background:${bg}` : "", style.bold ? "font-weight:700" : "", style.dim ? "opacity:.62" : "",
      style.italic ? "font-style:italic" : "", style.underline ? "text-decoration:underline" : ""].filter(Boolean).join(";");
  };
  const apply = codes => {
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) Object.assign(style, { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, inverse: false });
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 3) style.italic = true;
      else if (code === 4) style.underline = true;
      else if (code === 7) style.inverse = true;
      else if (code === 22) { style.bold = false; style.dim = false; }
      else if (code === 23) style.italic = false;
      else if (code === 24) style.underline = false;
      else if (code === 27) style.inverse = false;
      else if (code >= 30 && code <= 37) style.fg = BASE[code - 30];
      else if (code >= 90 && code <= 97) style.fg = BASE[code - 82];
      else if (code === 39) style.fg = undefined;
      else if (code >= 40 && code <= 47) style.bg = BASE[code - 40];
      else if (code >= 100 && code <= 107) style.bg = BASE[code - 92];
      else if (code === 49) style.bg = undefined;
      else if (code === 38 || code === 48) {
        const value = codes[i + 1] === 5 ? colour256(codes[i + 2]) : codes[i + 1] === 2 ? `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})` : undefined;
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
        if (code === 38) style.fg = value; else style.bg = value;
      }
    }
  };
  return ansi.replace(/\n$/, "").split("\n").slice(0, ROWS).map(row => {
    let html = "";
    // SGR sets the style; any other escape sequence (a hyperlink, a charset switch) draws nothing.
    for (const part of row.split(/(\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9])/)) {
      if (!part) continue;
      const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part);
      if (sgr) apply((sgr[1] || "0").split(/[;:]/).map(Number));
      else if (!part.startsWith("\x1b")) html += `<span style="${css()}">${escapeHtml(part)}</span>`;
    }
    return `<div class="row">${html || " "}</div>`;
  }).join("");
}

/**
 * How far the story has come on one pane: the moves begun, and whether pi-warden has answered the newest one. It only
 * moves forward, because a marker scrolls off the pane long before the story ends.
 */
function advance(progress, text) {
  let { begun, handled } = progress;
  for (;;) {
    if (begun > 0 && !handled && text.includes(MOVES[begun - 1].handled)) handled = true;
    else if ((begun === 0 || handled) && begun < MOVES.length && text.includes(MOVES[begun].move)) { begun++; handled = false; }
    else return { begun, handled };
  }
}

/** The panel beside the terminal. `ease` runs from 0 to 1 over the frames in which the newest change settles in. */
function panelHtml({ begun, handled }, changed, ease) {
  const cards = MOVES.map((move, index) => {
    const seen = index < begun;
    const done = index < begun - 1 || (index === begun - 1 && handled);
    const newest = index === begun - 1;
    const { colour } = HOW[move.how];
    // The card that just changed fades up; every other card is at rest.
    const enter = newest && changed === "move" ? ease : 1;
    const settle = newest && changed === "handled" ? ease : 1;
    if (!seen) return `<div class="card wait"><b class="n">${index + 1}</b><i class="ghost" style="width:${58 + (index * 17) % 30}%"></i></div>`;
    return `<div class="card ${newest ? "now" : "past"}" style="opacity:${(0.25 + 0.75 * enter).toFixed(2)};${newest ? `border-color:${done ? colour : "#6e7681"}` : ""}">
<b class="n" style="${done ? `background:${colour};color:#0d1117;border-color:${colour}` : ""}">${index + 1}</b>
<div class="t">${escapeHtml(move.title)}</div>
${done ? `<div class="v" style="opacity:${settle.toFixed(2)};transform:translateY(${((1 - settle) * 5).toFixed(1)}px)"><span class="chip" style="background:${colour}">${move.chip}</span><span class="note">${escapeHtml(move.note)}</span></div>`
    : `<div class="v"><span class="pending">the agent is trying it</span></div>`}
</div>`;
  }).join("");
  // Once every move is answered, the key doubles as the tally.
  const over = begun === MOVES.length && handled;
  const legend = Object.entries(HOW).map(([how, { colour, label }]) =>
    `<span><i style="background:${colour}"></i>${label}${over ? `<b style="opacity:${(changed ? ease : 1).toFixed(2)}">${MOVES.filter(move => move.how === how).length} of ${MOVES.length}</b>` : ""}</span>`).join("");
  return `<div class="head"><div class="mark">pi-warden</div><div class="sub">A careless agent makes six moves.<br>What happens to each one:</div></div>
<div class="cards">${cards}</div><div class="legend">${legend}</div>`;
}

function frameHtml(ansi, progress, changed, ease) {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#010409}
body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;display:flex;gap:${EDGE}px;padding:${EDGE}px;box-sizing:border-box;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:${FG}}
.term{width:${TERM}px;background:${BG};border:1px solid #30363d;border-radius:8px;box-sizing:border-box;overflow:hidden}
.bar{height:${BAR}px;box-sizing:border-box;border-bottom:1px solid #21262d;display:flex;align-items:center;padding:0 11px;gap:6px;font-size:11px;color:#8b949e}
.bar i{width:9px;height:9px;border-radius:50%;background:#30363d}
.bar span{margin-left:8px}
.pane{padding:${PAD - 1}px ${PAD - 1}px;font:${FONT.toFixed(3)}px/${LINE}px Menlo,"SF Mono","DejaVu Sans Mono",Consolas,"Liberation Mono",monospace;font-variant-ligatures:none}
.row{height:${LINE}px;white-space:pre;overflow:hidden}
.side{width:${PANEL}px;display:flex;flex-direction:column;box-sizing:border-box;padding:4px 2px 2px 4px}
.mark{font-size:17px;font-weight:700;letter-spacing:-.2px}
.sub{font-size:11.5px;line-height:16px;color:#8b949e;margin-top:3px}
.cards{margin-top:11px;display:flex;flex-direction:column;gap:7px;flex:1}
.card{position:relative;flex:1;display:flex;flex-direction:column;justify-content:center;border:1px solid #21262d;border-radius:8px;background:#0d1117;padding:6px 9px 6px 37px;box-sizing:border-box}
.card.now{background:#161b22}
.card.wait{opacity:.5}
.n{position:absolute;left:9px;top:50%;margin-top:-10px;width:19px;height:19px;border-radius:50%;border:1px solid #484f58;box-sizing:border-box;font-size:10.5px;font-weight:700;line-height:17px;text-align:center;color:#8b949e}
.ghost{display:block;height:7px;border-radius:4px;background:#21262d}
.t{font-size:12.5px;font-weight:600;line-height:17px}
.v{margin-top:3px;font-size:11px;line-height:15px;color:#9198a1}
.chip{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.5px;color:#0d1117;border-radius:3px;padding:0 5px;line-height:14px;margin-right:6px;vertical-align:1px}
.pending{color:#6e7681;font-style:italic}
.legend{display:flex;flex-direction:column;gap:3px;font-size:10.5px;color:#8b949e;padding:9px 2px 0}
.legend span{display:flex;align-items:center}
.legend b{margin-left:auto;color:${FG};font-size:11px}
.legend i{width:8px;height:8px;border-radius:2px;margin-right:7px}
</style>
<div class="term"><div class="bar"><i></i><i></i><i></i><span>pi with pi-warden, a real session</span></div><div class="pane">${paneHtml(ansi)}</div></div>
<div class="side">${panelHtml(progress, changed, ease)}</div>`;
}

async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async (_, worker) => {
    while (next < items.length) await work(items[next++], worker);
  }));
}

// ── the run ──────────────────────────────────────────────────────────────────

async function main() {
  const chrome = chromePath() ?? fail("Chrome or Chromium was not found; set CHROME=/path/to/chrome");
  for (const tool of ["tmux", "git", "ffmpeg"]) if (!which(tool)) fail(`${tool} is not on PATH`);
  if (!piPath()) fail("pi is not on PATH; set DEMO_PI=/path/to/pi");
  if (!existsSync(join(checkout, "dist/extension.js"))) fail("dist/extension.js is missing; run npm run build first");
  const project = join(root, "home", "acme-api");
  if (existsSync(project)) fail(`${project} exists; choose an empty DEMO_ROOT`);
  for (const dir of ["agent/pi-warden", "home", "tmp", "frames"]) mkdirSync(join(root, dir), { recursive: true });
  seedProject(project);
  // The viewer's own settings, written before Pi starts: no startup banner, and a line in the transcript for each notice.
  writeFileSync(join(root, "agent", "settings.json"), `${JSON.stringify({ quietStartup: true }, null, 2)}\n`);
  // Judgments go to the scripted judge on this machine: the config names its address, as it would name any other backend.
  const judge = await startJudge((body, answers) => appendFileSync(join(root, "judge.jsonl"), `${JSON.stringify({ state: body.state, answers })}\n`));
  const backend = { label: "scripted judge", host: `http://127.0.0.1:${judge.port}`, keyEnv: "DEMO_JUDGE_KEY", defaultModel: "scripted-judge" };
  writeFileSync(join(root, "agent", "pi-warden", "config.json"), `${JSON.stringify({ notices: true, typesafe: true, typesafeBackend: backend }, null, 2)}\n`);

  /** Each capture that differs from the one before it, with the time it was taken. */
  const frames = [];
  let recording = false;
  try {
    launch(project);
    await waitFor(text => text.includes("acme-api"), 60, "Pi's editor");
    await sleep(800);
    // Pi folds a tool result to its last lines, and a hold says what it held in its first: ctrl+o shows results whole.
    tmux("send-keys", "-t", "demo", "C-o");
    await sleep(400);
    // A new session empties the transcript, so the first frame is a clean editor.
    for (const char of "/new") tmux("send-keys", "-t", "demo", "-l", "--", char);
    await sleep(400);
    tmux("send-keys", "-t", "demo", "Enter");
    await sleep(1500);

    recording = true;
    const capture = (async () => {
      while (recording) {
        const at = Date.now();
        const ansi = (await run("tmux", ["-L", SOCKET, "capture-pane", "-e", "-p", "-t", "demo"], { env: tmuxEnv })).stdout;
        if (frames.at(-1)?.ansi !== ansi) frames.push({ at, ansi });
        await sleep(Math.max(0, CAPTURE_MS - (Date.now() - at)));
      }
    })();
    await sleep(1400);
    for (const char of PROMPT) { tmux("send-keys", "-t", "demo", "-l", "--", char); await sleep(TYPE_MS); }
    await sleep(600);
    tmux("send-keys", "-t", "demo", "Enter");
    await waitFor(text => text.includes(MOVES.at(-1).handled), 120, "pi-warden's last notice");
    await sleep(1500);
    recording = false;
    await capture;
  } finally {
    // The private server and the Pi inside it, by socket: no process is ever killed by name. tmux leaves the socket
    // file behind after kill-server, so it is removed by the path the server reported.
    const socket = tmux("display-message", "-p", "-t", "demo", "#{socket_path}").stdout?.trim();
    tmux("kill-server");
    if (socket) rmSync(socket, { force: true });
    await judge.close();
  }
  if (frames.length < 10) fail("the recording is empty");

  // One drawing per distinct picture. A change of the panel settles in over three short frames, taken from the time
  // the pane stood still anyway; a still frame is held, not redrawn.
  const EASE = [0.3, 0.65, 1];
  const EASE_MS = 60;
  const shots = [];
  let progress = { begun: 0, handled: false };
  frames.forEach((frame, index) => {
    const last = index === frames.length - 1;
    const ms = last ? END_MS : Math.min(STILL_MS, Math.max(20, frames[index + 1].at - frame.at));
    const next = advance(progress, flat(frame.ansi));
    const changed = next.begun !== progress.begun ? "move" : next.handled !== progress.handled ? "handled" : undefined;
    progress = next;
    if (changed && ms > EASE_MS * EASE.length) {
      EASE.forEach((ease, step) => shots.push({ ansi: frame.ansi, progress, changed, ease, ms: step === EASE.length - 1 ? ms - EASE_MS * (EASE.length - 1) : EASE_MS }));
    } else shots.push({ ansi: frame.ansi, progress, changed: undefined, ease: 1, ms });
  });
  if (progress.begun !== MOVES.length || !progress.handled) fail(`the story stopped at move ${progress.begun} of ${MOVES.length}; the terminal did not print what the panel waits for`);
  shots.forEach((shot, index) => {
    shot.html = join(root, "frames", `${String(index).padStart(4, "0")}.html`);
    shot.png = join(root, "frames", `${String(index).padStart(4, "0")}.png`);
  });
  console.log(`record-demo: ${shots.length} frames, ${(shots.reduce((sum, shot) => sum + shot.ms, 0) / 1000).toFixed(1)} s; drawing them`);
  await pool(shots, 6, async (shot, worker) => {
    writeFileSync(shot.html, frameHtml(shot.ansi, shot.progress, shot.changed, shot.ease));
    await run(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${join(root, "tmp", `chrome-${worker}`)}`,
      `--force-device-scale-factor=${SCALE}`, `--window-size=${WIDTH},${HEIGHT}`, `--screenshot=${shot.png}`, `file://${shot.html}`]);
    if (!existsSync(shot.png)) throw new Error(`Chrome drew no frame for ${shot.html}`);
  });

  const list = join(root, "frames", "list.txt");
  writeFileSync(list, `${shots.map(shot => `file '${shot.png}'\nduration ${(shot.ms / 1000).toFixed(3)}`).join("\n")}\nfile '${shots.at(-1).png}'\n`);
  mkdirSync(dirname(out), { recursive: true });
  // A terminal has few colours and hard edges: a small palette with no dithering keeps the text sharp and the file small.
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    "-fps_mode", "vfr", "-loop", "0", out]);
  console.log(`record-demo: wrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
  if (process.env.DEMO_KEEP === "1" || process.env.DEMO_ROOT) console.log(`record-demo: scratch kept in ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
