import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Trace } from "./trace.js";

interface ThemeLike { fg(color: string, text: string): string; bold(text: string): string }

const LEVEL_COLOR: Record<string, string> = { allow: "success", ok: "success", warn: "warning", unverified: "warning", confirm: "error", stuck: "error", "false claim": "error" };

/**
 * Side panel listing the trace newest-first, live-updating while open. Keys: ↑/↓/j/k scroll a line, PgUp/PgDn a page,
 * Home/End jump, c clears the trace, Esc or q closes. Wheel scrolling works in fullscreen mode.
 */
export class TracePanel implements Component {
  focused = true;
  private scroll = 0;
  private viewport = 20;
  private readonly unsubscribe: () => void;

  constructor(private readonly trace: Trace, private readonly theme: ThemeLike, private readonly close: () => void, private readonly requestRender: () => void, private readonly title = "pi-warden trace") {
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
    out.push(theme.bold(theme.fg("accent", ` ${this.title}`)) + theme.fg("muted", ` · ${entries.length} event${entries.length === 1 ? "" : "s"} · ↑↓ PgUp PgDn scroll · c clear · esc close`));
    out.push(theme.fg("muted", "─".repeat(Math.max(0, width))));
    if (!entries.length) {
      out.push(theme.fg("muted", " No guarded activity yet this session. Verdicts, Jev scores, and what the agent was told will appear here."));
      return out.map(line => truncateToWidth(line, width, ""));
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      const status = entry.line.split(" · ").at(-1) ?? "";
      const color = LEVEL_COLOR[status] ?? "text";
      const head = `${theme.fg("muted", new Date(entry.at).toTimeString().slice(0, 8))} ${theme.fg(color, theme.bold(entry.guard.padEnd(6)))} `;
      const headWidth = 9 + 7;
      const body = wrapTextWithAnsi(theme.fg(color, entry.line), Math.max(10, width - headWidth));
      out.push(head + (body[0] ?? ""));
      for (const continuation of body.slice(1)) out.push(" ".repeat(headWidth) + continuation);
      for (const detail of entry.details) {
        const wrapped = wrapTextWithAnsi(detail, Math.max(10, width - headWidth - 2));
        for (const [n, line] of wrapped.entries()) out.push(" ".repeat(headWidth) + theme.fg("muted", n === 0 ? "· " : "  ") + theme.fg("dim", line));
      }
      out.push("");
    }
    return out.map(line => truncateToWidth(line, width, ""));
  }

  render(width: number): string[] {
    const all = this.lines(width);
    const maxScroll = Math.max(0, all.length - this.viewport);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const visible = all.slice(this.scroll, this.scroll + this.viewport);
    if (all.length > this.viewport) {
      const last = visible.length - 1;
      visible[last] = truncateToWidth(theme_fg(this.theme, "muted", ` … ${all.length - this.scroll - this.viewport > 0 ? `${all.length - this.scroll - this.viewport} more lines below` : "end"} · ${this.scroll} above`), width, "");
    }
    return visible;
  }

  /** The overlay tells us how tall we may be through the layout; fall back to a fixed viewport otherwise. */
  setViewport(rows: number): void {
    this.viewport = Math.max(5, rows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) { this.close(); return; }
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
    return undefined;
  }
}

function theme_fg(theme: ThemeLike, color: string, text: string): string {
  return theme.fg(color, text);
}

export interface PanelUi {
  custom<T>(factory: (tui: { requestRender(): void; terminal?: { rows: number } }, theme: ThemeLike, keybindings: unknown, done: (result: T) => void) => Component & { dispose?(): void }, options?: Record<string, unknown>): Promise<T>;
}

/** Open the trace as a right-hand overlay. Resolves when the user closes it. */
export function openTracePanel(ui: PanelUi, trace: Trace): Promise<void> {
  return ui.custom<void>((tui, theme, _keybindings, done) => {
    const panel = new TracePanel(trace, theme, () => done(), () => tui.requestRender());
    const rows = tui.terminal?.rows;
    if (typeof rows === "number") panel.setViewport(Math.floor(rows * 0.9) - 2);
    return panel;
  }, {
    overlay: true,
    overlayOptions: { anchor: "right-center", width: "48%", minWidth: 56, maxHeight: "90%", margin: { right: 1 } },
  });
}
