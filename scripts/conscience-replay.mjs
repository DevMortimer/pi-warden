#!/usr/bin/env node
/**
 * CAL-3: measure the conscience guard's recommendation quality on recorded Pi sessions.
 *
 * Every operator prompt in the corpus is replayed through assess() with the real judge and a
 * fake policy that never gates. The agent's actual first usage after the prompt labels the turn:
 * precision and recall of the recommendation against that usage, disposition accuracy against
 * whether any tool was called, and the unnecessary-suggestion rate on prompts where nothing was
 * used.
 *
 * Billable and explicit: run it on purpose. --dry-run prints the estimate; a run above 2000
 * requests needs --yes. --max-requests N caps the run even with --yes. Output is owner-only
 * under .local/calibration/ and never committed.
 *
 *   node scripts/conscience-replay.mjs --dry-run              # counts and estimate
 *   node scripts/conscience-replay.mjs --project . --yes      # sessions of one project
 *   node scripts/conscience-replay.mjs --dir PATH             # explicit session directory
 *   node scripts/conscience-replay.mjs --report FILE          # recompute from a finished run
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createTypeSafe, DEFAULT_USD_PER_MTOK } from 'pi-typesafe';
import { auc, calibrate, defaultThresholds, formatCalibration, metricsAt } from 'pi-typesafe/calibrate';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { assess, eligibleCandidates, questionHash } from '../dist/conscience.js';
import { redact } from '../dist/redact.js';
import { defaultConfig } from '../dist/config.js';

// ── CLI flags ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };

const indexDir = value('index');
const labelsFile = value('labels');
const sessionsRoot = join(homedir(), '.pi', 'agent', 'sessions');
const concurrency = Number(value('concurrency', 6));
const budgetOf = argv => (argv.includes('--max-requests')
  ? { cap: Number(argv[argv.indexOf('--max-requests') + 1]), explicit: true }
  : { cap: argv.includes('--yes') ? Number.POSITIVE_INFINITY : 2000, explicit: false });
const { cap: maxRequests, explicit: explicitCap } = budgetOf(args);
const timeoutMs = Number(value('timeout', 20000));
const outDir = resolve('.local', 'calibration');
const TOKENS_PER_REQUEST = 4000; // skill+tool catalogs are larger than action replay payloads

// ── Session parsing (adapted from calibrate-action.mjs) ─────────────

const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p && p.type === 'text').map(p => p.text ?? '').join('\n') : '';
const clip = (v, limit) => (v.length <= limit ? v : `${v.slice(0, limit)}…`);

async function readBranch(path) {
  const entries = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { /* torn */ } }
  const header = entries.find(e => e.type === 'session');
  const byId = new Map(entries.filter(e => e.id).map(e => [e.id, e]));
  let leaf = entries.filter(e => e.id).at(-1);
  const chain = [];
  while (leaf) { chain.push(leaf); leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined; }
  return { header, branch: chain.reverse() };
}

function turnsOf(session, branch) {
  const results = new Map();
  for (const e of branch) if (e.type === 'message' && e.message.role === 'toolResult') results.set(e.message.toolCallId, e.message);
  const turns = [];
  const history = [];
  let current;
  for (const e of branch) {
    if (e.type !== 'message') continue;
    const msg = e.message;
    if (msg.role === 'user') {
      const prompt = text(msg.content).trim();
      if (current) { current.next = prompt; turns.push(current); }
      current = {
        session: session.id, cwd: session.cwd, file: session.file,
        index: turns.length, prompt, at: msg.timestamp,
        context: history.slice(-8),
        toolCalls: [], skillReads: [], skillExpansions: [], allToolNames: new Set(),
      };
      if (prompt) history.push({ role: 'user', text: prompt });
      continue;
    }
    if (msg.role === 'assistant' && current) {
      const said = text(msg.content).trim();
      if (said) history.push({ role: 'assistant', text: said });
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'toolCall') {
            current.allToolNames.add(part.name);
            const result = results.get(part.id);
            const resultText = result ? text(result.content) : '';
            current.toolCalls.push({ id: part.id, name: part.name, input: part.arguments ?? {}, resultText });
          }
        }
      }
    }
  }
  if (current && current.prompt) { current.next = '(end of session)'; turns.push(current); }
  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      if (tc.name === 'read') {
        const path = tc.input.path ?? tc.input.file ?? '';
        if (/SKILL\.md|\/skills\//i.test(path)) {
          turn.skillReads.push({ path, resultText: tc.resultText });
        }
      }
    }
    const skillMatch = turn.prompt.match(/\/skill:(\S+)/);
    if (skillMatch) turn.skillExpansions.push(skillMatch[1]);
  }
  return turns.filter(t => t.prompt);
}

async function loadTurns(paths) {
  const turns = [];
  for (const path of paths) {
    const { header, branch } = await readBranch(path);
    if (!header) continue;
    const session = { id: header.id ?? basename(path, '.jsonl'), cwd: header.cwd ?? process.cwd(), file: path };
    for (const turn of turnsOf(session, branch)) turns.push(turn);
  }
  return turns;
}

async function sessionFiles(projectDirs, maxSessions) {
  const files = [];
  for (const dir of projectDirs) {
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) if (name.endsWith('.jsonl')) files.push(join(dir, name));
  }
  files.sort();
  if (maxSessions && files.length > maxSessions) {
    // Sort by mtime descending, take newest maxSessions, then re-sort by name for stable order
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const kept = files.slice(0, maxSessions).sort();
    return kept;
  }
  return files;
}

function projectSessionDirs(projectValue) {
  if (flag('all')) {
    return readdirSync(sessionsRoot).filter(n => statSync(join(sessionsRoot, n)).isDirectory()).map(n => join(sessionsRoot, n));
  }
  if (value('dir')) return [resolve(value('dir'))];
  const project = resolve(projectValue);
  const dir = join(sessionsRoot, `--${project.replace(/^\//, '').replace(/[\\/]/g, '-')}--`);
  return [dir];
}

// ── Skill catalog discovery ──────────────────────────────────────────

function discoverSkills() {
  const dirs = [
    { dir: join(homedir(), '.pi', 'agent', 'skills'), source: 'user' },
    { dir: join(homedir(), '.agents', 'skills'), source: 'user-agents' },
  ];
  const subagentsSkills = join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents', 'skills');
  if (existsSync(subagentsSkills)) dirs.push({ dir: subagentsSkills, source: 'pi-subagents' });
  let all = [];
  for (const d of dirs) {
    try { all.push(...loadSkillsFromDir(d).skills); } catch { /* skip */ }
  }
  return all;
}

// ── Tool catalog from session ─────────────────────────────────────────

/** Sessions record tool calls, not the full available set; this is the best proxy we have. */
const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write'];

function toolsFromSession(turns) {
  const names = new Set(BUILTIN_TOOLS);
  for (const turn of turns) for (const name of turn.allToolNames) names.add(name);
  return [...names].map(name => ({
    name,
    description: `Tool: ${name}`,
  }));
}

// ── Index loading ───────────────────────────────────────────────────

function loadIndex(dir) {
  if (!dir) return undefined;
  const globalPath = join(dir, 'global.json');
  if (!existsSync(globalPath)) { console.warn(`Index global.json not found at ${globalPath}`); return undefined; }
  const globalIndex = JSON.parse(readFileSync(globalPath, 'utf8'));
  const projectsDir = join(dir, 'projects');
  let projectIndex;
  if (existsSync(projectsDir)) {
    const projectFiles = readdirSync(projectsDir).filter(n => n.endsWith('.json'));
    if (projectFiles.length > 0) {
      // Merge all project index files into one
      const allEntries = [];
      for (const pf of projectFiles) {
        const data = JSON.parse(readFileSync(join(projectsDir, pf), 'utf8'));
        if (data.entries) allEntries.push(...data.entries);
      }
      projectIndex = { entries: allEntries };
    }
  }
  const toolEntries = globalIndex.entries.filter(e => e.kind === 'tool');
  const toolCatalog = toolEntries.map(e => ({ name: e.name, description: e.lead ?? e.name }));
  console.log(`  Index loaded: ${globalIndex.entries.length} entries (${toolEntries.length} tools, ${globalIndex.entries.length - toolEntries.length} skills)${projectIndex ? `, ${projectIndex.entries.length} project entries` : ''}`);
  return { globalIndex, projectIndex, toolCatalog };
}

function toolsFromIndex(dir) {
  const result = loadIndex(dir);
  return result ? result.toolCatalog : toolsFromSession([]);
}

// ── Labels ───────────────────────────────────────────────────────────

function detectFirstUsage(turn) {
  if (turn.skillExpansions.length > 0) {
    return { kind: 'skill', id: turn.skillExpansions[0] };
  }
  for (const tc of turn.toolCalls) {
    if (tc.name === 'read') {
      const path = tc.input.path ?? tc.input.file ?? '';
      if (/SKILL\.md|\/skills\//i.test(path)) {
        const match = path.match(/skills\/([^/]+)\/SKILL\.md/i) ?? path.match(/skills\/([^/]+)\.md/i);
        return { kind: 'skill', id: match ? match[1] : path };
      }
    }
    return { kind: 'tool', id: tc.name };
  }
  return { kind: null, id: null };
}

function anyToolCalled(turn) {
  return turn.toolCalls.length > 0;
}

// ── Assessment ───────────────────────────────────────────────────────

function fakeConfig() {
  const base = defaultConfig().conscience;
  return { ...base, recommendThreshold: 0, loadThreshold: 0 };
}

async function runAssessment(turn, skills, toolCatalog, judge, indexes) {
  const activeSkills = skills.filter(s => !s.disableModelInvocation).map(s => s.name);
  const suppliedSkills = turn.skillExpansions;
  const recentContext = turn.context.map(m => `${m.role}: ${clip(m.text, 500)}`).join('\n');

  return assess(
    clip(redact(turn.prompt), 2000),
    recentContext,
    skills,
    toolCatalog,
    activeSkills,
    suppliedSkills,
    { judge, config: fakeConfig(), sharedTimeoutMs: timeoutMs, now: () => Date.now(), ...(indexes ?? {}) },
  );
}

// ── Pool helper ──────────────────────────────────────────────────────

async function pool(items, limit, work) {
  let index = 0; let done = 0;
  const started = Date.now();
  const tick = () => { done++; if (done % 50 === 0) process.stderr.write(`  ${done}/${items.length} (${Math.round((Date.now() - started) / 1000)} s)\n`); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) { const item = items[index++]; await work(item); tick(); }
  }));
}

// ── Report ───────────────────────────────────────────────────────────

const pct = v => `${(v * 100).toFixed(0)}%`;
const fixed = v => (v === undefined ? '-' : v.toFixed(2));

function report(records, skipped = 0, ownerLabels) {
  const turns = records.filter(r => r.kind === 'turn');
  const lines = [];
  const out = line => { lines.push(line); console.log(line); };

  out(`\n# Conscience recommendation calibration on recorded sessions`);
  if (skipped) out(`!! PARTIAL: the request budget stopped the run with ${skipped} assessments never made.`);
  if (ownerLabels) out(`Labelled subset: ${ownerLabels.size} prompts.`);
  out(`${turns.length} labelled turns (${turns.filter(t => t.error).length} errors).`);

  const withTool = turns.filter(t => t.anyTool);
  const withSkill = turns.filter(t => t.firstUsage?.kind === 'skill');
  const withToolOnly = turns.filter(t => t.firstUsage?.kind === 'tool');
  const noUsage = turns.filter(t => !t.anyTool);
  const selected = turns.filter(t => t.selected);
  out(`\n## Label distribution`);
  out(`  any tool called: ${withTool.length} (${pct(withTool.length / Math.max(1, turns.length))})`);
  out(`  skill used first: ${withSkill.length} (${pct(withSkill.length / Math.max(1, turns.length))})`);
  out(`  tool used first (not skill): ${withToolOnly.length} (${pct(withToolOnly.length / Math.max(1, turns.length))})`);
  out(`  no tool/skill used: ${noUsage.length} (${pct(noUsage.length / Math.max(1, turns.length))})`);
  out(`  conscience selected a candidate: ${selected.length} (${pct(selected.length / Math.max(1, turns.length))})`);

  out(`\n## Disposition accuracy (advance vs no_gap against any-tool label)`);
  const dispCorrect = turns.filter(t => (t.disposition === 'advance') === t.anyTool).length;
  out(`  accuracy: ${dispCorrect}/${turns.length} (${pct(dispCorrect / Math.max(1, turns.length))})`);

  out(`\n## Recommendation: precision/recall vs any-usage (threshold sweep)`);
  out(`  threshold | selected | precision | recall | unnecessary (no-usage FP)`);
  for (const t of [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]) {
    const predictedPositive = turns.filter(r => r.disposition === 'advance' && r.usefulness >= t && r.pAdvance >= t);
    const tp = predictedPositive.filter(r => r.anyTool).length;
    const fp = predictedPositive.filter(r => !r.anyTool).length;
    const fn = turns.filter(r => r.anyTool).length - tp;
    const precision = tp + fp > 0 ? tp / (tp + fp) : undefined;
    const recall = tp + fn > 0 ? tp / (tp + fn) : undefined;
    const unnecessary = predictedPositive.filter(r => !r.anyTool).length;
    out(`  ${t.toFixed(2)}     | ${String(predictedPositive.length).padStart(8)} | ${precision === undefined ? '     - ' : pct(precision).padStart(8)} | ${recall === undefined ? '     - ' : pct(recall).padStart(7)} | ${unnecessary} (${pct(unnecessary / Math.max(1, noUsage.length))})`);
  }

  out(`\n## Skill recommendation: precision/recall vs skill-used-first`);
  out(`  threshold | selected-skill | precision | recall`);
  for (const t of [0.50, 0.60, 0.70, 0.80, 0.90]) {
    const predictedSkill = turns.filter(r => r.disposition === 'advance' && r.selectedKind === 'skill' && r.usefulness >= t && r.pAdvance >= t);
    const tp = predictedSkill.filter(r => r.firstUsage?.kind === 'skill').length;
    const fp = predictedSkill.filter(r => r.firstUsage?.kind !== 'skill').length;
    const fn = withSkill.length - tp;
    const precision = tp + fp > 0 ? tp / (tp + fp) : undefined;
    const recall = tp + fn > 0 ? tp / (tp + fn) : undefined;
    out(`  ${t.toFixed(2)}     | ${String(predictedSkill.length).padStart(14)} | ${precision === undefined ? '     - ' : pct(precision).padStart(8)} | ${recall === undefined ? '     - ' : pct(recall).padStart(7)}`);
  }

  const unnecessarySelected = selected.filter(r => !r.anyTool);
  out(`\n## Unnecessary-suggestion rate`);
  out(`  selected on no-usage turns: ${unnecessarySelected.length}/${noUsage.length} (${pct(unnecessarySelected.length / Math.max(1, noUsage.length))})`);

  const scored = turns.map(r => ({ label: r.anyTool, score: r.pAdvance }));
  out(`\n## AUC: P(advance) against any-tool label: ${fixed(auc(scored))}`);

  if (withSkill.length > 0) {
    const skillScored = turns.map(r => ({ label: r.firstUsage?.kind === 'skill', score: r.usefulness }));
    out(`  AUC: usefulness against skill-used-first: ${fixed(auc(skillScored))}`);
  }

  for (const [name, fn] of [
    ['P(advance)', r => r.pAdvance],
    ['usefulness', r => r.usefulness],
  ]) {
    const samples = turns.map(r => ({ label: r.anyTool, score: fn(r), id: `${r.session}#${r.index}` }));
    out(`\n${formatCalibration(calibrate(name, samples, { minPrecision: 0.7, minRecall: 0.5 }))}`);
  }

  const byProject = new Map();
  for (const r of turns) {
    const proj = basename(r.cwd);
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(r);
  }
  if (byProject.size > 1) {
    out(`\n## Per-project`);
    for (const [proj, projTurns] of byProject) {
      const sel = projTurns.filter(r => r.selected);
      const tool = projTurns.filter(r => r.anyTool);
      const precTurns = sel.filter(r => r.anyTool);
      out(`  ${proj.padEnd(30)} turns ${String(projTurns.length).padStart(5)}  selected ${String(sel.length).padStart(5)}  tools ${String(tool.length).padStart(5)}  precision ${precTurns.length}/${sel.length} (${pct(precTurns.length / Math.max(1, sel.length))})`);
    }
  }

  out(`\n## Per candidate kind`);
  for (const kind of ['skill', 'tool']) {
    const sel = turns.filter(r => r.selectedKind === kind);
    const tp = sel.filter(r => kind === 'skill' ? r.firstUsage?.kind === 'skill' : r.firstUsage?.kind === 'tool');
    out(`  ${kind.padEnd(8)} selected ${String(sel.length).padStart(5)}  matched ${tp.length}  precision ${tp.length}/${sel.length} (${pct(tp.length / Math.max(1, sel.length))})`);
  }

  if (selected.length) {
    out(`\n## Selected candidates (first 25)`);
    for (const r of selected.slice(0, 25)) {
      const label = r.firstUsage ? `${r.firstUsage.kind}:${r.firstUsage.id}` : 'none';
      out(`  ${r.selectedId?.padEnd(30)} P=${r.usefulness.toFixed(2)} disp=${r.disposition} label=${label} | ${clip(r.prompt, 100)}`);
    }
  }

  // Labelled-subset comparison when owner labels are provided
  if (ownerLabels && ownerLabels.size > 0) {
    const labelled = turns.filter(t => ownerLabels.has(`${t.session}#${t.index}`));
    const labelledNoErr = labelled.filter(t => !t.error);
    out(`\n## Labelled-subset comparison (owner labels)`);
    out(`  ${labelled.length} rows, ${labelledNoErr.length} scored (${labelled.length - labelledNoErr.length} errors).`);

    const ownerY = labelled.filter(t => ownerLabels.get(`${t.session}#${t.index}`).helpful === 'y');
    const ownerN = labelled.filter(t => ownerLabels.get(`${t.session}#${t.index}`).helpful === 'n');
    const ownerUnpicked = labelled.filter(t => {
      const h = ownerLabels.get(`${t.session}#${t.index}`).helpful;
      return h !== 'y' && h !== 'n';
    });
    out(`  Owner labels: ${ownerY.length} y, ${ownerN.length} n, ${ownerUnpicked.length} unpicked.`);

    // At various thresholds: how many y-picks survive, how many n-picks are no longer picked or below threshold
    out(`\n  threshold | y-picks survive | n-picks rescued | new picks on unpicked`);
    const allKeys = new Set([...labelled.map(t => `${t.session}#${t.index}`), ...[...ownerLabels.keys()]]);
    for (const t of [0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95]) {
      const selectedNow = new Set(labelledNoErr.filter(r => r.disposition === 'advance' && r.usefulness >= t && r.pAdvance >= t).map(r => `${r.session}#${r.index}`));
      const ySurvive = ownerY.filter(r => selectedNow.has(`${r.session}#${r.index}`)).length;
      const nRescued = ownerN.filter(r => !selectedNow.has(`${r.session}#${r.index}`)).length;
      // New picks: labelled rows not in ownerY that are now selected
      const newPicks = labelledNoErr.filter(r => {
        const key = `${r.session}#${r.index}`;
        const label = ownerLabels.get(key);
        return label && label.helpful !== 'y' && label.helpful !== 'n' && selectedNow.has(key);
      }).length;
      out(`  ${t.toFixed(2)}     | ${String(ySurvive).padStart(14)} | ${String(nRescued).padStart(14)} | ${String(newPicks).padStart(18)}`);
    }

    // Disposition on status-update prompts
    const statusKeys = labelled.filter(t => {
      const label = ownerLabels.get(`${t.session}#${t.index}`);
      return label && (label.agentDidFirst === '' || label.agentDidFirst === ' ');
    });
    if (statusKeys.length > 0) {
      const noGap = statusKeys.filter(t => t.disposition === 'no_gap').length;
      out(`\n  Status-update prompts (${statusKeys.length}): ${noGap} no_gap (${pct(noGap / statusKeys.length)}), ${statusKeys.length - noGap} other.`);
    }

    // Precision at the gate threshold (on labelled picks only: y and n)
    const labelledPicks = labelledNoErr.filter(t => {
      const h = ownerLabels.get(`${t.session}#${t.index}`).helpful;
      return h === 'y' || h === 'n';
    });
    for (const t of [0.80, 0.85, 0.90, 0.95]) {
      const predicted = labelledPicks.filter(r => r.disposition === 'advance' && r.usefulness >= t && r.pAdvance >= t);
      const tp = predicted.filter(r => {
        const label = ownerLabels.get(`${r.session}#${r.index}`);
        return label && label.helpful === 'y';
      }).length;
      const fp = predicted.filter(r => {
        const label = ownerLabels.get(`${r.session}#${r.index}`);
        return label && label.helpful === 'n';
      }).length;
      const prec = tp + fp > 0 ? tp / (tp + fp) : undefined;
      out(`  P(useful) ≥ ${t.toFixed(2)}: precision ${tp}/${tp + fp} (${prec === undefined ? '-' : pct(prec)}), n=${predicted.length}`);
    }

    // Candidate policy candidate (on labelled picks only)
    let bestThreshold;
    let bestPrecision;
    for (const t of [0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55, 0.50]) {
      const predicted = labelledPicks.filter(r => r.disposition === 'advance' && r.usefulness >= t && r.pAdvance >= t);
      if (predicted.length < 10) continue;
      const tp = predicted.filter(r => {
        const label = ownerLabels.get(`${r.session}#${r.index}`);
        return label && label.helpful === 'y';
      }).length;
      const fp = predicted.filter(r => {
        const label = ownerLabels.get(`${r.session}#${r.index}`);
        return label && label.helpful === 'n';
      }).length;
      const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
      if (prec >= 0.95 || !bestThreshold) {
        bestThreshold = t;
        bestPrecision = prec;
        if (prec >= 0.95) break;
      }
    }
    if (bestThreshold !== undefined) {
      const qHash = labelledNoErr[0]?.questionHash ?? 'unknown';
      out(`\n  Candidate policy: threshold=${bestThreshold.toFixed(2)}, precision=${pct(bestPrecision)}, n≥10 gate met=${bestPrecision >= 0.95}`);
      out(`  questionHash=${qHash}`);
    }
  }

  const reportPath = join(outDir, skipped ? 'conscience-report-partial.md' : 'conscience-report-latest.md');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`\nReport written to ${reportPath}`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function run() {
  const reportFile = value('report');
  const outFile = value('resume') ?? reportFile ?? join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-conscience.jsonl`);
  const existing = existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  if (reportFile) { report(existing); return; }

  const projectValue = value('project', '.');
  const projectDirs = projectSessionDirs(projectValue);
  const maxSessions = value('max-sessions') ? Number(value('max-sessions')) : undefined;
  const files = await sessionFiles(projectDirs, maxSessions);
  const limitN = value('limit') ? Number(value('limit')) : undefined;

  console.log('Loading skill catalog...');
  const skills = discoverSkills();
  console.log(`  ${skills.length} skills discovered (${skills.filter(s => !s.disableModelInvocation).length} eligible, ${skills.filter(s => s.disableModelInvocation).length} user-only)`);

  const allTurns = await loadTurns(files);
  const turns = limitN ? allTurns.slice(0, limitN) : allTurns;
  console.log(`${files.length} session files, ${turns.length} turns${limitN ? ` (limited to ${limitN})` : ''}`);

  for (const turn of turns) {
    turn.firstUsage = detectFirstUsage(turn);
    turn.anyTool = anyToolCalled(turn);
  }

  const withTool = turns.filter(t => t.anyTool).length;
  const withSkill = turns.filter(t => t.firstUsage?.kind === 'skill').length;
  console.log(`Labels: ${withTool} with tool calls (${withSkill} skill-first), ${turns.length - withTool} without.`);

  // Load owner labels (--labels) for the labelled-subset measurement
  let ownerLabels;
  if (labelsFile) {
    ownerLabels = new Map();
    const tsv = readFileSync(resolve(labelsFile), 'utf8');
    for (const line of tsv.split('\n').slice(1)) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length >= 7) {
        ownerLabels.set(cols[0], {
          recommendedSkill: cols[3],
          pUseful: Number(cols[4]),
          agentDidFirst: cols[5],
          helpful: cols[6].trim(),
        });
      }
    }
    const yCount = [...ownerLabels.values()].filter(v => v.helpful === 'y').length;
    const nCount = [...ownerLabels.values()].filter(v => v.helpful === 'n').length;
    const emptyCount = ownerLabels.size - yCount - nCount;
    console.log(`Owner labels loaded: ${ownerLabels.size} rows (${yCount} y, ${nCount} n, ${emptyCount} unpicked).`);
  }

  // Filter turns to labelled subset when --labels is set
  let activeTurns = turns;
  if (ownerLabels) {
    activeTurns = turns.filter(t => ownerLabels.has(`${t.session}#${t.index}`));
    console.log(`Filtered to ${activeTurns.length} turns matching owner labels.`);
  }

  // Load index (--index) for the full tool catalog and candidate metadata
  let indexes;
  let toolCatalog;
  if (indexDir) {
    const loaded = loadIndex(resolve(indexDir));
    if (loaded) {
      indexes = { globalIndex: loaded.globalIndex, projectIndex: loaded.projectIndex };
      toolCatalog = loaded.toolCatalog;
    }
  }
  // toolCatalog remains undefined when no index; pool uses per-session catalogs in that case

  const doneKeys = new Set(existing.map(r => r.key));
  const pending = activeTurns.filter(t => !doneKeys.has(`${t.session}#${t.index}`));
  const planned = pending.length;
  console.log(`Requests: ${planned} still to make (${existing.length} done); roughly ${(planned * TOKENS_PER_REQUEST / 1e6).toFixed(1)}M input tokens, about $${(planned * TOKENS_PER_REQUEST / 1e6 * DEFAULT_USD_PER_MTOK).toFixed(2)} at $${DEFAULT_USD_PER_MTOK}/MTok.`);

  if (flag('dry-run')) return;
  if (planned > maxRequests && !flag('yes')) {
    console.log(`That is more than --max-requests ${maxRequests}. Add --yes to spend it.`);
    return;
  }
  if (explicitCap && planned > maxRequests) console.log(`--max-requests ${maxRequests} is below the ${planned} needed: the run stops early.`);

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (!existsSync(outFile)) writeFileSync(outFile, '', { mode: 0o600 });
  const append = record => appendFileSync(outFile, `${JSON.stringify(record)}\n`);
  const judge = createTypeSafe({ maxRequests: Number.MAX_SAFE_INTEGER, timeoutMs });
  let requests = 0;
  let skipped = 0;
  const budgetLeft = () => requests < maxRequests;

  // Per-session tool catalogs for non-index mode
  const sessionToolCats2 = new Map();
  if (!indexes) {
    for (const turn of activeTurns) {
      if (!sessionToolCats2.has(turn.file)) {
        sessionToolCats2.set(turn.file, toolsFromSession(activeTurns.filter(t => t.file === turn.file)));
      }
    }
  }

  console.log('# assessments');
  await pool(pending, concurrency, async turn => {
    if (!budgetLeft()) { skipped++; return; }
    const key = `${turn.session}#${turn.index}`;
    const turnToolCatalog = indexes ? toolCatalog : (sessionToolCats2.get(turn.file) ?? []);
    const base = {
      kind: 'turn', key, session: turn.session, cwd: turn.cwd, index: turn.index, at: turn.at,
      prompt: clip(redact(turn.prompt), 200),
      firstUsage: turn.firstUsage, anyTool: turn.anyTool,
    };
    try {
      requests++;
      const result = await runAssessment(turn, skills, turnToolCatalog, judge, indexes);
      const selectedName = result.selected ? `${result.selected.kind}:${result.selected.id}` : null;
      append({
        ...base,
        disposition: result.disposition,
        selected: selectedName,
        selectedKind: result.selected?.kind ?? null,
        selectedId: result.selected?.id ?? null,
        usefulness: result.usefulness,
        pAdvance: result.pAdvance,
        questionHash: result.questionHash,
        elapsedMs: result.elapsedMs,
        requestCount: result.requestCount,
        skipReason: result.skipReason,
      });
    } catch (err) {
      append({ ...base, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const spend = judge.getSpend();
  if (skipped) console.log(`!! PARTIAL: --max-requests ${maxRequests} stopped the run with ${skipped} assessments skipped.`);
  console.log(`${requests} requests. Session: ${spend.session.requestsStarted} started, ${spend.session.requestsSucceeded} ok, ${spend.session.inputTokens} input tokens, about $${spend.session.estimatedUsd.toFixed(2)}.`);
  report(readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)), skipped, ownerLabels);
}

run().catch(error => { console.error(error); process.exit(1); });
