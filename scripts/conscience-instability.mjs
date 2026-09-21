#!/usr/bin/env node
/**
 * Instability test: run 30 prompts three times and report agreement.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createTypeSafe } from 'pi-typesafe';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { assess } from '../dist/conscience.js';
import { redact } from '../dist/redact.js';
import { defaultConfig } from '../dist/config.js';

const outDir = resolve('.local', 'calibration');
const combinedFile = join(outDir, 'conscience-combined.jsonl');
const timeoutMs = 20000;

function clip(v, limit) { return v.length <= limit ? v : `${v.slice(0, limit)}…`; }

function discoverSkills() {
  const dirs = [
    { dir: join(homedir(), '.pi', 'agent', 'skills'), source: 'user' },
    { dir: join(homedir(), '.agents', 'skills'), source: 'user-agents' },
  ];
  const subagentsSkills = join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents', 'skills');
  if (existsSync(subagentsSkills)) dirs.push({ dir: subagentsSkills, source: 'pi-subagents' });
  let all = [];
  for (const d of dirs) { try { all.push(...loadSkillsFromDir(d).skills); } catch {} }
  return all;
}

function fakeConfig() {
  const base = defaultConfig().conscience;
  return { ...base, recommendThreshold: 0, loadThreshold: 0 };
}

async function main() {
  const records = readFileSync(combinedFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const byProject = {};
  for (const r of records) {
    const proj = r.cwd.split('/').pop();
    if (!byProject[proj]) byProject[proj] = [];
    byProject[proj].push(r);
  }
  const selected = [];
  for (const proj of ['millia', 'pi-warden', 'pi-typesafe']) {
    const turns = byProject[proj] || [];
    const step = Math.max(1, Math.floor(turns.length / 10));
    for (let i = 0; i < turns.length && selected.length < (proj === 'pi-typesafe' ? 30 : 20); i += step) {
      selected.push(turns[i]);
    }
  }

  console.log(`Instability test: ${selected.length} prompts × 3 runs = ${selected.length * 3} requests`);

  const skills = discoverSkills();
  const toolCatalog = [
    { name: 'read', description: 'Tool: read' },
    { name: 'bash', description: 'Tool: bash' },
    { name: 'edit', description: 'Tool: edit' },
    { name: 'write', description: 'Tool: write' },
    { name: 'search_graph', description: 'Tool: search_graph' },
    { name: 'get_code_snippet', description: 'Tool: get_code_snippet' },
    { name: 'trace_path', description: 'Tool: trace_path' },
    { name: 'query_graph', description: 'Tool: query_graph' },
    { name: 'tiny_search', description: 'Tool: tiny_search' },
    { name: 'tiny_fetch', description: 'Tool: tiny_fetch' },
    { name: 'typesafe_evaluate', description: 'Tool: typesafe_evaluate' },
    { name: 'mcp__linear', description: 'Tool: mcp__linear' },
    { name: 'mcp__slack', description: 'Tool: mcp__slack' },
    { name: 'mcp', description: 'Tool: mcp' },
    { name: 'mcpScript', description: 'Tool: mcpScript' },
    { name: 'subagent', description: 'Tool: subagent' },
    { name: 'index_repository', description: 'Tool: index_repository' },
    { name: 'detect_changes', description: 'Tool: detect_changes' },
    { name: 'manage_adr', description: 'Tool: manage_adr' },
    { name: 'get_architecture', description: 'Tool: get_architecture' },
    { name: 'bg_wait', description: 'Tool: bg_wait' },
    { name: 'search_code', description: 'Tool: search_code' },
    { name: 'get_graph_schema', description: 'Tool: get_graph_schema' },
    { name: 'list_projects', description: 'Tool: list_projects' },
    { name: 'delete_project', description: 'Tool: delete_project' },
    { name: 'index_status', description: 'Tool: index_status' },
    { name: 'ingest_traces', description: 'Tool: ingest_traces' },
    { name: 'subagent_supervisor', description: 'Tool: subagent_supervisor' },
  ];
  const activeSkills = skills.filter(s => !s.disableModelInvocation).map(s => s.name);

  const judge = createTypeSafe({ maxRequests: Number.MAX_SAFE_INTEGER, timeoutMs });
  const results = [];

  for (const record of selected) {
    const runs = [];
    for (let run = 0; run < 3; run++) {
      const result = await assess(
        clip(redact(record.prompt), 2000),
        '',
        skills,
        toolCatalog,
        activeSkills,
        [],
        { judge, config: fakeConfig(), sharedTimeoutMs: timeoutMs, now: () => Date.now() },
      );
      runs.push({
        disposition: result.disposition,
        selected: result.selected ? `${result.selected.kind}:${result.selected.id}` : null,
        usefulness: result.usefulness,
        pAdvance: result.pAdvance,
      });
    }
    results.push({ key: record.key, runs });
    process.stderr.write(`  ${results.length}/${selected.length}\n`);
  }

  let dispAgree = 0, selAgree = 0, usefulAgree = 0;
  for (const r of results) {
    const d = r.runs.map(x => x.disposition);
    if (d[0] === d[1] && d[1] === d[2]) dispAgree++;
    const s = r.runs.map(x => x.selected);
    if (s[0] === s[1] && s[1] === s[2]) selAgree++;
    const u = r.runs.map(x => Math.round(x.usefulness * 10) / 10);
    if (u[0] === u[1] && u[1] === u[2]) usefulAgree++;
  }

  const n = results.length;
  console.log(`\n## Repeat instability (30 prompts × 3 runs)`);
  console.log(`  disposition agreement: ${dispAgree}/${n} (${(dispAgree/n*100).toFixed(0)}%)`);
  console.log(`  selected-candidate agreement: ${selAgree}/${n} (${(selAgree/n*100).toFixed(0)}%)`);
  console.log(`  usefulness (1dp) agreement: ${usefulAgree}/${n} (${(usefulAgree/n*100).toFixed(0)}%)`);

  const dispDisagree = results.filter(r => {
    const d = r.runs.map(x => x.disposition);
    return !(d[0] === d[1] && d[1] === d[2]);
  });
  if (dispDisagree.length) {
    console.log(`\n  Disagreements (disposition):`);
    for (const r of dispDisagree.slice(0, 10)) {
      console.log(`    ${r.key}: ${r.runs.map(x => x.disposition).join(' / ')}`);
    }
  }

  const spend = judge.getSpend();
  console.log(`\n  Requests: ${spend.session.requestsStarted}, tokens: ${spend.session.inputTokens}, cost: $${spend.session.estimatedUsd.toFixed(2)}`);

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outDir, 'conscience-instability.json'), JSON.stringify({ n, dispAgree, selAgree, usefulAgree, results }, null, 2), { mode: 0o600 });
}

main().catch(e => { console.error(e); process.exit(1); });
