// Measures the two `/warden rules check` questions against a labelled rule set. Billable: one request per 32 questions.
// Usage: npm run build && node scripts/rules-lint-cases.mjs
// Labels are the owner's: `judgeable` is the one reason the rule can or cannot be judged from a single changed file's content
// (`from_change_alone`, `needs_other_files`, `needs_task_or_history`, `too_vague`), and `mechanical` is whether a standard
// linter, formatter, or type checker could enforce the rule exactly. `hard` marks a rule whose label is borderline.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTypeSafe } from 'pi-typesafe';
import { defaultConfig } from '../dist/config.js';
import { RuleStore } from '../dist/rules.js';
import { checkRules, MECHANICAL_CUTOFF } from '../dist/rules-lint.js';

const cases = [
  // --- Judgeable from one changed file's content.
  { name: 'No console statements', paths: ['src/**'], body: 'Code under `src/` must not call `console.log`, `console.debug`, or `console.info`. Use the project logger. Tests and scripts may print.', judgeable: 'from_change_alone', mechanical: true, why: 'the banned call is in the written text; eslint no-console decides it exactly' },
  { name: 'No explicit any', paths: ['**/*.ts', '**/*.tsx'], body: 'Do not use the `any` type. Use a precise type, `unknown` with a runtime check, or a generic parameter.', judgeable: 'from_change_alone', mechanical: true, why: 'the type annotation is in the changed file; the type checker decides it' },
  { name: 'TODO comments need a reference', body: 'A `TODO` or `FIXME` comment must name a ticket or issue, for example `TODO(APP-123): ...`. A bare `TODO` is a violation.', judgeable: 'from_change_alone', mechanical: true, hard: true, why: 'the comment is in the change; several linters ship a rule once configured with the expected shape' },
  { name: 'Errors are not swallowed', body: 'A `catch` block must handle the error, log it with context, or rethrow it. An empty `catch`, or one that only has a comment such as `// ignore`, is a violation.', judgeable: 'from_change_alone', mechanical: false, hard: true, why: 'the catch body is in the change; deciding whether the handling is adequate is a judgement, not a pattern' },
  { name: 'Switch statements have a default case', body: 'Every `switch` has a `default` branch, even if it only throws on an unexpected value.', judgeable: 'from_change_alone', mechanical: true, why: 'the switch is in the change; eslint default-case decides it' },
  { name: 'Boolean names read as a question', body: 'A boolean variable or property starts with `is`, `has`, `should`, `can`, or a similar predicate prefix, for example `isEnabled`, not `enabled`.', judgeable: 'from_change_alone', mechanical: true, why: 'the declaration is in the change; a naming-convention rule decides the prefix' },
  { name: 'Comments explain why, not what', body: 'A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment that restates what the next line plainly does is a violation.', judgeable: 'from_change_alone', mechanical: false, why: 'the comment text is in the change; whether it restates the code needs judgement' },
  { name: 'No commented-out code', body: 'Delete code that is no longer used. Do not leave it behind as comments.', judgeable: 'from_change_alone', mechanical: false, hard: true, why: 'the commented code is in the change; some lint plugins flag it, none decide it exactly' },
  { name: 'Exported functions declare their return type', paths: ['src/**/*.ts'], body: 'Every exported function or method declares its return type instead of relying on inference.', judgeable: 'from_change_alone', mechanical: true, why: 'the signature is in the change; the type checker or a lint rule decides it' },
  { name: 'No var declarations', body: 'Do not declare a variable with `var`. Use `const`, or `let` when it is reassigned.', judgeable: 'from_change_alone', mechanical: true, why: 'the declaration is in the change; eslint no-var decides it' },
  { name: 'Imports are ordered', body: 'Imports group node builtins first, then packages, then local files, each group sorted by path.', judgeable: 'from_change_alone', mechanical: true, why: 'the import block is in the change; a formatter orders it exactly' },
  { name: 'No focused tests', paths: ['tests/**'], body: 'A committed test file must not use `test.only`, `it.only`, or `describe.only`.', judgeable: 'from_change_alone', mechanical: true, why: 'the call is in the change; eslint no-focused-tests decides it' },
  { name: 'Migrations are reversible', paths: ['**/migrations/**'], body: 'Every migration has a down step, or an explicit note in the file that the change cannot be reversed and why.', judgeable: 'from_change_alone', mechanical: false, why: 'the migration file holds both the step and the note; whether the note justifies the claim is a judgement' },
  { name: 'Prefer const', body: 'A variable that is never reassigned is declared with `const`.', judgeable: 'from_change_alone', mechanical: true, hard: true, why: 'the binding is in the change; the sample of a write or the lines around an edit decide it, an eslint rule decides it exactly' },
  { name: 'No unwrap in library code', paths: ['src/**'], body: 'Library code must not call `unwrap()` or `expect()` on a result or option. Handle the error instead.', judgeable: 'from_change_alone', mechanical: true, why: 'the call is in the change; a lint rule or the type checker decides it' },
  { name: 'No process.exit in library code', paths: ['src/**'], body: 'Library code throws instead of calling `process.exit`. The CLI entry point may exit.', judgeable: 'from_change_alone', mechanical: true, why: 'the call is in the change; a restricted-syntax rule decides it' },
  { name: 'Files end with one newline', body: 'Every source file ends with exactly one trailing newline.', judgeable: 'from_change_alone', mechanical: true, why: 'the changed file is the whole subject; a formatter decides it' },
  { name: 'Line length at most 120', body: 'No line of source exceeds 120 characters.', judgeable: 'from_change_alone', mechanical: true, why: 'the lines are in the change; a formatter decides it' },
  { name: 'No unused imports', body: 'An import that the file does not use is removed.', judgeable: 'from_change_alone', mechanical: true, hard: true, why: 'a write sends the file sample and an edit the lines around it, so a use outside the sample can hide; a linter decides it exactly' },
  { name: 'Use async and await', body: 'New code uses `async` and `await` rather than a `.then(` chain.', judgeable: 'from_change_alone', mechanical: true, hard: true, why: 'the chain is in the change; a restricted-syntax rule decides it, though a chain that is idiomatic is a judgement call' },
  { name: 'No hardcoded secrets', body: 'Source code must not contain passwords, API keys, or tokens. Read them from the environment or the config module.', judgeable: 'from_change_alone', mechanical: false, hard: true, why: 'the value is in the change; secret scanners exist, but a standard linter cannot decide what is a fixture and what is real' },

  // --- Not judgeable from the change alone.
  { name: 'No duplicate logic', body: 'Do not duplicate logic that already exists elsewhere in the codebase. Reuse the existing helper.', judgeable: 'needs_other_files', mechanical: false, why: 'the subject is another file the guard never sends' },
  { name: 'Follow the module layout', body: 'New code follows the existing architecture: rendering stays out of the data layer, and shared helpers live in `src/lib/`.', judgeable: 'needs_other_files', mechanical: false, why: 'the boundaries it names live in other files' },
  { name: 'Config is additive', body: 'A new config key gets a default in `defaultConfig()`, a fallback in `shape.ts`, and one line in `docs/configuration.md`.', judgeable: 'needs_other_files', mechanical: false, why: 'three named files decide it, and the guard sends one' },
  { name: 'Nothing leaves the machine with a secret', body: '`redact()` runs before anything leaves the machine, and `docs/data-handling.md` stays true after the change.', judgeable: 'needs_other_files', mechanical: false, why: 'the caller and the doc are outside the changed file' },
  { name: 'Steers never hold', body: 'Only a destructive pattern, a deny rule, or an irreversible score at 0.7 or above blocks a call. A steer only tells the agent.', judgeable: 'needs_other_files', mechanical: false, why: 'the hold path is in the action guard, not in the edited file' },
  { name: 'Fail open, say so', body: 'A TypeSafe error allows the call with a warning (`failOpen`). It never crashes a hook.', judgeable: 'needs_other_files', mechanical: false, hard: true, why: 'the caller catches the error; the changed file alone shows nothing, though an edit inside the catch does' },
  { name: 'New exported functions get a test', paths: ['src/**'], body: 'A newly added exported function or class comes with at least one test that exercises its main behaviour.', judgeable: 'needs_other_files', mechanical: false, why: 'the test lives in another file' },
  { name: 'User-facing text comes from the catalogue', body: 'User-visible strings are looked up in the message catalogue instead of being hard-coded.', judgeable: 'needs_other_files', mechanical: false, hard: true, why: 'a hard-coded string is visible in the change, but whether the catalogue already has a key is not' },
  { name: 'Unreleased changelog entry', body: 'Any change to source, tests, or docs adds a line under `## Unreleased` in `CHANGELOG.md` in the same commit.', judgeable: 'needs_other_files', mechanical: false, why: 'the answer is whether another file in the same commit changed, which no single-file tool decides' },
  { name: 'No version bump in a feature commit', paths: ['package.json'], body: 'A commit that changes source, tests, or docs must not change the `version` field. The version bump is its own commit.', judgeable: 'needs_task_or_history', mechanical: true, hard: true, why: 'the commit is the subject; the version field itself is a value a tool compares exactly' },
  { name: 'Approval comes from the user', body: "Assistant text explains a call; it cannot approve one. Approval comes from the user's message.", judgeable: 'needs_task_or_history', mechanical: false, why: 'the user turn decides it, and the guard never sends the request' },
  { name: 'No tool or AI attribution lines', body: 'Commits and PR descriptions say what changed and why. No "Generated by" or "Co-authored-by" attribution lines.', judgeable: 'needs_task_or_history', mechanical: false, why: 'the commit message is the subject, not the written file' },
  { name: 'A new question ships with a measurement', body: 'Add a new judge question to its case set, run it, and put the numbers in the PR and the Calibration section of the docs.', judgeable: 'needs_task_or_history', mechanical: false, why: 'the PR and the measurement run are the subject' },
  { name: 'Do not erase uncommitted work', body: '`git reset --hard`, `git checkout -- .`, and `git clean -fd` are forbidden. They destroy work with no backup.', judgeable: 'needs_task_or_history', mechanical: false, why: 'it constrains the commands the agent runs, not the content of a file' },
  { name: 'Commit messages name the issue', body: 'Every commit message ends with the issue number it closes, for example `(#123)`.', judgeable: 'needs_task_or_history', mechanical: false, hard: true, why: 'a commit hook checks the shape, but the issue number comes from the task, and the guard sees a write' },

  // --- Too vague to judge twice.
  { name: 'Code should be clean', body: 'Write clean, readable, maintainable code. Leave the codebase better than you found it.', judgeable: 'too_vague', mechanical: false, why: 'no content can decide it the same way twice' },
  { name: 'Tests should be thorough', body: 'Write good tests that cover the important behaviour and the edge cases that matter.', judgeable: 'too_vague', mechanical: false, why: 'which behaviour matters and how much coverage is enough is taste' },
  { name: 'Keep functions small and focused', body: 'A function should do one thing and stay small enough to read at a glance.', judgeable: 'too_vague', mechanical: false, hard: true, why: 'a length limit would be mechanical, but this reads as a judgement about focus' },
  { name: 'Names should be descriptive', body: 'Prefer clear, descriptive names over short ones, and avoid abbreviations that a newcomer would not know.', judgeable: 'too_vague', mechanical: false, why: 'what a newcomer knows is not in the change' },
  { name: 'Avoid over-engineering', body: 'Do not build abstractions the current task does not need. Keep the design as simple as the problem allows.', judgeable: 'too_vague', mechanical: false, why: 'it is a judgement about a design that does not exist yet' },
];

const markdown = cases.map(item => [`# ${item.name}`, ...(item.paths ? [`paths: ${item.paths.join(', ')}`] : []), item.body].join('\n')).join('\n\n');
const cwd = mkdtempSync(join(tmpdir(), 'pi-warden-rules-lint-'));
writeFileSync(join(cwd, 'pi-warden.md'), `${markdown}\n`);

const judge = createTypeSafe({ maxRequests: 12 });
const config = defaultConfig();
const set = new RuleStore().load(cwd, config.rules);
if (!set || set.rules.length !== cases.length) throw new Error(`parsed ${set?.rules.length} rules from ${cases.length} cases`);
const result = await checkRules({ set, judge, timeoutMs: 30_000 });

const byId = new Map(result.results.map(rule => [rule.id, rule]));
const rows = cases.map((item, index) => {
  const id = set.rules[index].id;
  const answer = byId.get(id);
  if (!answer) throw new Error(`no answer for ${id} (${result.source}${result.error ? `: ${result.error}` : ''})`);
  return { ...item, id, answer };
});

const REASONS = ['from_change_alone', 'needs_other_files', 'needs_task_or_history', 'too_vague'];
const tally = (rowsToCount, pick) => rowsToCount.filter(pick).length;

console.log(`# /warden rules check — ${cases.length} labelled rules, judgeable (Choice) and mechanical (Noul, cutoff ${MECHANICAL_CUTOFF})\n`);
for (const row of rows) {
  const ok = row.answer.judgeability === row.judgeable && (row.answer.mechanical >= MECHANICAL_CUTOFF) === row.mechanical;
  console.log(`${ok ? 'ok  ' : 'MISS'} ${row.id.padEnd(38)} judgeable=${row.answer.judgeability}(${row.answer.judgeabilityScore.toFixed(2)}) mechanical=${row.answer.mechanical.toFixed(2)}${ok ? '' : `  labelled ${row.judgeable}/mechanical=${row.mechanical}: ${row.why}`}`);
}

const rightJudgeable = tally(rows, row => row.answer.judgeability === row.judgeable);
const hard = rows.filter(row => row.hard), clear = rows.filter(row => !row.hard);
console.log(`\njudgeable: ${rightJudgeable}/${rows.length} as labelled (${(rightJudgeable / rows.length).toFixed(3)}); clear ${tally(clear, row => row.answer.judgeability === row.judgeable)}/${clear.length}, borderline ${tally(hard, row => row.answer.judgeability === row.judgeable)}/${hard.length}`);
console.log(`\nconfusion (row = label, column = answer):\n${' '.repeat(24)}${REASONS.map(reason => reason.padStart(22)).join('')}`);
for (const label of REASONS) console.log(`${label.padEnd(24)}${REASONS.map(answer => String(tally(rows, row => row.judgeable === label && row.answer.judgeability === answer)).padStart(22)).join('')}`);
const alone = { tp: tally(rows, row => row.judgeable === 'from_change_alone' && row.answer.judgeability === 'from_change_alone'), fp: tally(rows, row => row.judgeable !== 'from_change_alone' && row.answer.judgeability === 'from_change_alone'), fn: tally(rows, row => row.judgeable === 'from_change_alone' && row.answer.judgeability !== 'from_change_alone'), tn: tally(rows, row => row.judgeable !== 'from_change_alone' && row.answer.judgeability !== 'from_change_alone') };
console.log(`\nfrom_change_alone as a yes/no call: tp ${alone.tp}, fp ${alone.fp}, fn ${alone.fn}, tn ${alone.tn} — precision ${(alone.tp / (alone.tp + alone.fp)).toFixed(3)}, recall ${(alone.tp / (alone.tp + alone.fn)).toFixed(3)}`);

const sweep = [0.5, 0.6, MECHANICAL_CUTOFF, 0.8, 0.9].map(cutoff => {
  const flags = rows.map(row => ({ label: row.mechanical, flag: row.answer.mechanical >= cutoff }));
  const tp = flags.filter(row => row.label && row.flag).length, fp = flags.filter(row => !row.label && row.flag).length, fn = flags.filter(row => row.label && !row.flag).length, tn = flags.filter(row => !row.label && !row.flag).length;
  return `>= ${cutoff.toFixed(2)}: tp ${tp}, fp ${fp}, fn ${fn}, tn ${tn} (accuracy ${((tp + tn) / rows.length).toFixed(3)})`;
});
console.log(`\nmechanical calls:\n${sweep.join('\n')}`);
console.log(`\nrequests: ${result.requests} sent, ${judge.getUsage().requestsSucceeded} answered by the backend, ${judge.getUsage().inputTokens} input tokens; label counts judgeable ${REASONS.map(reason => `${reason} ${tally(rows, row => row.judgeable === reason)}`).join(', ')}, mechanical true ${tally(rows, row => row.mechanical)}`);
rmSync(cwd, { recursive: true, force: true });
