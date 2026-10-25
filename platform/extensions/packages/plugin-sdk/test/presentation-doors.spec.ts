/*
 * This file is part of paged (https://paged.media).
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

// Extensions ADR 345 / 346 — the presentation door (C1), module views
// (C5) and page layers (C2):
//
//   · a presentation and a view must be declared and namespaced; with a
//     registry they register (dispose removes them) and the dynamic flags
//     report the registry;
//   · a bundle presents and shows only its own; without a registry the
//     doors answer "nothing happened";
//   · the change events follow the registry;
//   · render.layers draws the background without the layered items and
//     each item alone, cropped, at one scale (real engine, headless);
//   · the harness wires a presenter and a view registry that keep state.

import { afterEach, describe, expect, it } from "bun:test";

import type {
  Disposable,
  ElementId,
  PagedBundle,
  PluginManifest,
  PresentationContribution,
  PresentationState,
  PresentRequest,
  ViewContribution,
} from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src/host-impl";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";
import { silentConsole as silent } from "../src/testing";

const ID = "media.paged.test";
const MANIFEST: PluginManifest = {
  id: ID,
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad" } },
  contributes: {
    presentations: [`${ID}.show`],
    views: [`${ID}.sorter`],
  },
};

const show: PresentationContribution = {
  id: `${ID}.show`,
  render: () => {},
};
const sorter: ViewContribution = {
  id: `${ID}.sorter`,
  title: "Sorter",
  render: () => null,
};

/** A fake editor with a presenter and a view registry that record. */
function withRegistries() {
  const fake = makeFakeEditor();
  const presentations: PresentationContribution[] = [];
  const views: ViewContribution[] = [];
  const requests: PresentRequest[] = [];
  let current: PresentationState | null = null;
  let active: string | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const on = (h: () => void): Disposable => {
    listeners.add(h);
    return { dispose: () => void listeners.delete(h) };
  };
  const registries = fake.editor.registries as unknown as Record<
    string,
    unknown
  >;
  registries.presentations = {
    secondary: true,
    register(c: PresentationContribution) {
      presentations.push(c);
      return {
        dispose: () => void presentations.splice(presentations.indexOf(c), 1),
      };
    },
    async present(r: PresentRequest) {
      requests.push(r);
      current = { id: r.id, target: r.target, options: r.options ?? {} };
      emit();
      return { presented: true, target: r.target };
    },
    async exit() {
      current = null;
      emit();
    },
    current: () => current,
    onChange: on,
  };
  registries.views = {
    register(c: ViewContribution) {
      views.push(c);
      return { dispose: () => void views.splice(views.indexOf(c), 1) };
    },
    show(id: string | null) {
      active = id;
      emit();
      return true;
    },
    active: () => active,
    onChange: on,
  };
  return {
    fake,
    presentations,
    views,
    requests,
    foreign(id: string) {
      current = { id, target: "screen", options: {} };
      emit();
    },
  };
}

describe("contribute.presentation + shell.present (extensions ADR 345) [plugin-platform.presentation]", () => {
  it("registers a declared presentation and presents only its own", async () => {
    const r = withRegistries();
    const { host } = createBundleHost(() => r.fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("contribute.presentation@1")).toBe(true);
    expect(host.supports("shell.present@1")).toBe(true);
    expect(host.supports("shell.present.secondary@1")).toBe(true);
    const seen: Array<string | null> = [];
    host.shell.onDidChangePresentation((s) => seen.push(s?.id ?? null));

    const d = host.contribute.presentation(show);
    expect(r.presentations).toEqual([show]);
    const out = await host.shell.present({
      id: show.id,
      target: "secondary",
      options: { from: 3 },
    });
    expect(out).toEqual({ presented: true, target: "secondary" });
    expect(r.requests).toEqual([
      { id: show.id, target: "secondary", options: { from: 3 } },
    ]);
    expect(host.shell.presentation()?.id).toBe(show.id);
    await host.shell.exitPresent();
    expect(host.shell.presentation()).toBeNull();
    expect(seen).toEqual([show.id, null]);

    await expect(
      host.shell.present({ id: `${ID}.other`, target: "screen" }),
    ).rejects.toThrow(/registered no presentation/);
    d.dispose();
    expect(r.presentations).toEqual([]);
  });

  it("exitPresent leaves another bundle's presentation alone", async () => {
    const r = withRegistries();
    const { host } = createBundleHost(() => r.fake.editor, MANIFEST, {
      console: silent,
    });
    host.contribute.presentation(show);
    r.foreign("media.paged.other.show");
    await host.shell.exitPresent();
    expect(host.shell.presentation()?.id).toBe("media.paged.other.show");
  });

  it("refuses an undeclared or foreign id", () => {
    const r = withRegistries();
    const { host } = createBundleHost(
      () => r.fake.editor,
      { ...MANIFEST, contributes: {} },
      { console: silent },
    );
    expect(() => host.contribute.presentation(show)).toThrow(
      PluginCapabilityError,
    );
    const { host: h2 } = createBundleHost(() => r.fake.editor, MANIFEST, {
      console: silent,
    });
    expect(() =>
      h2.contribute.presentation({ id: "media.paged.other.x", render() {} }),
    ).toThrow();
  });

  it("without a presenter: nothing registers, nothing is presented", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("shell.present@1")).toBe(false);
    host.contribute.presentation(show).dispose();
    expect(host.shell.presentation()).toBeNull();
    expect(host.shell.onDidChangePresentation(() => {})).toBeDefined();
  });
});

describe("contribute.view + shell.showView (extensions ADR 345, C5) [plugin-platform.module-views]", () => {
  it("shows its own view in place of the canvas and gives it back", () => {
    const r = withRegistries();
    const { host } = createBundleHost(() => r.fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("contribute.view@1")).toBe(true);
    expect(host.supports("shell.views@1")).toBe(true);
    const seen: Array<string | null> = [];
    host.shell.onDidChangeView((id) => seen.push(id));
    host.contribute.view(sorter);
    expect(r.views).toEqual([sorter]);
    expect(host.shell.showView(sorter.id)).toBe(true);
    expect(host.shell.activeView()).toBe(sorter.id);
    // Already shown: no change.
    expect(host.shell.showView(sorter.id)).toBe(false);
    expect(host.shell.showView(null)).toBe(true);
    expect(seen).toEqual([sorter.id, null]);
    expect(() => host.shell.showView(`${ID}.nope`)).toThrow(
      /registered no view/,
    );
  });

  it("without a registry: false and null", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("shell.views@1")).toBe(false);
    host.contribute.view(sorter).dispose();
    expect(host.shell.showView(sorter.id)).toBe(false);
    expect(host.shell.activeView()).toBeNull();
  });
});

const RECT = { kind: "rectangle", id: "urect" } as ElementId;

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

describe("host.render.layers (extensions ADR 346) [plugin-platform.render-snapshot-v2]", () => {
  it("draws the background without the layered item and the item alone, at one scale", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    expect(live.host.supports("render.layers@1")).toBe(true);

    const plain = (await live.host.render.layers(pageId, {
      scale: 0.5,
      format: "rgba",
    }))!;
    expect(plain.items).toEqual([]);
    expect(plain.scale).toBe(0.5);
    expect(plain.background.id).toBeNull();
    const bg = plain.background;
    expect(bg.rgba!.length).toBe(bg.widthPx * bg.heightPx * 4);
    expect(bg.region.x).toBe(0);
    expect(Math.abs(bg.region.width - bg.widthPx / 0.5)).toBeLessThan(1e-6);

    const split = (await live.host.render.layers(pageId, {
      items: [RECT],
      scale: 0.5,
      format: "rgba",
    }))!;
    expect(split.items.length).toBe(1);
    const item = split.items[0];
    expect(item.id).toEqual(RECT);
    expect(item.rgba!.length).toBe(item.widthPx * item.heightPx * 4);
    // Cropped to the item, and placed on the page.
    expect(item.widthPx).toBeLessThan(bg.widthPx);
    expect(item.region.x).toBeGreaterThan(0);
    // The background no longer draws the item: its pixels changed.
    expect(split.background.rgba).not.toEqual(bg.rgba);
    // An unknown page answers null.
    expect(await live.host.render.layers("nope", {})).toBeNull();
  });

  it("answers PNGs where there is no createImageBitmap", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    const out = (await live.host.render.layers(pageId, { scale: 0.25 }))!;
    if (typeof createImageBitmap === "function") {
      expect(out.background.bitmap).toBeDefined();
    } else {
      expect(out.background.png!.length).toBeGreaterThan(0);
    }
    await expect(
      live.host.render.layers(pageId, { scale: 100 }),
    ).rejects.toThrow(/dpi/);
  });

  it("asks the engine for the page as the exports draw it, never the canvas's markers", async () => {
    // The slide show's frames must not carry the editor's pink
    // substituted-font highlight: a snapshot without `markers` is drawn
    // as the exports draw it (engine ADR 205).
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    await host.render.layers("p1", { scale: 1, format: "png", items: [RECT] });
    const snaps = fake.sent.filter((m) => m.kind === "requestSnapshot");
    expect(snaps.length).toBeGreaterThan(0);
    for (const m of snaps)
      expect((m.payload as { markers?: boolean }).markers).toBeUndefined();
  });

  it("the harness presenter keeps the state of a presented bundle", async () => {
    live = await createHeadlessHost({ console: silent });
    const bundle: PagedBundle = {
      manifest: MANIFEST,
      activate(host) {
        host.contribute.presentation(show);
        host.contribute.view(sorter);
        return { dispose() {} };
      },
    };
    live.loadBundle(bundle);
    expect(live.presentationsContributed()).toEqual([show]);
    expect(live.viewsContributed()).toEqual([sorter]);
    expect(live.host.supports("shell.present@1")).toBe(true);
  });
});
