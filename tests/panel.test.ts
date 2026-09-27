import assert from "node:assert/strict";
import { test } from "node:test";
import { openTracePanel, type PanelUi } from "../src/panel.js";
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
