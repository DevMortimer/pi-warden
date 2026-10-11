// Renders docs/hero.png (the README banner) from an HTML template written to docs/hero.html.
// Usage: node scripts/render-hero.mjs [path-to-chrome]   (any Chrome/Chromium headless binary)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// ---------------------------------------------------------------------------------------------------------------
// Every number in the image. Each one is stated in a file in this repo; none is computed here.
// FIELD = eval/reports/2026-10-01-field-usage/README.md (raw counts in usage.json next to it).
const numbers = {
  sessions: 1168,             // FIELD line 13, Totals table: "Sessions | 1,168"
  from: '2026-09-16',         // FIELD line 1, title: "Field usage, 2026-09-16 to 2026-10-01"
  to: '2026-10-01',           // FIELD line 1, same title
  doneNudged: 124,            // FIELD line 22: "It nudged 124 times when an agent said it was done with no passing test ..."
  doneRanCheck: 94,           // FIELD line 22: "In 94 of those (76%), the agent's next few calls ran a check."
  doneRanCheckPct: 76,        // FIELD line 22: same sentence, "(76%)"
  nextMessages: 'four',       // FIELD "Method and limits": "one of the agent's next four messages ran a verification command"
  holdsWithOutcome: 111,      // FIELD line 24: "Of the 111 holds with a recorded outcome"
  holdsSaferRoute: 79,        // FIELD line 24: "the agent took a safer route 79 times"
  holdsApproved: 29,          // FIELD line 24: "the user approved 29"
  holdsDeclined: 3,           // FIELD line 24: "and declined 3"
  ruleSteers: 422,            // FIELD line 26: "422 steers named a project rule, spread over 41 rules"
  rulesDistinct: 41,          // FIELD line 26: same sentence
  doneSteerScore: '0.99',     // eval/reports/2026-09-26-waste-nudges/report.md line 166: "reports completion (0.99) after 1 file change"
  ruleSteerScore: '0.88',     // docs/examples.md line 20: "No hardcoded secrets" (0.88)
};
// ---------------------------------------------------------------------------------------------------------------

// Example texts, all verbatim from the repo:
// - loop "Warden catches it": the done-check steer in eval/reports/2026-09-26-waste-nudges/report.md line 166 (cut at ";").
// - loop "Agent is told why": the same steer continues with doneNudge()'s text, src/done.ts line 270.
// - steer strip: docs/examples.md lines 14-32 (the write, the steer, the fixed line), also shown in docs/preview.png.
const doneSteer = `pi-warden: reports completion (${numbers.doneSteerScore}) after 1 file change with no test, build, or lint run since the last change`;
const doneNudge = "Run the project's tests, build, or lint (whatever exists) on what you changed.";
const written = '"SUPABASE_DB_URL", "postgresql://[local default]"';
const ruleSteer = `pi-warden: the content just written to scripts/demo_rail_decisions.py violates project rule: "No hardcoded secrets" (${numbers.ruleSteerScore}): Source and config code must not contain passwords, API keys, tokens, or connection URLs … Fix it in your next edit.`;
const fixed = 'DSN = os.getenv("SUPABASE_DB_URL")';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'docs', 'hero.png');
const html = join(root, 'docs', 'hero.html');
const [width, height] = [1672, 941];

const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = value => value.toLocaleString('en-US');

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg:#05080f; --line:#2b3342; --fg:#dfe6ef; --muted:#8b95a5; --amber:#f7b955; --red:#ff5d6c; --green:#3fd07f; --slate:#4a5568; --mono:"JetBrains Mono","SF Mono",Menlo,Monaco,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; width:${width}px; height:${height}px; overflow:hidden; background:var(--bg); color:var(--fg); font-family:var(--mono); padding:34px 28px 0; }
  h1 { margin:0 0 0 16px; font-size:58px; line-height:1.1; color:var(--amber); font-weight:700; letter-spacing:-0.01em; }
  .sub { margin:10px 0 0 16px; font-size:22px; color:#b9c6d8; }
  .main { display:grid; grid-template-columns:782px 1fr; gap:20px; margin-top:22px; height:520px; }
  .panel { border:1.5px solid var(--line); border-radius:4px; }
  .loop { position:relative; }
  .loop svg { position:absolute; inset:0; }
  .box { position:absolute; border:1.5px solid #c9d3e0; border-radius:4px; padding:14px 16px; background:var(--bg); }
  .box .t { font-size:20px; font-weight:700; }
  .box .d { font-size:14.5px; line-height:1.5; margin-top:8px; color:#c9d3e0; }
  .center { position:absolute; left:296px; top:222px; width:190px; text-align:center; font-size:18px; line-height:1.4; color:#c9d3e0; }
  .right { display:flex; flex-direction:column; gap:16px; }
  .right .panel { padding:18px 18px; }
  .k { font-size:19px; font-weight:700; }
  .k small { font-weight:400; color:var(--muted); font-size:15px; margin-left:8px; }
  .funnel { display:grid; grid-template-columns:1fr 250px; margin-top:16px; }
  .step { display:flex; align-items:center; gap:18px; height:52px; margin-bottom:10px; }
  .trap { height:100%; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700; clip-path:polygon(0 0, 100% 0, 94% 100%, 6% 100%); }
  .step span { font-size:16px; }
  .note { border-left:1.5px solid var(--line); padding-left:18px; font-size:14px; line-height:1.55; color:#c9d3e0; align-self:center; }
  .bar { display:flex; gap:6px; margin-top:16px; }
  .seg { display:flex; flex-direction:column; gap:10px; min-width:0; }
  .seg b { height:48px; display:flex; align-items:center; justify-content:center; font-size:24px; }
  .seg span { font-size:15px; padding-left:2px; white-space:nowrap; }
  .rules { display:flex; align-items:center; gap:28px; flex:1; }
  .rules .big { font-size:62px; font-weight:700; color:var(--amber); padding-right:28px; border-right:1.5px solid var(--line); }
  .rules .txt { font-size:17px; line-height:1.55; }
  .strip { margin-top:18px; padding:12px 28px; font-size:16px; line-height:1.5; }
  .strip .row { display:flex; gap:14px; }
  .strip .lab { color:var(--muted); width:92px; flex:none; }
  .strip .bad { color:var(--red); } .strip .steer { color:#ff8a95; } .strip .good { color:var(--green); }
  footer { position:absolute; left:28px; right:28px; top:${height - 78}px; border-top:1.5px solid var(--line); padding:18px 4px 0; display:flex; justify-content:space-between; font-size:15px; color:#b9c6d8; }
</style></head><body>
  <h1>Your agent said *done.* It wasn't.</h1>
  <div class="sub">pi-warden tells the agent what it got wrong. The agent fixes it. You don't have to.</div>

  <div class="main">
    <div class="panel loop">
      <svg width="782" height="520" viewBox="0 0 782 520">
        <defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#f7b955"/></marker></defs>
        <g fill="none" stroke="#f7b955" stroke-width="2" marker-end="url(#a)">
          <path d="M532 62 Q630 72 648 160"/>
          <path d="M648 352 Q636 420 584 438"/>
          <path d="M262 438 Q164 420 150 334"/>
          <path d="M150 180 Q168 78 262 62"/>
        </g>
      </svg>
      <div class="box" style="left:272px;top:20px;width:250px"><div class="t" style="color:var(--amber)">Agent acts</div><div class="d">edits a file, then says it is done. No check ran after the edit.</div></div>
      <div class="box" style="left:496px;top:170px;width:268px"><div class="t" style="color:var(--red)">Warden catches it</div><div class="d">${esc(doneSteer)}</div></div>
      <div class="box" style="left:262px;top:372px;width:312px"><div class="t" style="color:var(--amber)">Agent is told why</div><div class="d">${esc(doneNudge)}</div></div>
      <div class="box" style="left:18px;top:190px;width:262px"><div class="t" style="color:var(--green)">Agent fixes itself</div><div class="d">runs the tests, build, or lint, and reports the real result.</div></div>
      <div class="center">no human in<br>the loop</div>
    </div>

    <div class="right">
      <div class="panel">
        <div class="k">When the agent said done with nothing checked</div>
        <div class="funnel">
          <div>
            <div class="step"><div class="trap" style="width:250px;background:var(--amber);color:#1a1205">${n(numbers.doneNudged)}</div><span>times it was told</span></div>
            <div class="step" style="padding-left:30px"><div class="trap" style="width:190px;background:var(--slate)">${n(numbers.doneRanCheck)}</div><span>it ran a check next (${numbers.doneRanCheckPct}%)</span></div>
          </div>
          <div class="note">"Ran a check": one of the agent's next ${numbers.nextMessages} messages ran a test, build, or lint.</div>
        </div>
      </div>

      <div class="panel">
        <div class="k">After Warden held a risky action<small>${n(numbers.holdsWithOutcome)} with a known outcome</small></div>
        <div class="bar">
          <div class="seg" style="flex:${numbers.holdsSaferRoute}"><b style="background:var(--green);color:#04210f">${n(numbers.holdsSaferRoute)}</b><span>agent found a safer way</span></div>
          <div class="seg" style="flex:${numbers.holdsApproved}"><b style="background:#8e9aad;color:#0b0f17">${n(numbers.holdsApproved)}</b><span>you approved it</span></div>
          <div class="seg" style="flex:none;width:118px"><b style="background:var(--slate)">${n(numbers.holdsDeclined)}</b><span>you said no</span></div>
        </div>
      </div>

      <div class="panel rules">
        <div class="big">${n(numbers.ruleSteers)}</div>
        <div class="txt">times the agent was told which<br>project rule it broke, over ${n(numbers.rulesDistinct)} rules.</div>
      </div>
    </div>
  </div>

  <div class="panel strip">
    <div class="row"><span class="lab">wrote</span><span class="bad">DSN = os.getenv(${esc(written)})</span></div>
    <div class="row"><span class="lab">told</span><span class="steer">${esc(ruleSteer)}</span></div>
    <div class="row"><span class="lab">next turn</span><span class="good">${esc(fixed)}</span></div>
  </div>

  <footer><span>${n(numbers.sessions)} real sessions, ${numbers.from} to ${numbers.to}</span><span>pi install npm:pi-warden</span></footer>
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
  console.error('No Chrome binary found. Pass one as the first argument or set CHROME_BIN. The HTML is at docs/hero.html.');
  process.exit(1);
}
execFileSync(chrome, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--window-size=${width},${height}`, `--screenshot=${out}`, `file://${html}`,
], { stdio: 'ignore' });
console.log(`wrote ${out}`);
