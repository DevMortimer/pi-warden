// Renders docs/preview.png from an HTML template. The rule, the write, and the agent's reply are from a recorded
// session (2026-09-17, redacted); the lower row comes from the tuning sets and the calibration run.
// Usage: node scripts/render-preview.mjs [path-to-chrome]   (any Chrome/Chromium headless binary)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'docs', 'preview.png');
const html = join(root, 'docs', 'preview.html');

const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Session excerpt. Path shortened, DSN replaced; the rule text and scores are verbatim.
const rule = `# No hardcoded secrets
Source and config code must not contain passwords, API keys,
tokens, or connection URLs (including Supabase DSNs and
\`FLY_API_TOKEN\` values). They come from settings
(\`utils/config.py\`) or the environment.`;

const written = `DSN = os.getenv(
    "SUPABASE_DB_URL", "postgresql://[local default]"
)`;

const steer = `pi-warden: the content just written to scripts/demo_rail_decisions.py violates project rule from pi-warden.md: "No hardcoded secrets" (0.88): Source and config code must not contain passwords, API keys, tokens, or connection URLs (including Supabase DSNs and \`FLY_API_TOKEN\` values). They come from settings (\`utils/config.py\`) or the environ… Fix it in your next edit.`;

const reply = 'The warden flags the hardcoded local DSN. Right call. Making the script require SUPABASE_DB_URL from the environment instead:';

const fixed = `DSN = os.getenv("SUPABASE_DB_URL")
if not DSN:
    sys.exit("Set SUPABASE_DB_URL to the local stack's DB_URL")`;

// The other guards: recorded sessions, scripts/slop-cases.mjs, scripts/calibrate-action.mjs.
const guards = [
  { k: 'slop · written code', v: 'a placeholder test left in after the agent told itself “NO DEAD CODE” → named as <b>dead code · stub</b>; <code>// TODO: implement later</code> scores stub <b>0.99</b>, a why-comment <b>0.08</b>', r: 'steer, the write goes through' },
  { k: 'stuck · tool results', v: 'three failed edits with the same targeting → same strategy <b>0.74</b>, progress 0.63', r: '“stop retrying, state a new hypothesis”' },
  { k: 'done-check · final message', v: '“done” after code changes with 0 passing checks → claims done ≥ <b>0.70</b>', r: 'one follow-up turn: run the checks or say so' },
  { k: 'action · the seatbelt', v: '<code>supabase db reset</code> nobody asked for → irreversible <b>0.85</b>, held; <b>42</b> holds in 17,160 recorded calls, 37 stood', r: 'agent re-plans or asks you in one sentence' },
];

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --muted:#8b949e; --accent:#79c0ff; --purple:#d2a8ff; --red:#ff7b72; --green:#3fb950; --mono:"JetBrains Mono","SF Mono",Menlo,Monaco,monospace; --sans:-apple-system,"Inter","Segoe UI",system-ui,sans-serif; }
  * { box-sizing:border-box; }
  body { margin:0; width:1600px; height:900px; background:var(--bg); color:var(--fg); font-family:var(--sans); padding:44px 56px; display:flex; flex-direction:column; gap:22px; }
  header { display:flex; align-items:flex-end; justify-content:space-between; }
  h1 { margin:0; font-size:44px; letter-spacing:-0.02em; font-weight:700; }
  h1 small { color:var(--muted); font-weight:500; font-size:22px; margin-left:16px; }
  .tag { font-size:25px; color:var(--fg); margin-top:8px; }
  .tag b { color:var(--accent); font-weight:600; }
  .meta { text-align:right; color:var(--muted); font-size:16px; line-height:1.55; white-space:nowrap; }
  .meta code { font-family:var(--mono); color:var(--fg); font-size:15px; }
  .story { display:grid; grid-template-columns:1fr 1fr 1.25fr; gap:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; position:relative; display:flex; flex-direction:column; gap:12px; }
  .card .k { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:0.08em; }
  .card .k code { font-family:var(--mono); text-transform:none; letter-spacing:0; color:var(--fg); font-size:13px; }
  .card:not(:last-child)::after { content:"→"; position:absolute; right:-19px; top:50%; transform:translateY(-55%); color:var(--muted); font-size:24px; }
  pre { margin:0; font-family:var(--mono); font-size:14.5px; line-height:1.5; white-space:pre-wrap; color:var(--fg); background:#0d1117; border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  pre.rule { color:#e6edf3; } pre.rule .h { color:var(--accent); font-weight:600; }
  pre.write .bad { color:var(--red); }
  pre.fixed .good { color:var(--green); }
  .score { display:flex; align-items:center; gap:12px; font-size:16px; }
  .bar { display:inline-block; width:140px; height:9px; background:#21262d; border-radius:5px; overflow:hidden; }
  .fill { display:block; height:100%; border-radius:5px; background:var(--red); }
  .num { font-family:var(--mono); font-size:15px; color:var(--red); }
  .pill { font-family:var(--mono); font-size:13px; padding:3px 10px; border-radius:999px; font-weight:600; background:#3d1a1a; color:var(--red); }
  .steer { font-family:var(--mono); font-size:13.5px; line-height:1.5; color:#c9d1d9; background:#0d1117; border-left:3px solid var(--purple); border-radius:0 8px 8px 0; padding:10px 14px; }
  .steer b { color:var(--purple); font-weight:600; }
  .reply { font-size:15.5px; line-height:1.45; color:var(--fg); }
  .reply .who { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:0.08em; display:block; margin-bottom:4px; }
  .guards { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; }
  .guard { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .guard .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.08em; }
  .guard .v { font-size:14.5px; margin-top:6px; line-height:1.45; }
  .guard .v b { color:var(--accent); } .guard .v code { font-family:var(--mono); font-size:13px; color:var(--purple); }
  .guard .r { color:var(--muted); font-size:13px; margin-top:8px; }
  footer { display:flex; flex-direction:column; align-items:flex-start; gap:10px; margin-top:auto; }
  .widget { font-family:var(--mono); font-size:15px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:9px 14px; white-space:nowrap; }
  .widget .dim { color:var(--muted); } .widget .hot { color:var(--red); }
  .cta { color:var(--muted); font-size:15px; } .cta code { font-family:var(--mono); color:var(--fg); }
</style></head><body>
  <header>
    <div>
      <h1>pi-warden <small>for Pi</small></h1>
      <div class="tag">Your <b>AGENTS.md</b>, checked at every write.</div>
    </div>
    <div class="meta">Rules as Markdown headings · judged by Jev on each <code>write</code> and <code>edit</code><br>about 250 ms, a fraction of a cent · the agent is told, not you<br>also: slop, stuck loops, unverified “done”, big outputs, and the rare destructive command</div>
  </header>

  <div class="story">
    <div class="card">
      <div class="k">1 · your rule · <code>pi-warden.md</code></div>
      <pre class="rule"><span class="h">${esc(rule.split('\n')[0])}</span>\n${esc(rule.split('\n').slice(1).join('\n'))}</pre>
      <div class="reply"><span class="who">why it is a rule and not a linter</span>No linter knows what a Supabase DSN looks like in a default argument. Three lines of Markdown do.</div>
    </div>
    <div class="card">
      <div class="k">2 · the agent writes · <code>scripts/demo_rail_decisions.py</code></div>
      <pre class="write">${esc(written).replace(esc('"postgresql://[local default]"'), '<span class="bad">"postgresql://[local default]"</span>')}</pre>
      <div class="score"><span class="bar"><span class="fill" style="width:88%"></span></span><span class="num">0.88</span><span class="pill">violation</span><span style="color:var(--muted);font-size:14px">one of 13 rules asked</span></div>
      <div class="reply"><span class="who">what happened to the write</span>It went through. A held write would leave a half-written file; the agent gets the rule instead.</div>
    </div>
    <div class="card">
      <div class="k">3 · the agent is told, and fixes it in the next turn</div>
      <div class="steer"><b>pi-warden:</b> ${esc(steer.slice('pi-warden: '.length))}</div>
      <div class="reply"><span class="who">agent, next turn</span>“${esc(reply)}”</div>
      <pre class="fixed"><span class="good">${esc(fixed)}</span></pre>
    </div>
  </div>

  <div class="guards">${guards.map(g => `<div class="guard"><div class="k">${g.k}</div><div class="v">${g.v}</div><div class="r">${g.r}</div></div>`).join('')}</div>

  <footer>
    <div class="widget">warden <span class="dim">·</span> rules <span class="dim">·</span> write scripts/demo_rail_decisions.py <span class="dim">·</span> 13 rules <span class="dim">·</span> <span class="hot">No hardcoded secrets 0.88</span> <span class="dim">·</span> <span class="hot">violation</span></div>
    <div class="cta"><code>pi install npm:pi-warden</code> · <code>/warden enable</code> · rule, write, and reply from a recorded session; other numbers from the tuning sets and 17k replayed calls</div>
  </footer>
</body></html>`;

mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(html, page);

const candidates = [
  process.argv[2],
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ...['1243', '1234', '1223', '1200'].map(v => join(homedir(), 'Library', 'Caches', 'ms-playwright', `chromium_headless_shell-${v}`, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')),
].filter(Boolean);
const chrome = candidates.find(path => existsSync(path));
if (!chrome) {
  console.error('No Chrome binary found. Pass one as the first argument or set CHROME_BIN. The HTML is at docs/preview.html.');
  process.exit(1);
}
execFileSync(chrome, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
  '--window-size=1600,900', `--screenshot=${out}`, `file://${html}`,
], { stdio: 'ignore' });
console.log(`wrote ${out}`);
