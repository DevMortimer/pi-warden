import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DECISIONS_BACKENDS } from "pi-typesafe";
import { resolveJudgmentBackend } from "./backend.js";
import type { WardenConfig } from "./config.js";
import { CONSCIENCE_SKILL_MODES, RECALL_TOOLS, WARDEN_MODES, applyUserOverrides, defaultConfig, getNestedValue, readUserConfig, setNestedValue, writeUserConfig } from "./config.js";
import type { HostDirs } from "./host-dirs.js";
import { defaultHostDirs } from "./host-dirs.js";
import type { Trace } from "./trace.js";
import { LEVEL_COLOR, WIDGET_BAR_MODES, WIDGET_PLACEMENTS, parseVerdictLine, renderSegment } from "./widget.js";
import type { ThemeLike } from "./widget.js";

export interface PanelActions {
  /** Remove the sidebar. */
  close(): void;
  /** Keep the sidebar visible but give keyboard input back to the editor. */
  unfocus(): void;
}

/**
 * Sidebar listing the trace newest-first, live-updating while open. It opens without taking keyboard input: the editor
 * keeps working while it is visible. A click inside it (fullscreen mode) focuses it; then ↑/↓/j/k scroll a line,
 * PgUp/PgDn a page, Home/End jump, c clears the trace, Esc returns input to the editor, and q closes. Wheel scrolling
 * works without focus.
 */
export class TracePanel implements Component {
  /** Set by the TUI when keyboard focus changes. */
  focused = false;
  private scroll = 0;
  private viewport = 20;
  /** Compact mode: show 1-3 lines per entry. Toggle with `d` while focused. */
  compact = true;
  private readonly unsubscribe: () => void;

  constructor(private readonly trace: Trace, private readonly theme: ThemeLike, private readonly actions: PanelActions, private readonly requestRender: () => void, private readonly title = "pi-warden trace") {
    this.unsubscribe = trace.subscribe(() => this.requestRender());
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Rendering is cheap and derived from the trace each time; nothing is cached. */
  invalidate(): void {}

  private lines(width: number): string[] {
    const { theme, compact } = this;
    const entries = this.trace.entries();
    const out: string[] = [];
    const modeLabel = compact ? "compact" : "detailed";
    const keys = this.focused
      ? `↑↓ PgUp PgDn scroll · d ${modeLabel} · c clear · esc back · q close`
      : `click for keys · wheel scrolls · /warden trace closes`;
    out.push(theme.bold(theme.fg("accent", `${this.title}`)) + theme.fg("muted", ` · ${entries.length} event${entries.length === 1 ? "" : "s"}`));
    out.push(theme.fg("muted", keys));
    out.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
    if (!entries.length) {
      for (const line of wrapTextWithAnsi(theme.fg("muted", "No guarded activity yet this session. Verdicts, Jev scores, and what the agent was told will appear here."), Math.max(10, width))) out.push(line);
      return out.map(line => truncateToWidth(line, width, ""));
    }
    const RAIL = 16;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      const { status, body } = parseVerdictLine(entry.line, entry.guard);
      const color = LEVEL_COLOR[status ?? ""] ?? "text";
      const chip = status ? `${theme.bold(theme.fg(color, status.toUpperCase()))}  ` : "";
      const indent = RAIL + (status ? status.length + 2 : 0);
      const head = `${theme.fg("muted", new Date(entry.at).toTimeString().slice(0, 8))} ${theme.fg(color, theme.bold(entry.guard.padEnd(6)))} `;
      const rendered = body.map((segment, n) => renderSegment(segment, n === 0, theme)).join(theme.fg("dim", " · "));
      const wrapped = wrapTextWithAnsi(rendered, Math.max(10, width - indent));
      out.push(head + chip + (wrapped[0] ?? ""));
      if (!compact) {
        for (const continuation of wrapped.slice(1)) out.push(" ".repeat(indent) + continuation);
        for (const detail of entry.details) {
          const detailLines = wrapTextWithAnsi(detail, Math.max(10, width - RAIL - 2));
          for (const [n, line] of detailLines.entries()) out.push(" ".repeat(RAIL) + theme.fg("muted", n === 0 ? "· " : "  ") + theme.fg("dim", line));
        }
      } else if (entry.details.length > 0) {
        // Compact: show only the first detail line, truncated
        const firstDetail = entry.details[0]!;
        const truncated = firstDetail.length > width - indent - 4 ? firstDetail.slice(0, width - indent - 4) + "…" : firstDetail;
        out.push(" ".repeat(indent) + theme.fg("dim", truncated));
      }
      out.push("");
    }
    return out.map(line => truncateToWidth(line, width, ""));
  }

  /** A left border makes the overlay read as a pane; the content column is two cells narrower. */
  render(width: number): string[] {
    const border = theme_fg(this.theme, "muted", "│ ");
    const inner = Math.max(10, width - 2);
    const all = this.lines(inner);
    const maxScroll = Math.max(0, all.length - this.viewport);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const visible = all.slice(this.scroll, this.scroll + this.viewport);
    if (all.length > this.viewport) {
      const last = visible.length - 1;
      const below = all.length - this.scroll - this.viewport;
      const above = this.scroll;
      const label = below > 0 ? `… ${below} more below${above ? ` · ${above} above` : ""}` : `… end of trace${above ? ` · ${above} above` : ""}`;
      visible[last] = truncateToWidth(theme_fg(this.theme, "dim", label), inner, "");
    }
    while (visible.length < this.viewport) visible.push("");
    return visible.map(line => border + line);
  }

  /** The overlay tells us how tall we may be through the layout; fall back to a fixed viewport otherwise. */
  setViewport(rows: number): void {
    this.viewport = Math.max(5, rows);
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, Key.ctrl("c"))) { this.actions.close(); return; }
    if (matchesKey(data, Key.escape)) { this.actions.unfocus(); this.requestRender(); return; }
    if (data === "d") { this.compact = !this.compact; this.requestRender(); return; }
    if (matchesKey(data, Key.up) || data === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, Key.down) || data === "j") this.scroll += 1;
    else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - this.viewport);
    else if (matchesKey(data, Key.pageDown)) this.scroll += this.viewport;
    else if (matchesKey(data, Key.home)) this.scroll = 0;
    else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
    else if (data === "c") this.trace.clear();
    else return;
    this.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.scroll = Math.max(0, this.scroll + (event.wheelDelta ?? 0) * 3);
      return { handled: true, render: true };
    }
    if (event.type === "press" && event.button === "left") return { handled: true, focus: true, render: true };
    return undefined;
  }
}

function theme_fg(theme: ThemeLike, color: string, text: string): string {
  return theme.fg(color, text);
}

export interface PanelUi {
  custom<T>(factory: (tui: { requestRender(): void; terminal?: { rows: number } }, theme: ThemeLike, keybindings: unknown, done: (result: T) => void) => Component & { dispose?(): void }, options?: Record<string, unknown>): Promise<T>;
}

export interface PanelController {
  /** Resolves when the sidebar has been removed, by the user or by close(). */
  closed: Promise<void>;
  close(): void;
}

/**
 * Open the trace as a right-hand sidebar. Pi's public UI API offers floating overlays but no side dock that narrows the
 * transcript, so the sidebar covers the right part of the screen; `nonCapturing` keeps the editor focused. `built()` says
 * whether the host ever asked for the component: a host without a terminal UI (RPC mode) settles `closed` without asking.
 */
export function openTracePanel(ui: PanelUi, trace: Trace, options: { width?: string | number } = {}): PanelController & { built(): boolean } {
  let close: () => void = () => {};
  let unfocus: () => void = () => {};
  let built = false;
  const closed = ui.custom<void>((tui, theme, _keybindings, done) => {
    built = true;
    close = () => done();
    const panel = new TracePanel(trace, theme, { close, unfocus: () => unfocus() }, () => tui.requestRender());
    const rows = tui.terminal?.rows;
    if (typeof rows === "number") panel.setViewport(rows - 2);
    return panel;
  }, {
    overlay: true,
    overlayOptions: { anchor: "right-center", width: options.width ?? "40%", minWidth: 44, maxHeight: "100%", nonCapturing: true },
    // A handle without `unfocus` belongs to a host whose overlays always capture input; close instead.
    onHandle: (handle: { unfocus?(): void }) => { unfocus = typeof handle.unfocus === "function" ? () => handle.unfocus!() : () => close(); },
  });
  return { closed, close: () => close(), built: () => built };
}

interface ConfigRow {
  path: string;
  label: string;
  level: number;
  value: unknown;
  editable: boolean;
}

type ConfigEntry = ConfigRow & (
  | { type: "boolean" | "number" | "string" }
  | { type: "select"; options: readonly string[] }
);

type ConfigDraft =
  | { type: "text"; buffer: string }
  | { type: "select"; value: unknown; cycled: boolean };

const SELECTOR_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  mode: WARDEN_MODES,
  typesafeBackend: Object.keys(DECISIONS_BACKENDS),
  "widget.placement": WIDGET_PLACEMENTS,
  "widget.barMode": WIDGET_BAR_MODES,
  "conscience.skills.mode": CONSCIENCE_SKILL_MODES,
  "context.recallTool": RECALL_TOOLS,
};

function isCustomBackend(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && resolveJudgmentBackend(value).backendRefusal === undefined;
}

function selectorValue(entry: ConfigEntry & { type: "select" }, value: unknown): string {
  if (typeof value === "string" && entry.options.includes(value)) return value;
  if (entry.path === "typesafeBackend" && isCustomBackend(value)) return "custom";
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return raw + " (invalid)";
}

function flattenConfig(obj: Record<string, unknown>, prefix = ""): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  const skip = new Set(["action", "stuck", "done", "slop", "security", "rules", "runaway", "notify", "subagent", "backendRefusal"]);
  for (const [key, value] of Object.entries(obj)) {
    if (skip.has(key) && !prefix) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const level = prefix ? prefix.split(".").length : 0;
    const options = SELECTOR_OPTIONS[path];
    if (options) {
      entries.push({ path, label: key, level, value, type: "select", options, editable: true });
      if (path === "typesafeBackend" && isCustomBackend(value)) entries.push(...flattenConfig(value, path));
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      entries.push({ path, label: key, level: prefix ? prefix.split(".").length : 0, value, type: typeof value as "boolean" | "number" | "string", editable: true });
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      entries.push({ path, label: key, level: prefix ? prefix.split(".").length : 0, value: "", type: "string", editable: false });
      entries.push(...flattenConfig(value as Record<string, unknown>, path));
    }
  }
  return entries;
}

export class ConfigPanel implements Component {
  focused = false;
  private cursor = 0;
  private scroll = 0;
  private viewport = 20;
  private keepCursorVisible = true;
  private draft: ConfigDraft | undefined;
  private notice = "";
  private readonly edits = new Map<string, unknown>();
  private readonly entries: ConfigEntry[];

  constructor(private readonly config: WardenConfig, private readonly theme: ThemeLike, private readonly actions: PanelActions, private readonly requestRender: () => void, private readonly dirs: HostDirs = defaultHostDirs()) {
    const raw = readUserConfig(dirs);
    const user = applyUserOverrides(defaultConfig(), raw);
    let visible: Record<string, unknown> = { ...config, context: { recallTool: user.context.recallTool } };
    // Only selector rows use the user layer; never persist a trusted project's recall override here.
    for (const path of Object.keys(SELECTOR_OPTIONS)) {
      const value = getNestedValue(raw, path);
      visible = setNestedValue(visible, path, value === undefined ? getNestedValue(user as unknown as Record<string, unknown>, path) : value);
    }
    this.entries = flattenConfig(visible);
  }

  invalidate(): void {}

  private lines(width: number): string[] {
    const { theme, entries, cursor, draft, edits } = this;
    const out: string[] = [];
    const modeLabel = draft?.type === "select" ? "selecting" : draft ? "editing" : "browsing";
    const editingKeys = draft?.type === "select" ? "←→ choose · enter save · esc cancel"
      : draft ? "enter stage · esc cancel · s saves after editing"
      : "↑↓ navigate · enter toggle/edit · esc back · s save";
    const keys = this.focused
      ? editingKeys + " · " + modeLabel
      : `click for keys · /warden config closes`;
    out.push(theme.bold(theme.fg("accent", "pi-warden config")) + theme.fg("muted", ` · ${entries.length} keys`));
    out.push(theme.fg("muted", keys));
    out.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const isSelected = index === cursor;
      const indent = "  ".repeat(entry.level);
      const changed = edits.has(entry.path);
      const label = entry.label + (entry.editable ? "" : "/");
      if (!entry.editable) {
        out.push(indent + theme.fg("accent", theme.bold(label)));
        continue;
      }
      let valueStr: string;
      if (entry.type === "select") {
        const value = isSelected && draft?.type === "select" ? draft.value : entry.value;
        valueStr = "‹ " + selectorValue(entry, value) + " ›";
      } else if (isSelected && draft?.type === "text") {
        valueStr = draft.buffer + "\u2588";
      } else if (entry.type === "boolean") {
        valueStr = (entry.value as boolean) ? "●" : "○";
      } else if (entry.type === "number") {
        valueStr = String(entry.value);
      } else {
        valueStr = typeof entry.value === "string" && entry.value.length > 40 ? entry.value.slice(0, 37) + "…" : String(entry.value);
      }
      const changedMark = changed ? theme.fg("warning", " *") : "";
      const line = `${indent}${isSelected ? "> " : "  "}${theme.fg("muted", label)} ${theme.fg("text", valueStr)}${changedMark}`;
      if (isSelected) {
        out.push(theme.bold(line));
      } else {
        out.push(line);
      }
    }
    return out.map(line => truncateToWidth(line, width, ""));
  }

  render(width: number): string[] {
    const border = theme_fg(this.theme, "muted", "│ ");
    const inner = Math.max(10, width - 2);
    const all = this.lines(inner);
    const fixed = all.splice(0, 3);
    if (this.notice) {
      const notice = wrapTextWithAnsi(this.theme.fg("warning", this.notice), inner);
      // Keep the notice outside the scrolling list, with room for at least one selected row.
      fixed.push(...notice.slice(0, Math.max(1, this.viewport - fixed.length - 2)));
    }
    const available = Math.max(1, this.viewport - fixed.length);
    const showFooter = all.length > available && available > 1;
    const listRows = available - (showFooter ? 1 : 0);
    const maxScroll = Math.max(0, all.length - listRows);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    if (this.keepCursorVisible) {
      if (this.cursor < this.scroll) this.scroll = this.cursor;
      else if (this.cursor >= this.scroll + listRows) this.scroll = this.cursor - listRows + 1;
      this.keepCursorVisible = false;
    }
    const visible = [...fixed, ...all.slice(this.scroll, this.scroll + listRows)];
    if (showFooter) {
      const below = all.length - this.scroll - listRows;
      const above = this.scroll;
      const label = below > 0 ? `… ${below} more below${above ? ` · ${above} above` : ""}` : `… end${above ? ` · ${above} above` : ""}`;
      visible.push(truncateToWidth(theme_fg(this.theme, "dim", label), inner, ""));
    }
    while (visible.length < this.viewport) visible.push("");
    return visible.map(line => border + line);
  }

  setViewport(rows: number): void { this.viewport = Math.max(5, rows); this.keepCursorVisible = true; }

  handleInput(data: string): void {
    const { entries, draft } = this;
    if (data === "q" || matchesKey(data, Key.ctrl("c"))) { this.actions.close(); return; }
    this.keepCursorVisible = true;
    if (matchesKey(data, Key.escape)) {
      if (draft) { this.draft = undefined; this.notice = ""; this.requestRender(); return; }
      this.actions.unfocus(); this.requestRender(); return;
    }
    if (draft) {
      const entry = entries[this.cursor]!;
      if (draft.type === "select" && entry.type === "select") {
        if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
          const step = matchesKey(data, Key.right) ? 1 : -1;
          const index = typeof draft.value === "string" ? entry.options.indexOf(draft.value) : -1;
          const next = index < 0 ? (step > 0 ? 0 : entry.options.length - 1)
            : (index + step + entry.options.length) % entry.options.length;
          draft.value = entry.options[next]!;
          draft.cycled = true;
          this.notice = "";
        } else if (data === "enter" || matchesKey(data, Key.return)) {
          if (!draft.cycled) this.draft = undefined;
          else if (entry.path === "typesafeBackend" && [...this.edits.keys()].some(path => path.startsWith("typesafeBackend."))) {
            this.notice = "Backend fields have pending edits. Press Esc, then s to save them before choosing a named backend.";
          } else if (this.saveChanges(new Map([[entry.path, draft.value]]))) {
            entry.value = draft.value;
            this.draft = undefined;
            if (entry.path === "typesafeBackend") {
              // Replace only this subtree; rebuilding all rows would discard unrelated staged values.
              let end = this.cursor + 1;
              while (entries[end]?.path.startsWith("typesafeBackend.")) end++;
              entries.splice(this.cursor + 1, end - this.cursor - 1);
            }
          }
        } else return;
        this.requestRender();
        return;
      }
      if (draft.type !== "text") return;
      if (matchesKey(data, Key.return)) {
        const value = this.parseValue(draft.buffer, entry.type);
        this.edits.set(entry.path, value);
        entry.value = value;
        this.draft = undefined;
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        draft.buffer = draft.buffer.slice(0, -1);
        this.requestRender();
        return;
      }
      if (data.length === 1 && data >= " ") {
        draft.buffer += data;
        this.requestRender();
        return;
      }
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down) || data === "j") this.cursor = Math.min(entries.length - 1, this.cursor + 1);
    else if (matchesKey(data, Key.pageUp)) this.cursor = Math.max(0, this.cursor - this.viewport);
    else if (matchesKey(data, Key.pageDown)) this.cursor = Math.min(entries.length - 1, this.cursor + this.viewport);
    else if (matchesKey(data, Key.home)) this.cursor = 0;
    else if (matchesKey(data, Key.end)) this.cursor = entries.length - 1;
    else if (data === "enter" || matchesKey(data, Key.return)) {
      const entry = entries[this.cursor]!;
      if (!entry.editable) return;
      this.notice = "";
      if (entry.type === "select") {
        this.draft = { type: "select", value: entry.value, cycled: false };
      } else if (entry.type === "boolean") {
        this.edits.set(entry.path, !entry.value);
        entry.value = !entry.value;
      } else {
        this.draft = { type: "text", buffer: String(entry.value) };
      }
    }
    else if (data === "s") { this.save(); return; }
    else return;
    this.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.scroll = Math.max(0, this.scroll + (event.wheelDelta ?? 0) * 3);
      this.keepCursorVisible = false;
      return { handled: true, render: true };
    }
    if (event.type === "press" && event.button === "left") return { handled: true, focus: true, render: true };
    return undefined;
  }

  private parseValue(raw: string, type: string): unknown {
    if (type === "boolean") return raw === "true" || raw === "1";
    if (type === "number") { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
    return raw;
  }

  save(): void {
    if (this.edits.size === 0) return;
    this.keepCursorVisible = true;
    if (this.saveChanges(this.edits)) this.edits.clear();
    this.requestRender();
  }

  private saveChanges(changes: ReadonlyMap<string, unknown>): boolean {
    try {
      const obj = readUserConfig(this.dirs);
      for (const [path, value] of changes) {
        const keys = path.split(".");
        let current: Record<string, unknown> = obj;
        for (let i = 0; i < keys.length - 1; i++) {
          const key = keys[i]!;
          if (typeof current[key] !== "object" || current[key] === null || Array.isArray(current[key])) current[key] = {};
          current = current[key] as Record<string, unknown>;
        }
        current[keys.at(-1)!] = value;
      }
      writeUserConfig(obj, this.dirs);
      this.notice = "";
      return true;
    } catch (error) {
      const retry = this.draft?.type === "select" ? "Enter" : "s";
      this.notice = `Save failed. Retry ${retry}. ` + (error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}

export function openConfigPanel(ui: PanelUi, config: WardenConfig, options: { width?: string | number; dirs?: HostDirs } = {}): PanelController {
  let close: () => void = () => {};
  let unfocus: () => void = () => {};
  const closed = ui.custom<void>((tui, theme, _keybindings, done) => {
    close = () => done();
    const panel = new ConfigPanel(config, theme, { close, unfocus: () => unfocus() }, () => tui.requestRender(), options.dirs);
    const rows = tui.terminal?.rows;
    if (typeof rows === "number") panel.setViewport(rows - 2);
    return panel;
  }, {
    overlay: true,
    overlayOptions: { anchor: "right-center", width: options.width ?? "40%", minWidth: 44, maxHeight: "100%", nonCapturing: true },
    // A handle without `unfocus` belongs to a host whose overlays always capture input; close instead.
    onHandle: (handle: { unfocus?(): void }) => { unfocus = typeof handle.unfocus === "function" ? () => handle.unfocus!() : () => close(); },
  });
  return { closed, close: () => close() };
}
