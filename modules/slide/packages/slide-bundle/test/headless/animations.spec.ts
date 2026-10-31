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

// Animations on the real engine (the published canvas-wasm, headless) and
// the real slide wasm (slide ADR 714): import puts each slide's timing in
// its page label, naming the page items its shapes became; the typed
// commands add, retime, move, list and remove effects, one undo step each;
// the show gives an animated slide its build clicks and layers, the player
// evaluates them; export keeps an unchanged timing's bytes and writes an
// edited one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { BundleHost, ExporterContribution } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { ANIM_TYPED } from "../../src/anim/contribute";
import { pageShapes } from "../../src/anim/shapes";
import { slideEngine } from "../../src/engine";
import { attachAnimations, showSlides } from "../../src/show/contribute";
import { drawScene } from "../../src/show/scene-source";
import { parseState, type PluginMetadataEntry } from "../../src/slides-model";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));

const manifest = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
) as Parameters<HeadlessHost["loadBundle"]>[0]["manifest"];

// The show draws a layer per animated item, text frames included: the
// engine lays text out only with a font, as the editor gives it Inter.
const FONT = new Uint8Array(
  readFileSync(
    new URL(
      "../../../../../../engine/core/corpus/fonts/Inter.ttf",
      import.meta.url,
    ),
  ),
);

const hosts: HeadlessHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../../../slide-conformance/fixtures/${name}.pptx`,
        import.meta.url,
      ),
    ),
  );

async function open(name: string) {
  const bytes = fixture(name);
  // The page doors (the slides store needs them), as the editor's canvas
  // answers them.
  let active: string | null = null;
  const h = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    defaultFont: FONT,
    pages: {
      goToPage(pageId) {
        active = pageId;
        return true;
      },
      activePage: () => active,
      onDidChangeActivePage: () => () => {},
    },
  });
  hosts.push(h);
  let host!: BundleHost;
  h.loadBundle({
    manifest,
    activate(x) {
      host = x;
      return activate(x);
    },
  });
  const exporter = h.exportersContributed()[0] as ExporterContribution;
  const { paged, report } = (await slideEngine()).importPptx(
    bytes,
    `${name}.pptx`,
  );
  await h.load(paged);
  await keepSource(host, bytes, report);
  const pages = async () =>
    (
      await host.document.collection<{
        selfId: string;
        sizePt: [number, number];
        pluginMetadata?: PluginMetadataEntry[];
      }>("pages")
    ).map((p) => ({ ...p, state: parseState(p.pluginMetadata) }));
  return { h, host, exporter, bytes, pages };
}

describe("animations on the real engine (slide ADR 714) [plugin-slide.animations]", () => {
  it("import names each animated shape by the page item it became", async () => {
    const { host, pages } = await open("motion");
    const all = await pages();
    const builds = all[4];
    const timing = builds.state.timing!;
    expect(timing.nodes.length).toBe(1);
    const list = (await slideEngine()).effects(timing);
    expect(list.effects.map((e) => e.name)).toEqual([
      "Appear",
      "Fade",
      "Fade",
      "Appear",
    ]);
    expect(list.clicks).toBe(2);
    const shapes = (await pageShapes(host)).get(builds.selfId)!;
    for (const e of list.effects) {
      expect(e.target.key).toMatch(/^ppt\/slides\/slide5\.xml#\d+$/);
      const item = e.target.item!;
      expect(shapes.items.some((i) => i.id.id === item)).toBe(true);
    }
  });

  it("the typed commands add, retime, move, list and remove effects", async () => {
    covers(
      "command:media.paged.slide.addAnimation",
      "command:media.paged.slide.removeAnimation",
      "command:media.paged.slide.setAnimationTiming",
      "command:media.paged.slide.moveAnimation",
      "command:media.paged.slide.listAnimations",
    );
    const { h, host, pages } = await open("motion");
    const first = (await pages())[0];
    const shapes = (await pageShapes(host)).get(first.selfId)!;
    const shape = `${shapes.shapes[0].items[0].id.kind}:${shapes.shapes[0].items[0].id.id}`;
    const slide = first.selfId;
    const add = (await h.objects.invoke(ANIM_TYPED.add, {
      slide,
      shape,
      effect: "Fly In",
      direction: "From Left",
    })) as { index: number };
    expect(add.index).toBe(0);
    await h.objects.invoke(ANIM_TYPED.add, {
      slide,
      shape,
      effect: "Spin",
      start: "after",
    });
    await h.objects.invoke(ANIM_TYPED.timing, {
      slide,
      index: 0,
      durationMs: 1500,
    });
    let list = (await h.objects.invoke(ANIM_TYPED.list, { slide })) as {
      clicks: number;
      effects: { name: string; start: string; durationMs: number }[];
    };
    expect(list.effects.map((e) => [e.name, e.start])).toEqual([
      ["Fly In", "click"],
      ["Spin", "after"],
    ]);
    expect(list.effects[0].durationMs).toBe(1500);
    expect(list.clicks).toBe(1);
    await h.objects.invoke(ANIM_TYPED.move, { slide, from: 1, to: 0 });
    list = (await h.objects.invoke(ANIM_TYPED.list, { slide })) as typeof list;
    expect(list.effects[0].name).toBe("Spin");
    await h.objects.invoke(ANIM_TYPED.remove, { slide, index: 0 });
    await h.objects.invoke(ANIM_TYPED.remove, { slide, index: 0 });
    expect((await pages())[0].state.timing?.nodes).toEqual([]);
    covers("command:media.paged.slide.previewAnimations");
    // Preview needs the canvas's overlay; headless it starts and says so.
    await h.objects.invoke(ANIM_TYPED.preview, { slide });
    await expect(
      h.objects.invoke(ANIM_TYPED.add, {
        slide,
        shape,
        effect: "No Such Effect",
      }),
    ).rejects.toThrow(/no effect/);
  });

  it("the show plays the builds slide: two clicks, a layer per animated item, the player's states", async () => {
    const { host, pages } = await open("motion");
    const all = await pages();
    const slides = showSlides(
      all.map((p, i) => ({
        pageId: p.selfId,
        number: i + 1,
        sizePt: p.sizePt,
        state: p.state,
      })),
      null,
    );
    const engine = await slideEngine();
    await attachAnimations(
      host,
      engine,
      slides,
      new Map(all.map((p) => [p.selfId, p.state.timing])),
    );
    const builds = slides[4];
    expect(builds.clicks).toBe(2);
    expect(slides[0].anim).toBeUndefined();
    const plan = builds.anim!.plan;
    expect(plan.missing).toEqual([]);
    const animated = plan.entries.filter((e) => e.kind === "item");
    expect(animated.length).toBeGreaterThanOrEqual(4);
    // Bun has no createImageBitmap: decoded images are not what this
    // checks (the layers' regions and the player are).
    const g = globalThis as { createImageBitmap?: unknown };
    const had = g.createImageBitmap;
    g.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
    const scene = await drawScene(host, plan, 0.5, builds.sizePt);
    g.createImageBitmap = had;
    expect(scene).not.toBeNull();
    if (!scene) return;
    expect(scene.layers.filter((l) => l.target).length).toBe(animated.length);
    const player = engine.animPlayer({
      timing: builds.anim!.timing,
      slide: { w: builds.sizePt[0], h: builds.sizePt[1] },
      boxes: scene.boxes,
    });
    expect(player.clicks()).toBe(2);
    const before = player.evaluate([], 0);
    const hidden = Object.values(before.layers).filter((l) => !l.visible);
    expect(hidden.length).toBe(4);
    const after = player.evaluate([{ kind: "next", at: 0 }], 5000);
    expect(Object.values(after.layers).filter((l) => !l.visible).length).toBe(
      1,
    );
    player.free();
  });

  it("export keeps an unchanged timing's bytes and writes an edited one", async () => {
    covers("exporter:media.paged.slide.exporter.pptx");
    const { h, exporter, bytes, pages } = await open("motion");
    const unchanged = (await exporter.export()) as { bytes: Uint8Array };
    expect(unchanged.bytes).toEqual(bytes);
    const slide = (await pages())[4].selfId;
    await h.objects.invoke(ANIM_TYPED.remove, { slide, index: 3 });
    const edited = (await exporter.export()) as { bytes: Uint8Array };
    expect(edited.bytes).not.toEqual(bytes);
    const { report } = (await slideEngine()).importPptx(edited.bytes, "x.pptx");
    expect(report.slides[4].timingXml).toContain("p:timing");
    const list = (await slideEngine()).effects(
      (await pages())[4].state.timing!,
    );
    expect(list.effects.length).toBe(3);
  });
});
