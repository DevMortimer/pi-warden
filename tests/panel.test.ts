import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigPanel, TracePanel, WARDEN_S1_CREDIT, openTracePanel, type PanelUi } from "../src/panel.js";
import { defaultConfig } from "../src/config.js";
import { Trace } from "../src/trace.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

/** A ui.custom that builds the component at once and hands the given overlay handle to onHandle. */
function panelUi(handle: Record<string, unknown>) {
  let component: { handleInput?(data: string): void } | undefined;
  const ui: PanelUi = {
    custom<T>(factory: Parameters<PanelUi["custom"]>[0], options?: Record<string, unknown>): Promise<T> {
      return new Promise<T>(resolve => {
        component = factory({ requestRender() {} }, theme, undefined, resolve as (result: unknown) => void);
        (options?.onHandle as ((handle: unknown) => void) | undefined)?.(handle);
      });
    },
  };
  return { ui, press: (data: string) => component?.handleInput?.(data) };
}

test("panel: escape releases focus and keeps the panel open when the overlay handle can unfocus", async () => {
  let unfocused = 0;
  const { ui, press } = panelUi({ unfocus: () => { unfocused++; } });
  const panel = openTracePanel(ui, new Trace());
  let closed = false;
  void panel.closed.then(() => { closed = true; });
  press("\x1b");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unfocused, 1);
  assert.equal(closed, false);
});

test("panel: escape closes the panel when the overlay handle has no unfocus", async () => {
  const { ui, press } = panelUi({ hide() {}, setHidden() {}, isHidden: () => false });
  const panel = openTracePanel(ui, new Trace());
  assert.doesNotThrow(() => press("\x1b"));
  await panel.closed;
});

test("config panel: renders muted maker credit footer when viewport >= 6 and omits it when viewport < 6", () => {
  const taggedTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text };
  const panel = new ConfigPanel(defaultConfig(), taggedTheme, { close() {}, unfocus() {} }, () => {}, undefined, {});

  panel.setViewport(20);
  const lines20 = panel.render(160);
  assert.equal(lines20.length, 20);
  assert.ok(lines20.at(-1)!.includes(`<dim>${WARDEN_S1_CREDIT}</dim>`), "default viewport renders dim maker credit footer");

  panel.setViewport(6);
  const lines6 = panel.render(160);
  assert.equal(lines6.length, 6);
  assert.ok(lines6.at(-1)!.includes(`<dim>${WARDEN_S1_CREDIT}</dim>`), "viewport=6 still renders dim maker credit footer");

  panel.setViewport(5);
  const lines5 = panel.render(160);
  assert.equal(lines5.length, 5);
  assert.equal(lines5.join("\n").includes(WARDEN_S1_CREDIT), false, "viewport=5 omits maker credit footer");
  assert.equal(lines5.join("\n").includes("@devmortimer"), false);
});

test("trace panel: never renders maker credit", () => {
  const panel = new TracePanel(new Trace(), theme, { close() {}, unfocus() {} }, () => {});
  panel.setViewport(20);
  const rendered = panel.render(160).join("\n");
  assert.equal(rendered.includes(WARDEN_S1_CREDIT), false);
  assert.equal(rendered.includes("@devmortimer"), false);
});
