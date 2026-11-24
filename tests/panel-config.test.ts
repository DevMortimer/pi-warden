import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { DECISIONS_BACKENDS } from "pi-typesafe";
import { applyUserOverrides, defaultConfig, getNestedValue, loadConfig, projectConfigPath, readUserConfig, setNestedValue, userConfigPath, writeUserConfig, type WardenConfig } from "../src/config.js";
import type { HostDirs } from "../src/host-dirs.js";
import { openConfigPanel, type PanelUi } from "../src/panel.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const enter = "\r";
const escape = "\x1b";
const left = "\x1b[D";
const right = "\x1b[C";
const BACKEND_SELECTOR_OPTIONS = ["cloud", "warden-s1", "auto", ...Object.keys(DECISIONS_BACKENDS)];
const selectors = [
  { path: "mode", options: ["steer", "confirm", "advise"] },
  { path: "typesafeBackend", options: BACKEND_SELECTOR_OPTIONS },
  { path: "localModel.runtime", options: ["auto", "mlx", "onnx"] },
  { path: "widget.placement", options: ["aboveEditor", "belowEditor"] },
  { path: "widget.barMode", options: ["stack", "live"] },
  { path: "conscience.skills.mode", options: ["off", "recommend", "load"] },
  { path: "context.recallTool", options: ["auto", "rg", "ag", "ugrep", "git-grep", "grep", "select-string", "findstr", "none"] },
] satisfies Array<{ path: string; options: readonly string[] }>;

/** Build the real overlay with temporary host directories and observe only public interactions. */
function configPanel(t: TestContext, raw?: Record<string, unknown>, effective?: (root: string, dirs: HostDirs) => WardenConfig, size = { rows: 256, width: 240 }, options: { userRaw?: Record<string, unknown>; onWrite?: (changes: ReadonlyMap<string, unknown>) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-warden-panel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs: HostDirs = { agentDir: join(root, "agent"), configDirName: ".pi" };
  if (raw !== undefined) writeUserConfig(raw, dirs);
  let component: ReturnType<Parameters<PanelUi["custom"]>[0]> | undefined;
  let renders = 0;
  let unfocused = 0;
  const ui: PanelUi = {
    custom<T>(factory: Parameters<PanelUi["custom"]>[0], options?: Record<string, unknown>): Promise<T> {
      return new Promise<T>(resolve => {
        component = factory({ requestRender() { renders++; }, terminal: { rows: size.rows } }, theme, undefined, resolve as (result: unknown) => void);
        Object.assign(component, { focused: true });
        (options?.onHandle as ((handle: unknown) => void) | undefined)?.({ unfocus() { unfocused++; } });
      });
    },
  };
  const controller = openConfigPanel(ui, effective?.(root, dirs) ?? loadConfig({ dirs }), { dirs, ...options });
  const press = (data: string) => {
    assert.ok(component?.handleInput, "the overlay exposes keyboard input");
    component.handleInput(data);
  };
  const render = () => {
    assert.ok(component, "the overlay was built");
    return component.render(size.width).join("\n");
  };
  const scroll = (wheelDelta: number) => {
    assert.ok(component?.handleMouse, "the overlay exposes mouse scrolling");
    component.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: size.width, height: size.rows - 2, shift: false, alt: false, ctrl: false, wheelDelta });
  };
  const selected = (path: string) => {
    const keys = path.split(".");
    const prefix = `│ ${"  ".repeat(keys.length - 1)}> ${keys.at(-1)} `;
    return render().split("\n").find(line => line.startsWith(prefix));
  };
  const select = (path: string) => {
    press("\x1b[H");
    for (let n = 0; n < 200; n++) {
      if (selected(path) !== undefined) return;
      // A user can scroll the row into view on the original small-viewport panel.
      if (size.rows < 256 && !/^│\s*> /m.test(render())) {
        scroll(1);
        if (selected(path) !== undefined) return;
      }
      press("\x1b[B");
    }
    assert.fail(`No selectable row for ${path}`);
  };
  const text = (path: string, oldValue: string, value: string) => {
    select(path);
    press(enter);
    for (const _char of oldValue) press("\x7f");
    for (const char of value) press(char);
    press(enter);
  };
  const bytes = () => existsSync(userConfigPath(dirs)) ? readFileSync(userConfigPath(dirs), "utf8") : undefined;
  return { root, dirs, controller, press, render, scroll, select, selected, text, bytes, renders: () => renders, unfocused: () => unfocused };
}

for (const { path, options } of selectors) {
  test(`config selector: ${path} cycles every option, wraps both ways, and saves on Enter`, t => {
    assert.ok(options.length > 0);
    const first = options[0]!;
    const last = options.at(-1)!;
    const panel = configPanel(t, setNestedValue({ untouched: { keep: 42 } }, path, last));
    panel.select(path);
    panel.press(enter);
    panel.press(right);
    panel.press(enter);
    assert.equal(getNestedValue(readUserConfig(panel.dirs), path), first, "Right wraps and Enter writes the selected field");
    assert.equal(getNestedValue(loadConfig({ dirs: panel.dirs }) as unknown as Record<string, unknown>, path), first, "the loader accepts the selected option");
    assert.deepEqual(readUserConfig(panel.dirs).untouched, { keep: 42 });
    panel.press(enter);
    assert.match(panel.selected(path)!, /‹ .* ›/);
    assert.doesNotMatch(panel.selected(path)!, /█/);
    assert.match(panel.render(), /←→.*enter save/);
    for (const value of options.slice(1)) {
      panel.press(right);
      assert.ok(panel.selected(path)!.includes(`‹ ${value} ›`));
    }
    panel.press(right);
    assert.ok(panel.selected(path)!.includes(`‹ ${first} ›`));
    panel.press(left);
    assert.ok(panel.selected(path)!.includes(`‹ ${last} ›`));
    panel.press(enter);
    assert.equal(getNestedValue(readUserConfig(panel.dirs), path), last, "Left wraps and Enter saves the last option");
    for (const value of options) {
      assert.equal(getNestedValue(loadConfigFromRaw(path, value) as unknown as Record<string, unknown>, path), value);
    }
  });

  test(`config selector: ${path} preserves invalid disk values until a first cycle`, t => {
    for (const [key, expected] of [[right, options[0]!], [left, options.at(-1)!]] as const) {
      const panel = configPanel(t, setNestedValue({ extra: "keep" }, path, "unrecognized-value"));
      const original = panel.bytes();
      panel.select(path);
      assert.ok(panel.selected(path)!.includes("unrecognized-value"));
      panel.press(enter);
      panel.press(enter);
      assert.equal(panel.bytes(), original, "uncycled Enter preserves the original bytes");
      panel.press(enter);
      panel.press(key);
      assert.ok(panel.selected(path)!.includes(`‹ ${expected} ›`));
      panel.press(escape);
      assert.ok(panel.selected(path)!.includes("unrecognized-value"), "Esc discards the draft");
      assert.equal(panel.bytes(), original);
      panel.press(enter);
      panel.press(key);
      panel.press(enter);
      assert.equal(getNestedValue(readUserConfig(panel.dirs), path), expected);
      assert.equal(readUserConfig(panel.dirs).extra, "keep");
    }
  });
}

function loadConfigFromRaw(path: string, value: string): WardenConfig {
  // This calls the same parser as loadConfig without creating another user file.
  return applyUserOverrides(defaultConfig(), setNestedValue({}, path, value));
}

test("config selector: uncycled Enter and Esc do not create an absent user file", t => {
  const panel = configPanel(t);
  for (const { path } of selectors) {
    panel.select(path);
    panel.press(enter);
    panel.press(enter);
    assert.equal(panel.bytes(), undefined);
    panel.press(enter);
    panel.press(right);
    panel.press(escape);
    assert.equal(panel.bytes(), undefined);
  }
  assert.equal(existsSync(panel.dirs.agentDir), false);
});

test("config selector: text, numbers, and booleans stay staged while selector Enter saves one field", t => {
  const panel = configPanel(t, { mode: "steer", enabled: true, maxRequests: 500, widget: { shortcut: "ctrl+shift+w" }, extra: { keep: true } });
  const original = panel.bytes();
  panel.select("widget.shortcut");
  panel.press(enter);
  assert.match(panel.selected("widget.shortcut")!, /█/);
  assert.match(panel.render(), /enter stage/);
  panel.press(escape);
  panel.text("widget.shortcut", "ctrl+shift+w", "ctrl+j");
  panel.text("maxRequests", "500", "25");
  panel.select("enabled");
  panel.press(enter);
  assert.ok(panel.selected("enabled")!.includes("○ *"));
  assert.equal(panel.bytes(), original);
  panel.select("mode");
  panel.press(enter);
  panel.press(enter);
  assert.equal(panel.bytes(), original, "uncycled Enter does not save pending fields");
  panel.press(enter);
  panel.press(right);
  panel.press("s");
  assert.equal(panel.bytes(), original, "s while selecting does not save pending fields");
  panel.press(enter);
  assert.deepEqual(readUserConfig(panel.dirs), { mode: "confirm", enabled: true, maxRequests: 500, widget: { shortcut: "ctrl+shift+w" }, extra: { keep: true } });
  for (const path of ["widget.shortcut", "maxRequests", "enabled"]) {
    panel.select(path);
    assert.ok(panel.selected(path)!.endsWith(" *"), `${path} keeps its pending marker`);
  }
  panel.press("s");
  assert.deepEqual(readUserConfig(panel.dirs), { mode: "confirm", enabled: false, maxRequests: 25, widget: { shortcut: "ctrl+j" }, extra: { keep: true } });
  assert.doesNotMatch(panel.render(), / \*$/m);
});

const customBackend = { label: "Example gateway", host: "https://judge.example.test", keyEnv: "EXAMPLE_JUDGE_KEY", path: "/decisions", defaultModel: "example" };

test("config selector: a custom backend remains untouched on uncycled Enter and Esc", t => {
  const panel = configPanel(t, { typesafeBackend: customBackend });
  const original = panel.bytes();
  panel.select("typesafeBackend");
  assert.ok(panel.selected("typesafeBackend")!.includes("custom"));
  panel.press(enter);
  panel.press(enter);
  assert.equal(panel.bytes(), original);
  panel.press(enter);
  panel.press(left);
  assert.ok(panel.selected("typesafeBackend")!.includes(`‹ ${Object.keys(DECISIONS_BACKENDS).at(-1)} ›`));
  panel.press(escape);
  assert.equal(panel.bytes(), original);
  panel.select("typesafeBackend.host");
  assert.ok(panel.selected("typesafeBackend.host")!.includes(customBackend.host));
});

test("config selector: custom backend child edits prevent replacing their parent until saved", t => {
  const panel = configPanel(t, { typesafeBackend: customBackend, extra: "keep" });
  panel.text("typesafeBackend.label", customBackend.label, "Changed gateway");
  panel.select("typesafeBackend");
  panel.press(enter);
  panel.press(right);
  panel.press(enter);
  assert.deepEqual(readUserConfig(panel.dirs).typesafeBackend, customBackend);
  assert.match(panel.render(), /Esc.*s.*save/i);
  panel.press(escape);
  panel.select("typesafeBackend.label");
  assert.ok(panel.selected("typesafeBackend.label")!.endsWith(" *"));
  panel.press("s");
  assert.deepEqual(readUserConfig(panel.dirs).typesafeBackend, { ...customBackend, label: "Changed gateway" });
  panel.select("typesafeBackend");
  panel.press(enter);
  panel.press(right);
  panel.press(enter);
  assert.equal(readUserConfig(panel.dirs).typesafeBackend, BACKEND_SELECTOR_OPTIONS[0]);
  assert.doesNotMatch(panel.render(), /Changed gateway|EXAMPLE_JUDGE_KEY|defaultModel/);
});

test("config selector: a successful named backend replacement removes only its children", t => {
  const panel = configPanel(t, { typesafeBackend: customBackend, widget: { shortcut: "ctrl+shift+w" }, enabled: true, extra: "keep" });
  panel.text("widget.shortcut", "ctrl+shift+w", "ctrl+j");
  panel.select("enabled");
  panel.press(enter);
  panel.select("typesafeBackend");
  panel.press(enter);
  panel.press(right);
  panel.press(enter);
  assert.ok(panel.selected("typesafeBackend"), "the cursor stays on the backend row");
  assert.doesNotMatch(panel.render(), /Example gateway|EXAMPLE_JUDGE_KEY|defaultModel/);
  assert.deepEqual(readUserConfig(panel.dirs), { typesafeBackend: BACKEND_SELECTOR_OPTIONS[0], widget: { shortcut: "ctrl+shift+w" }, enabled: true, extra: "keep" });
  panel.select("widget.shortcut");
  assert.ok(panel.selected("widget.shortcut")!.includes("ctrl+j *"));
  panel.select("enabled");
  assert.ok(panel.selected("enabled")!.includes("○ *"));
  panel.press("s");
  assert.deepEqual(readUserConfig(panel.dirs), { typesafeBackend: BACKEND_SELECTOR_OPTIONS[0], widget: { shortcut: "ctrl+j" }, enabled: false, extra: "keep" });
});

test("config selector: a write failure retains the draft and pending edits for retry", t => {
  const panel = configPanel(t, { enabled: true, mode: "steer", extra: "keep" });
  panel.select("enabled");
  panel.press(enter);
  panel.select("mode");
  panel.press(enter);
  panel.press(right);
  const parked = join(panel.root, "parked-agent");
  renameSync(panel.dirs.agentDir, parked);
  writeFileSync(panel.dirs.agentDir, "temporary obstruction");
  assert.doesNotThrow(() => panel.press(enter));
  assert.match(panel.render(), /save failed/i);
  assert.ok(panel.selected("mode")!.includes("‹ confirm ›"));
  rmSync(panel.dirs.agentDir);
  renameSync(parked, panel.dirs.agentDir);
  panel.press(enter);
  assert.deepEqual(readUserConfig(panel.dirs), { enabled: true, mode: "confirm", extra: "keep" });
  assert.doesNotMatch(panel.render(), /save failed/i);
  panel.select("enabled");
  assert.ok(panel.selected("enabled")!.includes("○ *"));
  panel.press("s");
  assert.deepEqual(readUserConfig(panel.dirs), { enabled: false, mode: "confirm", extra: "keep" });
});

test("config selector: saving re-reads user config and preserves a later unrelated setting", t => {
  const panel = configPanel(t, { mode: "steer", extra: "original" });
  panel.select("mode");
  panel.press(enter);
  panel.press(right);
  writeUserConfig({ mode: "steer", extra: "updated", later: { keep: true } }, panel.dirs);
  panel.press(enter);
  assert.deepEqual(readUserConfig(panel.dirs), { mode: "confirm", extra: "updated", later: { keep: true } });
});

for (const malformed of ["not-an-object", ["not-an-object"]]) {
  test(`config selector: an explicit nested save repairs a ${Array.isArray(malformed) ? "array" : "string"} parent only on selection`, t => {
    for (const { path, options } of selectors.filter(selector => selector.path.startsWith("widget."))) {
      const panel = configPanel(t, { widget: malformed, mode: "unknown-mode", extra: { keep: true } });
      const original = panel.bytes();
      panel.select(path);
      panel.press(enter);
      panel.press(enter);
      assert.equal(panel.bytes(), original);
      panel.press(enter);
      panel.press(right);
      panel.press(escape);
      assert.equal(panel.bytes(), original);
      panel.press(enter);
      panel.press(right);
      const line = panel.selected(path)!;
      const chosen = options.find(value => line.includes(`‹ ${value} ›`));
      assert.ok(chosen);
      panel.press(enter);
      assert.deepEqual(readUserConfig(panel.dirs), { widget: { [path.split(".")[1]!]: chosen }, mode: "unknown-mode", extra: { keep: true } });
    }
  });
}

test("config selector: non-string invalid values are displayed and preserved", t => {
  for (const value of [null, false, 42, ["steer"], { unexpected: "steer" }]) {
    const panel = configPanel(t, { mode: value });
    const original = panel.bytes();
    panel.select("mode");
    assert.ok(panel.selected("mode")!.includes(JSON.stringify(value)));
    assert.match(panel.selected("mode")!, /invalid/i);
    panel.press(enter);
    panel.press(enter);
    assert.equal(panel.bytes(), original);
    panel.press(enter);
    panel.press(right);
    panel.press(enter);
    assert.equal(readUserConfig(panel.dirs).mode, "steer");
  }
});

test("config selector: a refused backend keeps its raw value and does not expose derived backendRefusal", t => {
  const panel = configPanel(t, { typesafeBackend: "unrecognized-backend" });
  panel.select("typesafeBackend");
  assert.ok(panel.selected("typesafeBackend")!.includes("unrecognized-backend"));
  assert.doesNotMatch(panel.render(), /backendRefusal/);
});

test("config selector: recall edits use the user layer while a trusted project keeps its override", t => {
  for (const userValue of [undefined, "rg"]) {
    let project = "";
    const panel = configPanel(t, userValue === undefined ? undefined : { context: { recallTool: userValue } }, (root, dirs) => {
      project = join(root, "project");
      const path = projectConfigPath(project, dirs);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ context: { recallTool: "none" } }));
      const config = loadConfig({ dirs, cwd: project, projectTrusted: true });
      assert.equal(config.context.recallTool, "none");
      return config;
    });
    const original = panel.bytes();
    panel.select("context.recallTool");
    assert.ok(panel.selected("context.recallTool")!.includes(`‹ ${userValue ?? "auto"} ›`));
    for (const path of ["context.tailMinChars", "context.compactAppendix", "context.filter.chunkChars"]) {
      panel.select(path);
      assert.ok(panel.selected(path), "ordinary context controls remain navigable beside the recall selector");
    }
    panel.select("context.recallTool");
    panel.press(enter);
    panel.press(enter);
    assert.equal(panel.bytes(), original);
    panel.press(enter);
    panel.press(right);
    panel.press(escape);
    assert.equal(panel.bytes(), original);
    panel.press(enter);
    panel.press(right);
    panel.press(enter);
    assert.equal(getNestedValue(readUserConfig(panel.dirs), "context.recallTool"), userValue === undefined ? "rg" : "ag");
    assert.equal(loadConfig({ dirs: panel.dirs, cwd: project, projectTrusted: true }).context.recallTool, "none");
  }
});

test("config context: numeric and boolean drafts stay separate from recall saves and preserve later user edits", t => {
  const raw = { context: { tailMinChars: 12000, compactAppendix: true, recallTool: "auto", filter: { chunkChars: 2000, extra: "keep" }, extra: "original" }, extra: "keep" };
  const writes: Array<Array<[string, unknown]>> = [];
  const panel = configPanel(t, raw, undefined, undefined, { onWrite: changes => writes.push([...changes]) });
  const original = panel.bytes();
  panel.text("context.tailMinChars", "12000", "9000");
  panel.select("context.compactAppendix");
  panel.press(enter);
  panel.text("context.filter.chunkChars", "2000", "1500");
  assert.equal(panel.bytes(), original, "context edits remain staged");
  panel.select("context.recallTool");
  panel.press(enter);
  panel.press(right);
  panel.press(enter);
  assert.deepEqual(readUserConfig(panel.dirs), { ...raw, context: { ...raw.context, recallTool: "rg" } });
  assert.deepEqual(writes, [[["context.recallTool", "rg"]]]);
  for (const path of ["context.tailMinChars", "context.compactAppendix", "context.filter.chunkChars"]) {
    panel.select(path);
    assert.ok(panel.selected(path)!.endsWith(" *"), "recall saves retain ordinary context drafts");
  }
  const later = { ...raw, extra: "updated", context: { ...raw.context, recallTool: "rg", extra: "updated", filter: { ...raw.context.filter, later: true } } };
  writeUserConfig(later, panel.dirs);
  panel.press("s");
  assert.deepEqual(readUserConfig(panel.dirs), { ...later, context: { ...later.context, tailMinChars: 9000, compactAppendix: false, filter: { ...later.context.filter, chunkChars: 1500 } } });
  assert.deepEqual(writes[1], [["context.tailMinChars", 9000], ["context.compactAppendix", false], ["context.filter.chunkChars", 1500]]);
});

for (const trusted of [false, true]) {
  test("config context: effective values and user-only filter consent respect project trust " + trusted, t => {
    let project = "";
    let projectPath = "";
    const panel = configPanel(t, { context: { filter: { enabled: false } }, extra: "keep" }, (root, dirs) => {
      project = join(root, "project");
      projectPath = projectConfigPath(project, dirs);
      mkdirSync(dirname(projectPath), { recursive: true });
      writeFileSync(projectPath, JSON.stringify({ context: { enabled: false, tailMinChars: 6400, duplicateMinChars: 512, compactAppendix: false, recallTool: "none", filter: { enabled: true, chunkChars: 777 } } }));
      const config = loadConfig({ dirs, cwd: project, projectTrusted: trusted });
      assert.equal(config.context.filter.enabled, false, "a project cannot enable the filter");
      return config;
    });
    const original = panel.bytes();
    const projectBytes = readFileSync(projectPath, "utf8");
    panel.select("context.tailMinChars");
    assert.ok(panel.selected("context.tailMinChars")!.endsWith(trusted ? "6400" : "12000"));
    panel.select("context.compactAppendix");
    assert.ok(panel.selected("context.compactAppendix")!.endsWith(trusted ? "○" : "●"));
    panel.select("context.filter.chunkChars");
    assert.ok(panel.selected("context.filter.chunkChars")!.endsWith(trusted ? "777" : "2000"));
    // Anchor at the unique child before moving to filter.enabled; largeOutput has another enabled row.
    panel.press("\x1b[A");
    assert.ok(panel.selected("context.filter.enabled")!.endsWith("○"));
    panel.press(enter);
    assert.ok(panel.selected("context.filter.enabled")!.endsWith("● *"));
    panel.select("context.recallTool");
    assert.ok(panel.selected("context.recallTool")!.includes("‹ auto ›"), "recall still shows the user default");
    panel.press(enter);
    panel.press(enter);
    assert.equal(panel.bytes(), original);
    panel.text("context.tailMinChars", trusted ? "6400" : "12000", "9000");
    panel.press("s");
    assert.deepEqual(readUserConfig(panel.dirs), { context: { filter: { enabled: true }, tailMinChars: 9000 }, extra: "keep" }, "only edited leaves enter the user file");
    assert.equal(readFileSync(projectPath, "utf8"), projectBytes, "the project file stays untouched");
    const effective = loadConfig({ dirs: panel.dirs, cwd: project, projectTrusted: trusted });
    assert.equal(effective.context.tailMinChars, trusted ? 6400 : 9000);
    assert.equal(effective.context.recallTool, trusted ? "none" : "auto");
    assert.equal(effective.context.filter.enabled, true, "the explicit user choice enables the filter");
  });
}

test("config context: a 24-row deep numeric edit stays visible after a failed save and retries with s", t => {
  const panel = configPanel(t, { context: { filter: { chunkChars: 2000 } }, extra: "keep" }, undefined, { rows: 24, width: 80 });
  const original = panel.bytes();
  panel.text("context.filter.chunkChars", "2000", "1500");
  assert.equal(panel.bytes(), original);
  const parked = join(panel.root, "parked-agent");
  renameSync(panel.dirs.agentDir, parked);
  writeFileSync(panel.dirs.agentDir, "temporary obstruction");
  panel.press("s");
  const failed = panel.render();
  assert.equal(failed.split("\n").length, 22);
  assert.match(failed.replace(/\n│ /g, " "), /Save failed\. Retry s\./);
  assert.ok(panel.selected("context.filter.chunkChars")!.endsWith("1500 *"));
  rmSync(panel.dirs.agentDir);
  renameSync(parked, panel.dirs.agentDir);
  assert.equal(panel.bytes(), original);
  panel.press("s");
  assert.deepEqual(readUserConfig(panel.dirs), { context: { filter: { chunkChars: 1500 } }, extra: "keep" });
  assert.ok(panel.selected("context.filter.chunkChars")!.endsWith("1500"));
  assert.doesNotMatch(panel.render(), /Save failed/);
});

for (const { path, options } of selectors.filter(selector => ["conscience.skills.mode", "widget.placement", "context.recallTool"].includes(selector.path))) {
  test(`config selector: 24-row ${path} keeps a write error and its selection visible for retry`, t => {
    const raw = setNestedValue({ enabled: true, maxRequests: 500, extra: "keep" }, path, options[0]);
    const panel = configPanel(t, raw, undefined, { rows: 24, width: 80 });
    panel.select("enabled");
    panel.press(enter);
    panel.text("maxRequests", "500", "25");
    panel.select(path);
    panel.press(enter);
    panel.press(right);
    assert.ok(panel.selected(path)!.includes(`‹ ${options[1]} ›`));
    const original = panel.bytes();
    const parked = join(panel.root, "parked-agent");
    renameSync(panel.dirs.agentDir, parked);
    writeFileSync(panel.dirs.agentDir, "temporary obstruction");
    panel.press(enter);
    const failed = panel.render();
    assert.equal(failed.split("\n").length, 22, "the overlay stays within the 24-row terminal");
    assert.match(failed, /Save failed/, "the scrolled viewport shows the write failure");
    assert.match(failed.replace(/\n│ /g, " "), /Retry Enter\./, "the selector retry key remains visible");
    assert.ok(panel.selected(path)?.includes(`‹ ${options[1]} ›`), "the failed selection stays visible beside the notice");
    assert.doesNotMatch(failed, /^│ (?:> |  )enabled /m, "the list stays near the selected field instead of returning to the top");
    rmSync(panel.dirs.agentDir);
    renameSync(parked, panel.dirs.agentDir);
    assert.equal(panel.bytes(), original, "a failed write leaves the original file intact");
    panel.press(enter);
    assert.equal(getNestedValue(readUserConfig(panel.dirs), path), options[1]);
    assert.ok(panel.selected(path)?.includes(`‹ ${options[1]} ›`), "the selection remains visible after retry");
    assert.doesNotMatch(panel.render(), /Save failed/);
    assert.equal(readUserConfig(panel.dirs).enabled, true);
    assert.equal(readUserConfig(panel.dirs).maxRequests, 500);
    panel.select("enabled");
    assert.ok(panel.selected("enabled")!.includes("○ *"));
    panel.select("maxRequests");
    assert.ok(panel.selected("maxRequests")!.includes("25 *"));
    renameSync(panel.dirs.agentDir, parked);
    writeFileSync(panel.dirs.agentDir, "temporary obstruction");
    panel.press("s");
    const stagedFailure = panel.render();
    assert.match(stagedFailure.replace(/\n│ /g, " "), /Save failed\. Retry s\./, "staged edits show their actual retry key");
    assert.ok(panel.selected("maxRequests")!.includes("25 *"), "a failed s save retains the selected staged value");
    rmSync(panel.dirs.agentDir);
    renameSync(parked, panel.dirs.agentDir);
    panel.press("s");
    assert.equal(readUserConfig(panel.dirs).enabled, false);
    assert.equal(readUserConfig(panel.dirs).maxRequests, 25);
    assert.equal(readUserConfig(panel.dirs).extra, "keep");
  });
}

test("config selector: 24-row backend pending notice and chosen backend remain visible after scrolling", t => {
  const panel = configPanel(t, { typesafeBackend: customBackend, extra: "keep" }, undefined, { rows: 24, width: 80 });
  panel.text("typesafeBackend.label", customBackend.label, "Changed gateway");
  panel.select("typesafeBackend");
  panel.press(enter);
  panel.press(right);
  panel.scroll(2);
  assert.equal(panel.selected("typesafeBackend"), undefined, "mouse scrolling is preserved before the next keyboard action");
  panel.press(enter);
  const blocked = panel.render();
  assert.equal(blocked.split("\n").length, 22);
  assert.match(blocked, /Backend fields have pending edits/, "the pending-edit refusal stays visible after scrolling");
  assert.match(blocked.replace(/\n│ /g, " "), /Esc, then s/);
  assert.ok(panel.selected("typesafeBackend")?.includes(`‹ ${BACKEND_SELECTOR_OPTIONS[0]} ›`));
  assert.deepEqual(readUserConfig(panel.dirs).typesafeBackend, customBackend);
  panel.press(escape);
  panel.press("s");
  assert.deepEqual(readUserConfig(panel.dirs).typesafeBackend, { ...customBackend, label: "Changed gateway" });
  panel.press(enter);
  panel.press(right);
  panel.press(enter);
  assert.equal(readUserConfig(panel.dirs).typesafeBackend, BACKEND_SELECTOR_OPTIONS[0]);
  assert.equal(readUserConfig(panel.dirs).extra, "keep");
  assert.doesNotMatch(panel.render(), /pending edits|Changed gateway/);
});

test("config panel: localModel controls render and persist to user config", t => {
  const panel = configPanel(t, { localModel: { cacheDir: "~/models" } });
  panel.select("localModel.autoDownload");
  panel.press(enter);
  panel.select("localModel.runtime");
  panel.press(enter);
  panel.press(right);
  panel.press(enter);
  assert.equal((readUserConfig(panel.dirs).localModel as Record<string, unknown>).runtime, "mlx");
  panel.text("localModel.idleShutdownSec", "1800", "900");
  panel.text("localModel.cacheDir", "~/models", "~/warden-cache");
  panel.press("s");
  assert.deepEqual(readUserConfig(panel.dirs).localModel, {
    autoDownload: true,
    runtime: "mlx",
    idleShutdownSec: 900,
    cacheDir: "~/warden-cache",
  });
});

test("the config panel shows the session's snapshot, and a save reports the changed keys", t => {
  const seen: Array<[string, unknown]> = [];
  const panel = configPanel(t, setNestedValue({}, "widget.barMode", "live"), undefined, { rows: 256, width: 240 }, {
    userRaw: setNestedValue({}, "widget.barMode", "stack"),
    onWrite: changes => { for (const entry of changes) seen.push(entry); },
  });
  // The file says live, the snapshot says stack: the panel shows what this session's checks use.
  panel.select("widget.barMode");
  assert.match(panel.selected("widget.barMode")!, /‹ stack ›/);
  panel.press(enter);
  panel.press(right);
  panel.press(enter);
  assert.equal(getNestedValue(readUserConfig(panel.dirs), "widget.barMode"), "live", "the file holds the new value");
  assert.deepEqual(seen, [["widget.barMode", "live"]], "the session hears the key it must apply at once");
});
