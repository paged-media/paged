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

// Slide ADR 714 — playback: the show's build steps (an advance plays the
// slide's next click before it goes on; back undoes one; the slide before
// comes back built), the per-slide runtime that times clicks and shape
// clicks for the player (a fake player and clock here), and the filters'
// geometry and uniforms both compositors draw from.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  EFFECT_DIR,
  EFFECT_GENERATED,
  readShaderFiles,
  renderEffectsModule,
} from "../../scripts/gen-shaders.ts";

import type { PlayerEvent, PlayerFrame } from "../../src/anim/model";
import { LONG_AGO, SlideAnimation } from "../../src/show/animation";
import {
  FILTER_CODES,
  LAYER_UNIFORM_BYTES,
  EFFECT_SOURCES,
  filterCode,
  layerUniforms,
} from "../../src/show/effects/index";
import { filterClip } from "../../src/show/scene-2d";
import type { SlideScene } from "../../src/show/scene-source";
import { reduce, startShow, type ShowSlide } from "../../src/show/show-model";
import { ShowController } from "../../src/show/slide-show";

const slide = (n: number, clicks = 0): ShowSlide => ({
  pageId: `p${n}`,
  number: n,
  hidden: false,
  advanceAfterMs: null,
  transition: null,
  notes: "",
  sizePt: [960, 540],
  clicks,
});

describe("build steps in the show (slide ADR 714) [plugin-slide.animations]", () => {
  it("plays a slide's clicks before it advances, and undoes them going back", () => {
    let s = startShow([slide(1, 2), slide(2), slide(3, 1)]);
    const steps: [number, number][] = [];
    for (let i = 0; i < 5; i++) {
      steps.push([s.index, s.step]);
      s = reduce(s, { type: "next" });
    }
    expect(steps).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [2, 0],
    ]);
    expect([s.index, s.step]).toEqual([2, 1]);
    s = reduce(s, { type: "prev" });
    expect([s.index, s.step]).toEqual([2, 0]);
    s = reduce(s, { type: "prev" });
    expect([s.index, s.step]).toEqual([1, 0]);
    // The slide before comes back with its builds done.
    s = reduce(s, { type: "prev" });
    expect([s.index, s.step]).toEqual([0, 2]);
    // A jump starts the slide over.
    s = reduce(s, { type: "goto", index: 2 });
    expect([s.index, s.step]).toEqual([2, 0]);
    s = reduce(reduce(s, { type: "next" }), { type: "first" });
    expect([s.index, s.step]).toEqual([0, 0]);
  });

  it("sends the step and the trigger clicks to the audience, and forgets them on another slide", () => {
    const ctl = new ShowController({
      slides: [slide(1, 1), slide(2)],
      setTimeout: () => 0,
      clearTimeout: () => {},
      now: () => 0,
    });
    ctl.trigger("u7");
    ctl.dispatch({ type: "next" });
    expect(ctl.snapshot()).toMatchObject({ step: 1, triggers: ["u7"] });
    ctl.dispatch({ type: "next" });
    expect(ctl.snapshot()).toMatchObject({ index: 1, step: 0, triggers: [] });
  });
});

/** A player that answers what it was asked, and a box's state by it. */
function fakePlayer(clicks: number) {
  const asked: { events: PlayerEvent[]; now: number }[] = [];
  let freed = false;
  return {
    asked,
    freed: () => freed,
    player: {
      clicks: () => clicks,
      evaluate(events: readonly PlayerEvent[], now: number): PlayerFrame {
        asked.push({ events: [...events], now });
        const nexts = events.filter((e) => e.kind === "next");
        const last = nexts[nexts.length - 1];
        // The click's effect fades in over 1 s.
        const p = last ? Math.min(1, (now - last.at) / 1000) : 0;
        return {
          layers: {
            u1: {
              visible: nexts.length > 0,
              opacity: p,
              dx: 0,
              dy: 0,
              sx: 1,
              sy: 1,
              rot: 0,
            },
          },
          running: last !== undefined && p < 1,
          nextChange: null,
          commands: [],
        };
      },
      free: () => {
        freed = true;
      },
    },
  };
}

const scene = {
  pageId: "p1",
  scale: 1,
  sizePt: [960, 540],
  background: {} as ImageBitmap,
  layers: [
    {
      image: {} as ImageBitmap,
      region: { x: 10, y: 10, width: 100, height: 50 },
      target: "u1",
      part: "art",
    },
    {
      image: {} as ImageBitmap,
      region: { x: 0, y: 0, width: 960, height: 540 },
      target: null,
      part: null,
    },
  ],
  boxes: { u1: { x: 10, y: 10, w: 100, h: 50 } },
} as SlideScene;

describe("an animated slide's runtime (slide ADR 714) [plugin-slide.animations]", () => {
  it("times the clicks from when the slide came up and asks the player for each frame", () => {
    let now = 5000;
    const f = fakePlayer(2);
    const a = new SlideAnimation(f.player, scene, () => now);
    expect(a.clicks()).toBe(2);
    let d = a.draws();
    expect(d.states[0].visible).toBe(false);
    expect(d.states[1]).toMatchObject({ visible: true, opacity: 1 });
    now += 200;
    a.next();
    now += 500;
    d = a.draws();
    expect(d.running).toBe(true);
    expect(d.states[0].opacity).toBeCloseTo(0.5);
    expect(f.asked.at(-1)).toEqual({
      events: [{ kind: "next", at: 200 }],
      now: 700,
    });
    now += 1000;
    expect(a.draws().running).toBe(false);
    a.click("u9");
    expect(a.frame()).toBeDefined();
    expect(f.asked.length).toBe(4);
    expect(f.asked.at(-1)!.events.at(-1)).toEqual({
      kind: "click",
      at: 1700,
      target: "u9",
    });
    a.dispose();
    expect(f.freed()).toBe(true);
  });

  it("seeks: a step back or a jump shows the steps before it complete", () => {
    const f = fakePlayer(3);
    const a = new SlideAnimation(f.player, scene, () => 0, 2);
    expect(a.step()).toBe(2);
    a.frame();
    expect(f.asked[0].events).toEqual([
      { kind: "next", at: LONG_AGO },
      { kind: "next", at: LONG_AGO },
    ]);
    a.click("u9");
    a.seek(1);
    a.frame();
    expect(f.asked[1].events).toEqual([
      { kind: "next", at: LONG_AGO },
      { kind: "click", at: LONG_AGO, target: "u9" },
    ]);
  });
});

describe("animation filters (slide ADR 714) [plugin-slide.animations]", () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };
  const m = (
    filter: string,
    sub: string | null,
    progress: number,
    out = false,
  ) => ({
    filter,
    sub,
    progress,
    out,
    box,
  });

  it("ships the WGSL the effects directory holds (bun run gen:shaders)", () => {
    expect(readFileSync(EFFECT_GENERATED, "utf8")).toBe(
      renderEffectsModule(readShaderFiles(EFFECT_DIR)),
    );
  });

  it("maps PowerPoint's filters to the shader's codes", () => {
    expect(filterCode("wipe", "down")).toEqual({
      kind: FILTER_CODES.wipe,
      sub: 4,
    });
    expect(filterCode("wheel", "4")).toEqual({
      kind: FILTER_CODES.wheel,
      sub: 4,
    });
    expect(filterCode("barn", "outHorizontal")).toEqual({
      kind: FILTER_CODES.barn,
      sub: 4,
    });
    // An unknown filter still brings its target in, as a fade.
    expect(filterCode("pixelate", null)).toEqual({
      kind: FILTER_CODES.fade,
      sub: 0,
    });
    // Every code is a filter the shader knows.
    for (const name of Object.keys(FILTER_CODES))
      expect(EFFECT_SOURCES.layer).toContain(`// ${name}`);
  });

  it("packs a layer's uniforms as layer.wgsl reads them", () => {
    const u = layerUniforms(
      { x: 1, y: 2, width: 3, height: 4 },
      {
        visible: true,
        opacity: 0.5,
        matrix: [1, 0, 0, 1, 7, 8],
        masks: [m("wipe", "left", 0.25)],
        tint: "#ff8000",
      },
      [960, 540],
      3,
    );
    expect(u.byteLength).toBe(LAYER_UNIFORM_BYTES);
    expect([...u.slice(4, 6)]).toEqual([7, 8]);
    expect([...u.slice(8, 14)]).toEqual([1, 2, 3, 4, 960, 540]);
    expect([...u.slice(16, 20)]).toEqual([0.5, 1, 0, 3]);
    expect(u[20]).toBe(1);
    expect(u[21]).toBeCloseTo(128 / 255);
    expect([...u.slice(24, 28)]).toEqual([FILTER_CODES.wipe, 1, 0.25, 0]);
    expect([...u.slice(32, 36)]).toEqual([0, 0, 0, 0]);
    // Not shown: drawn at no opacity.
    expect(
      layerUniforms(
        { x: 0, y: 0, width: 1, height: 1 },
        {
          visible: false,
          opacity: 1,
          matrix: [1, 0, 0, 1, 0, 0],
          masks: [],
          tint: null,
        },
        [1, 1],
      )[16],
    ).toBe(0);
  });

  it("cuts the same areas on Canvas2D", () => {
    // Wipe from the left at 25 %: the left quarter.
    expect(filterClip(m("wipe", "left", 0.25)).polys).toEqual([
      [
        [0, 0],
        [25, 0],
        [25, 50],
        [0, 50],
      ],
    ]);
    // An exit takes that area away: the complement.
    expect(filterClip(m("wipe", "left", 0.25, true)).complement).toBe(true);
    // Fade is opacity.
    expect(filterClip(m("fade", null, 0.3)).alpha).toBeCloseTo(0.3);
    expect(filterClip(m("fade", null, 0.3, true)).alpha).toBeCloseTo(0.7);
    // Split vertical out: a centre band; in: two edge bands.
    expect(filterClip(m("barn", "outVertical", 0.5)).polys![0][0]).toEqual([
      25, 0,
    ]);
    expect(filterClip(m("barn", "inVertical", 0.5)).polys!.length).toBe(2);
    // Blinds: six slats; wheel(4): four pies; dissolve: about half the cells.
    expect(filterClip(m("blinds", "horizontal", 0.5)).polys!.length).toBe(6);
    expect(filterClip(m("wheel", "4", 0.5)).polys!.length).toBe(4);
    const cells = filterClip(m("dissolve", null, 0.5)).polys!.length;
    expect(cells).toBeGreaterThan(60);
    expect(cells).toBeLessThan(250);
    // Box in at progress 0 hides everything but nothing at 1.
    expect(filterClip(m("box", "in", 1)).polys![0][0]).toEqual([50, 25]);
    // Slide from the top moves the content down into place.
    expect(filterClip(m("slide", "fromTop", 0.5)).shift).toEqual([0, -25]);
    expect(filterClip(m("slide", "fromTop", 1)).shift[1]).toBeCloseTo(0);
  });
});
