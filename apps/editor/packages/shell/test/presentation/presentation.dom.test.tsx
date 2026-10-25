/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Editor ADRs 304–306 (extensions ADR 345): the presenter, the secondary
// window and module views, observed through the DOM.
//
//   · screen: one key-owning root over the editor's window, render gets
//     the "show" role, exit runs the cleanup and removes the root;
//   · secondary: the console in the editor's window and the audience in
//     the window the host opened, talking over their channel; a refused
//     window falls back to the console alone on the screen;
//   · window: a refused window is not presented;
//   · the chrome goes while a presentation fills the editor's window;
//   · a view replaces nothing it does not know, and a disposed view gives
//     the canvas back.

import { act, cleanup, render } from "@testing-library/react";
import { useEffect, type PropsWithChildren } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import type { PresentationContext } from "@paged-media/plugin-api";

import { PresentationChrome } from "../../src/cockpit/PresentationChrome";
import {
  createPresentationRegistry,
  PRESENTATION_ATTR,
} from "../../src/registries/presentation";
import { createViewRegistry } from "../../src/registries/view";
import {
  ChromeRegionsProvider,
  chromeRegionsOf,
  useChromeRegions,
} from "../../src/state/chrome-regions";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";

afterEach(() => {
  cleanup();
  for (const el of document.querySelectorAll(`[${PRESENTATION_ATTR}]`))
    el.remove();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A window the host "opened": its own document, closable. */
function fakePopup() {
  const doc = document.implementation.createHTMLDocument("popup");
  const listeners = new Map<string, () => void>();
  const popup = {
    document: doc,
    closed: false,
    close() {
      popup.closed = true;
    },
    addEventListener(type: string, fn: () => void) {
      listeners.set(type, fn);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
    fire(type: string) {
      listeners.get(type)?.();
    },
  };
  return popup;
}

function withOpen(open: () => unknown): Window {
  return new Proxy(window, {
    get(target, key) {
      if (key === "open") return open;
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Window;
}

describe("the presenter (editor ADR 304)", () => {
  test("screen: a key-owning root over the editor's window, gone on exit", async () => {
    const reg = createPresentationRegistry({ fullscreen: false });
    const seen: PresentationContext[] = [];
    let cleaned = 0;
    reg.register({
      id: "media.paged.test.show",
      title: "Show",
      render(el, ctx) {
        seen.push(ctx);
        el.textContent = "slide";
        return () => cleaned++;
      },
    });
    let changes = 0;
    reg.onChange(() => changes++);
    const out = await reg.present({
      id: "media.paged.test.show",
      target: "screen",
      options: { from: 2 },
    });
    expect(out).toEqual({ presented: true, target: "screen" });
    const root = document.querySelector(`[${PRESENTATION_ATTR}="show"]`)!;
    expect(root).not.toBeNull();
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(root);
    expect(seen[0].role).toBe("show");
    expect(seen[0].options).toEqual({ from: 2 });
    expect(reg.current()?.id).toBe("media.paged.test.show");
    expect(reg.inEditorWindow()).toBe(true);

    seen[0].exit();
    await tick();
    expect(cleaned).toBe(1);
    expect(document.querySelector(`[${PRESENTATION_ATTR}]`)).toBeNull();
    expect(reg.current()).toBeNull();
    expect(changes).toBe(2);
  });

  test("an unknown id is not presented; a disposed presentation ends", async () => {
    const reg = createPresentationRegistry({ fullscreen: false });
    expect((await reg.present({ id: "x.y", target: "screen" })).presented).toBe(
      false,
    );
    const d = reg.register({ id: "x.y", render() {} });
    await reg.present({ id: "x.y", target: "screen" });
    d.dispose();
    await tick();
    expect(reg.current()).toBeNull();
  });
});

describe("the secondary window (editor ADR 305)", () => {
  test("console in the editor's window, audience in the opened one, one channel", async () => {
    const popup = fakePopup();
    const reg = createPresentationRegistry({
      window: withOpen(() => popup),
      fullscreen: false,
    });
    expect(reg.secondary).toBe(true);
    const ctxs: PresentationContext[] = [];
    reg.register({
      id: "media.paged.test.show",
      render(el, ctx) {
        ctxs.push(ctx);
        el.dataset.role = ctx.role;
      },
    });
    const out = await reg.present({
      id: "media.paged.test.show",
      target: "secondary",
    });
    expect(out).toEqual({ presented: true, target: "secondary" });
    expect(ctxs.map((c) => c.role)).toEqual(["console", "audience"]);
    expect(
      popup.document.querySelector(`[${PRESENTATION_ATTR}="audience"]`),
    ).not.toBeNull();
    expect(
      document.querySelector(`[${PRESENTATION_ATTR}="console"]`),
    ).not.toBeNull();

    // The console's message reaches the audience, not itself.
    const got: unknown[] = [];
    const mine: unknown[] = [];
    ctxs[1].channel.onMessage((m) => got.push(m));
    ctxs[0].channel.onMessage((m) => mine.push(m));
    ctxs[0].channel.post({ slide: 3 });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([{ slide: 3 }]);
    expect(mine).toEqual([]);

    // Closing the audience window ends the presentation.
    popup.fire("pagehide");
    await tick();
    expect(reg.current()).toBeNull();
    expect(document.querySelector(`[${PRESENTATION_ATTR}]`)).toBeNull();
  });

  test("a refused window: the console alone on the screen; a window target is refused", async () => {
    const reg = createPresentationRegistry({
      window: withOpen(() => null),
      fullscreen: false,
    });
    const roles: string[] = [];
    reg.register({
      id: "media.paged.test.show",
      render: (_el, ctx) => void roles.push(`${ctx.role}@${ctx.target}`),
    });
    const out = await reg.present({
      id: "media.paged.test.show",
      target: "secondary",
    });
    expect(out.presented).toBe(true);
    expect(out.target).toBe("screen");
    expect(out.reason).toMatch(/audience window/);
    expect(roles).toEqual(["console@screen"]);
    await reg.exit();
    const w = await reg.present({
      id: "media.paged.test.show",
      target: "window",
    });
    expect(w.presented).toBe(false);
  });
});

function Furniture() {
  const chrome = useChromeRegions();
  return (
    <output data-testid="chrome">
      {`${chrome.has("right")}:${chrome.canvas.rulers}`}
    </output>
  );
}

type Registries = ReturnType<typeof useRegistries>;
function Grab({ onRegistries }: { onRegistries: (r: Registries) => void }) {
  const registries = useRegistries();
  useEffect(() => {
    onRegistries(registries);
  }, [onRegistries, registries]);
  return null;
}

function Providers({ children }: PropsWithChildren) {
  return (
    <RegistriesProvider getEditor={() => null}>
      <ChromeRegionsProvider value={chromeRegionsOf(undefined, undefined)}>
        {children}
      </ChromeRegionsProvider>
    </RegistriesProvider>
  );
}

describe("the chrome while presenting (editor ADR 304)", () => {
  test("a presentation in the editor's window hides the chrome until it ends", async () => {
    const grabbed: { current: Registries | null } = { current: null };
    const view = render(
      <Providers>
        <Grab onRegistries={(r) => (grabbed.current = r)} />
        <PresentationChrome />
        <Furniture />
      </Providers>,
    );
    const text = () => view.getByTestId("chrome").textContent;
    expect(text()).toBe("true:true");
    const reg = grabbed.current!.presentations;
    act(() => {
      reg.register({ id: "media.paged.test.show", render() {} });
    });
    await act(async () => {
      await reg.present({ id: "media.paged.test.show", target: "screen" });
    });
    expect(text()).toBe("false:false");
    await act(async () => {
      await reg.exit();
    });
    expect(text()).toBe("true:true");
  });
});

describe("module views (editor ADR 306)", () => {
  test("show a registered view, refuse an unknown one, give the canvas back on dispose", () => {
    const views = createViewRegistry();
    let changes = 0;
    views.onChange(() => changes++);
    const d = views.register({
      id: "media.paged.test.sorter",
      title: "Sorter",
      render: () => null,
    });
    expect(views.show("media.paged.test.nope")).toBe(false);
    expect(views.show("media.paged.test.sorter")).toBe(true);
    expect(views.show("media.paged.test.sorter")).toBe(false);
    expect(views.active()).toBe("media.paged.test.sorter");
    d.dispose();
    expect(views.active()).toBeNull();
    expect(changes).toBe(3);
  });
});
