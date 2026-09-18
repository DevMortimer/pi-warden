import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Trace } from "./trace.js";

interface ThemeLike { fg(color: string, text: string): string; bold(text: string): string }

const LEVEL_COLOR: Record<string, string> = { allow: "success", ok: "success", warn: "warning", unverified: "warning", nudged: "warning", confirm: "error", stuck: "error", "false claim": "error", stopped: "error", "stopped, recovering": "error", violation: "warning", skipped: "muted", wake: "warning", silent: "muted", "appended silently": "muted", "possible credentials": "warning", error: "error" };

/**
 * Body segments read as data, not prose: the subject (tool, path, agent) stays in the text tone, numeric values keep the
 * text tone, and the labels around them sit one step down in muted. Labels dim so the eye lands on what was measured.
 */
function renderSegment(segment: string, subject: boolean, theme: ThemeLike): string {
  if (subject) return theme.fg("text", segment);
  const value = /^(.+[ \t])([0-9][0-9.]*)$/.exec(segment);
  if (value) return theme.fg("muted", value[1]!) + theme.fg("text", value[2]!);
  return theme.fg("muted", segment);
}

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
    const { theme } = this;
    const entries = this.trace.entries();
    const out: string[] = [];
    const keys = this.focused ? "↑↓ PgUp PgDn scroll · c clear · esc back to editor · q close" : "click for keys · wheel scrolls · /warden trace closes";
    out.push(theme.bold(theme.fg("accent", `${this.title}`)) + theme.fg("muted", ` · ${entries.length} event${entries.length === 1 ? "" : "s"}`));
    out.push(theme.fg("muted", keys));
    out.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
    if (!entries.length) {
      for (const line of wrapTextWithAnsi(theme.fg("muted", "No guarded activity yet this session. Verdicts, Jev scores, and what the agent was told will appear here."), Math.max(10, width))) out.push(line);
      return out.map(line => truncateToWidth(line, width, ""));
    }
    // Left rail: time and guard label. The verdict leads the right column as a bold chip, so a scan down the pane reads
    // the decisions first and the evidence after.
    const RAIL = 16;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      const segments = entry.line.split(" · ");
      const last = segments.at(-1)!;
      const hasStatus = segments.length > 1 && LEVEL_COLOR[last] !== undefined;
      const status = hasStatus ? segments.pop()! : undefined;
      if (segments[0] === "warden") segments.shift();
      if (segments[0] === entry.guard) segments.shift();
      const color = LEVEL_COLOR[status ?? ""] ?? "text";
      const chip = status ? `${theme.bold(theme.fg(color, status.toUpperCase()))}  ` : "";
      const indent = RAIL + (status ? status.length + 2 : 0);
      const head = `${theme.fg("muted", new Date(entry.at).toTimeString().slice(0, 8))} ${theme.fg(color, theme.bold(entry.guard.padEnd(6)))} `;
      const body = segments.map((segment, n) => renderSegment(segment, n === 0, theme)).join(theme.fg("dim", " · "));
      const wrapped = wrapTextWithAnsi(body, Math.max(10, width - indent));
      out.push(head + chip + (wrapped[0] ?? ""));
      for (const continuation of wrapped.slice(1)) out.push(" ".repeat(indent) + continuation);
      for (const detail of entry.details) {
        const detailLines = wrapTextWithAnsi(detail, Math.max(10, width - RAIL - 2));
        for (const [n, line] of detailLines.entries()) out.push(" ".repeat(RAIL) + theme.fg("muted", n === 0 ? "· " : "  ") + theme.fg("dim", line));
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
 * transcript, so the sidebar covers the right part of the screen; `nonCapturing` keeps the editor focused.
 */
export function openTracePanel(ui: PanelUi, trace: Trace, options: { width?: string | number } = {}): PanelController {
  let close: () => void = () => {};
  let unfocus: () => void = () => {};
  const closed = ui.custom<void>((tui, theme, _keybindings, done) => {
    close = () => done();
    const panel = new TracePanel(trace, theme, { close, unfocus: () => unfocus() }, () => tui.requestRender());
    const rows = tui.terminal?.rows;
    if (typeof rows === "number") panel.setViewport(rows - 2);
    return panel;
  }, {
    overlay: true,
    overlayOptions: { anchor: "right-center", width: options.width ?? "40%", minWidth: 44, maxHeight: "100%", nonCapturing: true },
    onHandle: (handle: { unfocus(): void }) => { unfocus = () => handle.unfocus(); },
  });
  return { closed, close: () => close() };
}
