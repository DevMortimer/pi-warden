/**
 * Host directory injection: `defaultHostDirs` cases, and every library path function placing its
 * result under an injected `dirs` instead of the host's agent directory.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { defaultHostDirs } from "../src/host-dirs.js";
import { loadConfig, projectConfigPath, readUserConfig, setUserSetting, userConfigPath, writeUserConfig } from "../src/config.js";
import { indexDir, indexPath } from "../src/index-cmd.js";
import { steerStatsPath } from "../src/adaptive.js";
import { holdLogPath } from "../src/holds.js";
import { loopsPath } from "../src/loops.js";
import { prefsStorePath } from "../src/prefs.js";
import { rulesLogPath } from "../src/rules-log.js";
import { legacyDataNotice } from "../src/extension.js";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

test("defaultHostDirs: unset env falls back to Pi's agent directory and .pi", () => {
  delete process.env.PI_CODING_AGENT_DIR;
  const dirs = defaultHostDirs();
  assert.equal(dirs.agentDir, join(process.env.HOME ?? "", ".pi", "agent"));
  assert.equal(dirs.configDirName, ".pi");
});

test("defaultHostDirs: explicit path wins, ~ and ~/ expand, blank falls back", () => {
  process.env.PI_CODING_AGENT_DIR = "/opt/agent";
  assert.equal(defaultHostDirs().agentDir, "/opt/agent");
  process.env.PI_CODING_AGENT_DIR = "~";
  assert.equal(defaultHostDirs().agentDir, process.env.HOME);
  process.env.PI_CODING_AGENT_DIR = "~/x";
  assert.equal(defaultHostDirs().agentDir, join(process.env.HOME ?? "", "x"));
  process.env.PI_CODING_AGENT_DIR = "  ";
  assert.equal(defaultHostDirs().agentDir, join(process.env.HOME ?? "", ".pi", "agent"), "blank is unset");
  process.env.PI_CODING_AGENT_DIR = "~/x ";
  assert.equal(defaultHostDirs().agentDir, join(process.env.HOME ?? "", "x"), "surrounding space is trimmed");
});

test("indexDir: PI_WARDEN_INDEX_DIR and PI_CODING_AGENT_DIR keep precedence over injected dirs", () => {
  process.env.PI_CODING_AGENT_DIR = "/opt/agent";
  const savedIndex = process.env.PI_WARDEN_INDEX_DIR;
  delete process.env.PI_WARDEN_INDEX_DIR;
  const dirs = { agentDir: "/custom/agent", configDirName: ".omp" };
  assert.equal(indexDir(undefined, dirs), join("/opt/agent", "pi-warden", "index"), "PI_CODING_AGENT_DIR wins over dirs");
  process.env.PI_WARDEN_INDEX_DIR = "/idx";
  assert.equal(indexDir(undefined, dirs), join("/idx", "pi-warden", "index"), "PI_WARDEN_INDEX_DIR wins over everything");
  process.env.PI_WARDEN_INDEX_DIR = "   ";
  assert.equal(indexDir(undefined, dirs), join("/opt/agent", "pi-warden", "index"), "blank index var falls to PI_CODING_AGENT_DIR");
  process.env.PI_CODING_AGENT_DIR = "~/x";
  assert.equal(indexDir(), join(process.env.HOME ?? "", "x", "pi-warden", "index"), "~ expands to the home directory");
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(indexDir(), join(process.env.HOME ?? "", ".pi", "agent", "pi-warden", "index"), "unset env falls back to the Pi default");
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedIndex === undefined) delete process.env.PI_WARDEN_INDEX_DIR; else process.env.PI_WARDEN_INDEX_DIR = savedIndex;
});

test("every path function places its result under the injected dirs", () => {
  delete process.env.PI_CODING_AGENT_DIR;
  const savedIndex = process.env.PI_WARDEN_INDEX_DIR;
  const savedStats = process.env.PI_WARDEN_STEER_STATS;
  const savedDb = process.env.PI_WARDEN_DB;
  delete process.env.PI_WARDEN_INDEX_DIR;
  delete process.env.PI_WARDEN_STEER_STATS;
  delete process.env.PI_WARDEN_DB;
  try {
    const dirs = { agentDir: "/custom/agent", configDirName: ".omp" };
    const project = "/work/repo";
    const underAgent = (p: string) => p.startsWith("/custom/agent/pi-warden/");
    assert.ok(underAgent(userConfigPath(dirs)), userConfigPath(dirs));
    assert.ok(underAgent(steerStatsPath(dirs)), steerStatsPath(dirs));
    assert.ok(underAgent(holdLogPath("s1", new Date(0), dirs)), holdLogPath("s1", new Date(0), dirs));
    assert.ok(underAgent(loopsPath(project, "s1", dirs)), loopsPath(project, "s1", dirs));
    assert.ok(underAgent(prefsStorePath(project, dirs)), prefsStorePath(project, dirs));
    assert.ok(underAgent(rulesLogPath(project, dirs)), rulesLogPath(project, dirs));
    assert.ok(underAgent(indexDir(undefined, dirs)), indexDir(undefined, dirs));
    assert.ok(underAgent(indexPath("global", undefined, undefined, dirs)), indexPath("global", undefined, undefined, dirs));
    assert.ok(underAgent(indexPath("project", project, undefined, dirs)), indexPath("project", project, undefined, dirs));
    // The project config file uses the injected configDirName, not .pi.
    assert.equal(projectConfigPath(project, dirs), join(project, ".omp", "pi-warden.json"));
  } finally {
    if (savedIndex === undefined) delete process.env.PI_WARDEN_INDEX_DIR; else process.env.PI_WARDEN_INDEX_DIR = savedIndex;
    if (savedStats === undefined) delete process.env.PI_WARDEN_STEER_STATS; else process.env.PI_WARDEN_STEER_STATS = savedStats;
    if (savedDb === undefined) delete process.env.PI_WARDEN_DB; else process.env.PI_WARDEN_DB = savedDb;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  }
});

test("loadConfig, readUserConfig, and setUserSetting honour injected dirs", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-warden-dirs-"));
  const dirs = { agentDir: temp, configDirName: ".omp" };
  try {
    assert.equal(readUserConfig(dirs).enabled, undefined, "no file yet");
    const saved = setUserSetting("enabled", false, dirs);
    assert.equal(saved, join(temp, "pi-warden", "config.json"));
    assert.equal(readFileSync(saved, "utf8").includes('"enabled": false'), true);
    assert.equal(loadConfig({ dirs }).enabled, false);
    // A project file under the injected configDirName is read when trusted.
    mkdirSync(join(temp, "proj", ".omp"), { recursive: true });
    writeFileSync(join(temp, "proj", ".omp", "pi-warden.json"), JSON.stringify({ action: { offTask: { warn: 0.3, steer: 0.4 } } }));
    const withProject = loadConfig({ cwd: join(temp, "proj"), projectTrusted: true, dirs });
    assert.equal(withProject.action.offTask.warn, 0.3, "project file under .omp is read");
    // writeUserConfig round-trips through dirs as well.
    writeUserConfig({ enabled: true }, dirs);
    assert.equal(JSON.parse(readFileSync(saved, "utf8")).enabled, true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("legacyDataNotice: gated on the marker beside the data folder; conditional mv + cp", () => {
  const pi = { agentDir: "/home/.pi/agent", configDirName: ".pi" };
  const omp = { agentDir: "/home/.omp/agent", configDirName: ".omp" };
  const target = join(omp.agentDir, "pi-warden");
  const legacy = join(pi.agentDir, "pi-warden");
  const q = (value: string) => `'` + value.replaceAll("'", `'\\''`) + `'`;
  const exists = new Set<string>([legacy, join(target, "holds.db")]);
  const probe = (p: string) => exists.has(p);
  const message = legacyDataNotice(omp, pi, probe);
  assert.ok(message, "legacy present, marker absent → message");
  // Command is conditional on the target existing, moves it aside non-destructively, and quotes every path.
  assert.ok(
    message.includes(`{ [ ! -e ${q(target)} ] || mv ${q(target)} ${q(`${target}.before-migration`)}; } && cp -R ${q(legacy)} ${q(target)}`),
    "exact conditional mv + cp command with quoted paths",
  );
  assert.ok(message.includes("close all Pi and oh-my-pi sessions"), "keeps the sessions-first warning");
  assert.ok(message.includes(".pi/pi-warden.json to .omp/pi-warden.json"), "names the project-file copy");
  // Marker beside the data folder → silent.
  exists.add(join(omp.agentDir, ".pi-warden-migration-notice-shown"));
  assert.equal(legacyDataNotice(omp, pi, probe), undefined, "marker beside the folder silences it");
  // No legacy data → silent.
  exists.delete(legacy);
  assert.equal(legacyDataNotice(omp, pi, probe), undefined, "no legacy data");
  // Pi host → silent (dirs equal the default), whatever exists.
  exists.add(legacy);
  assert.equal(legacyDataNotice(pi, pi, probe), undefined, "Pi host never migrates");
});

test("legacyDataNotice: the same directory under another spelling gets no notice", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-warden-same-"));
  try {
    const pi = { agentDir: join(temp, ".pi", "agent"), configDirName: ".pi" };
    mkdirSync(join(pi.agentDir, "pi-warden"), { recursive: true });
    symlinkSync(pi.agentDir, join(temp, "linked-agent"));
    const markerAbsent = (path: string) => !path.endsWith(".pi-warden-migration-notice-shown");
    // The command would move the only copy aside and then fail its copy, so no spelling of Pi's own directory may trigger it.
    // On a case-insensitive filesystem (macOS default) `.PI` names the same directory too.
    const caseInsensitive = existsSync(join(temp, ".PI", "agent"));
    const spellings = [`${pi.agentDir}/`, `${join(temp, ".pi")}/./agent`, join(temp, "linked-agent"), ...(caseInsensitive ? [join(temp, ".PI", "agent")] : [])];
    for (const spelling of spellings) {
      assert.equal(legacyDataNotice({ agentDir: spelling, configDirName: ".omp" }, pi, markerAbsent), undefined, `same directory: ${spelling}`);
    }
    assert.ok(legacyDataNotice({ agentDir: join(temp, ".omp", "agent"), configDirName: ".omp" }, pi, markerAbsent), "a different directory still gets the notice");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("legacyDataNotice: quoting survives a path with a space and a single quote", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-warden-shq-"));
  try {
    // A real temp tree whose path carries a space and a single quote, standing in for the agent dir.
    const awkward = { agentDir: join(temp, "My Disk/it's/agent"), configDirName: ".omp" };
    const pi = { agentDir: join(temp, "home/.pi/agent"), configDirName: ".pi" };
    const target = join(awkward.agentDir, "pi-warden");
    const legacy = join(pi.agentDir, "pi-warden");
    const message = legacyDataNotice(awkward, pi, path => !path.endsWith(".pi-warden-migration-notice-shown"));
    assert.ok(message, "message present for the awkward path");
    // The command the notice embeds survives sh -c: fresh data moves aside, legacy data lands.
    const command = message.match(/run `(.+)`\./)?.[1];
    assert.ok(command, "the notice embeds the command in backticks");
    mkdirSync(target, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(target, "fresh.json"), "{}");
    writeFileSync(join(legacy, "old.json"), "{}");
    execFileSync("sh", ["-c", command]);
    assert.ok(existsSync(join(target, "old.json")), "legacy file copied into the target");
    assert.ok(existsSync(join(`${target}.before-migration`, "fresh.json")), "fresh data moved aside");
    assert.ok(!existsSync(join(target, "fresh.json")), "fresh file no longer in the target");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
