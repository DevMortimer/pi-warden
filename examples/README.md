# Get started with pi-warden

Three files, each optional. Copy what you need and edit it.

| File in this folder | Copy it to | What it does |
| --- | --- | --- |
| `pi-warden.md` | `<your project>/pi-warden.md` | Your project's rules. Each `#` heading is one rule; Jev judges every write and edit against them and tells the agent which rule it broke. |
| `pi-warden.json` | `<your project>/.pi/pi-warden.json` | Project settings: which files the rules skip, which are never sent to Jev, sensitive paths that give the agent a note, tuned thresholds. Read only when Pi trusts the project. |
| `config.json` | `~/.pi/agent/pi-warden/config.json` | Your personal settings: consent, mode, whether steers show in the transcript, the audience for reply checks, notifications. `/warden config` opens it in Pi's editor. |

## Step by step

1. Install and enable:

   ```bash
   pi install npm:pi-warden
   ```

   Then in Pi run `/warden enable`, read the notice, and paste a key from [console.typesafe.ai](https://console.typesafe.ai) if you have none stored. Without a key pi-warden still runs its offline pattern checks; the rules guard needs Jev.

2. Copy `pi-warden.md` to your project root. Delete the rules you do not want, write your own. Run `/warden status`; the `Rules:` line should say `pi-warden.md (N rules)`.

3. Ask the agent to write something that breaks a rule, for example "add a console.log to src/index.ts". The write goes through, the status line shows `warden · rules · write src/index.ts · N rules · No console output in library code 0.9x · violation`, and the agent gets the rule text as a steer. Open the trace (`ctrl+shift+w`) to read exactly what it was told.

4. Optional: copy `pi-warden.json` to `.pi/pi-warden.json` for path scoping and sensitive-path notes, and `config.json` to `~/.pi/agent/pi-warden/config.json` for your own defaults.

## Writing rules that work

- One heading, one rule. Jev answers one question per rule, so a heading that bundles three things gets one blurry answer.
- Say what a violation looks like. "A bare `TODO` without a ticket" beats "TODOs should be tidy".
- Scope with `paths:` when a rule is language-specific or does not apply to tests. Globs: `**` any depth, `*` within one segment, a pattern without a slash matches at any depth.
- Code fences inside a rule are fine; a `#` inside a fence is not read as a heading.
- Rules cost tokens: one request per write or edit, roughly 600 tokens plus about 150 per rule plus the content sample. At most 31 rules are asked per request.
- No `pi-warden.md`? pi-warden falls back to `README.md`, `CLAUDE.md`, or `AGENTS.md` and asks one question about the whole document (cut to `rules.maxChars`, headings kept). It works, but a dedicated rules file gives sharper answers and names the rule. Set `"rules": { "fallback": false }` to turn the fallback off.

## Checking the rules from the command line

```bash
node -e '
import("pi-warden").then(({ RuleStore, defaultConfig }) => {
  const set = new RuleStore().load(process.cwd(), defaultConfig().rules);
  for (const rule of set?.rules ?? []) console.log(rule.id, rule.paths.length ? rule.paths.join(",") : "(all files)");
  if (set?.dropped) console.log(`${set.dropped} rules beyond the cap are ignored`);
});'
```
