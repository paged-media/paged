// The WP5.2 catalogue as data: every entry's schema is sound, the
// conversions the entries make (shear offsets, the Develop vector, the
// gallery stack, the blur steps) say what they mean, a chain is ONE
// landing with its intermediates freed, and the Blur Gallery's canvas
// geometry (draw, grab, drag) is right. No wasm, no GPU: a recording
// engine stands in where a run is needed.

import { describe, expect, it } from "bun:test";

import type { DecodedInfo, ImageEngine } from "../src/engine";
import {
  chain,
  FILTERS,
  filterDefaults,
  filterDef,
  GALLERY_EFFECTS,
  scaledForProxy,
  type FilterContext,
} from "../src/filters";
import { shearOffsets } from "../src/filters-families";
import {
  galleryLayers,
  galleryValues,
  type GalleryLayer,
} from "../src/filters-gallery";
import { blurPreset, blurSteps } from "../src/filters-blur-gallery";
import {
  DEVELOP_SETTINGS,
  developDefaults,
  developIsIdentity,
  developVector,
} from "../src/develop";
import { blurGalleryHit, blurGalleryShapes } from "../src/blur-gallery-pins";

const info = (handle: number): DecodedInfo => ({
  handle,
  width: 10,
  height: 10,
  display: "assumed-srgb",
  depthReduced: false,
});

/** An engine whose every door records its name and returns a new handle. */
function recordingEngine() {
  const calls: string[] = [];
  const freed: number[] = [];
  let next = 100;
  const engine = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "freeImage") return (h: number) => freed.push(h);
        if (prop === "filterSource")
          return (h: number) => {
            calls.push(`source:${h}`);
            return info(next++);
          };
        if (prop === "filterLand")
          return async (h: number, r: number) => {
            calls.push(`land:${h}<-${r}`);
            return info(h);
          };
        if (prop === "colorStats") return () => [50, 0, 0, 10, 5, 5];
        return async (h: number) => {
          calls.push(`${prop}:${h}`);
          return info(next++);
        };
      },
    },
  ) as ImageEngine;
  return { engine, calls, freed };
}

const ctx: FilterContext = {
  width: 200,
  height: 100,
  fg: [0, 0, 0],
  bg: [1, 1, 1],
  resource: () => 7,
};

describe("the catalogue [image.editor.filter-dialogs]", () => {
  it("ids are unique and every default lies inside its range", () => {
    const ids = FILTERS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FILTERS)
      for (const p of f.params) {
        if (p.kind !== "range") continue;
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
  });

  it("every Filter Gallery effect is in the workspace, Glowing edges too", () => {
    const ids = GALLERY_EFFECTS.map((d) => d.id);
    expect(ids).toContain("glowingEdges");
    expect(ids).toContain("watercolor");
    expect(ids).not.toContain("filterGallery");
    // Photoshop's gallery has 47 effects.
    expect(ids.length).toBe(47);
  });

  it("every entry runs at its defaults on the recording engine", async () => {
    for (const f of FILTERS) {
      const { engine, calls } = recordingEngine();
      await f.run(engine, 1, filterDefaults(f), ctx);
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it("a multi-step recipe is ONE landing, its intermediates freed", async () => {
    const { engine, calls, freed } = recordingEngine();
    const def = filterDef("watercolor");
    await def.run(engine, 1, filterDefaults(def), ctx);
    expect(calls[0]).toBe("source:1");
    expect(calls.at(-1)).toMatch(/^land:1<-/);
    expect(calls.filter((c) => c.startsWith("land")).length).toBe(1);
    // source + 3 kernels → 4 handles made, all freed.
    expect(freed.length).toBe(4);
  });

  it("a one-step chain runs directly on the image", async () => {
    const { engine, calls } = recordingEngine();
    await chain(engine, 3, [(h) => engine.applySolarize(h)]);
    expect(calls).toEqual(["applySolarize:3"]);
  });

  it("the proxy scales px lengths, Displace's percentages and pin blurs", () => {
    const d = filterDef("displace");
    expect(scaledForProxy(d, { sx: 10, sy: 20 }, 0.5)).toMatchObject({
      sx: 5,
      sy: 10,
    });
    const b = filterDef("blurGallery");
    const v = scaledForProxy(b, { fieldPins: [0.5, 0.5, 40] }, 0.25);
    expect(v.fieldPins).toEqual([0.5, 0.5, 10]);
  });
});

describe("conversions [image.editor.filter-dialogs]", () => {
  it("shear: five flat controls are a flat curve; one bend is smooth", () => {
    expect(shearOffsets([0, 0, 0, 0, 0])).toEqual(new Array(16).fill(0));
    const s = shearOffsets([0, 0, 40, 0, 0]);
    expect(s).toHaveLength(16);
    expect(s[0]).toBeCloseTo(0);
    expect(s[15]).toBeCloseTo(0);
    expect(Math.max(...s)).toBeGreaterThan(30);
  });

  it("develop: 61 settings, the defaults are the identity", () => {
    expect(DEVELOP_SETTINGS).toHaveLength(61);
    expect(developIsIdentity(developDefaults())).toBe(true);
    const v = developVector({ exposure: 1 });
    expect(v[2]).toBe(1);
    expect(developIsIdentity(v)).toBe(false);
  });

  it("gallery stack: layers round-trip through the flat values", () => {
    const layers: GalleryLayer[] = [
      { effect: "cutout" as const, visible: true, values: { levels: 5 } },
      { effect: "chrome" as const, visible: false, values: { detail: 2 } },
    ];
    const v = galleryValues(layers, GALLERY_EFFECTS);
    const back = galleryLayers(v, GALLERY_EFFECTS);
    expect(back.map((l) => [l.effect, l.visible])).toEqual([
      ["cutout", true],
      ["chrome", false],
    ]);
    expect(back[0]!.values.levels).toBe(5);
    expect(back[1]!.values.detail).toBe(2);
  });

  it("the gallery workspace runs only its visible layers, as one step", async () => {
    const { engine, calls } = recordingEngine();
    const def = filterDef("filterGallery");
    const v = galleryValues(
      [
        { effect: "chrome", visible: true, values: {} },
        { effect: "cutout", visible: false, values: {} },
      ],
      GALLERY_EFFECTS,
    );
    await def.run(engine, 1, v, ctx);
    expect(calls.some((c) => c.startsWith("galleryChrome"))).toBe(true);
    expect(calls.some((c) => c.startsWith("galleryPosterizeEdges"))).toBe(
      false,
    );
  });

  it("blur gallery: each switch adds its step; positions become px", async () => {
    const def = filterDef("blurGallery");
    const base = filterDefaults(def);
    const { engine } = recordingEngine();
    expect(
      blurSteps(engine, blurPreset(base, "field") as never, 200, 100),
    ).toHaveLength(1);
    const all = { ...base, iris: true, tilt: true, path: true, spin: true };
    expect(blurSteps(engine, all, 200, 100)).toHaveLength(5);
    const off = { ...base, field: false };
    await expect(def.run(engine, 1, off, ctx)).rejects.toThrow(/no blur/);
  });
});

describe("the Blur Gallery on the canvas [image.editor.filter-dialogs]", () => {
  const fit = { pageId: "p1", originX: 10, originY: 20, scale: 0.5 };
  const values = {
    field: true,
    fieldPins: [0.5, 0.5, 15],
    iris: true,
    irisX: 0.25,
    irisY: 0.5,
    irisRx: 0.1,
    irisRy: 0.1,
    irisRot: 0,
    irisFeather: 0.5,
  };

  it("draws a pin ring with its amount and the iris ellipses in page pt", () => {
    const shapes = blurGalleryShapes(values, 200, 100, fit);
    const texts = shapes.filter((s) => "kind" in s && s.kind === "text");
    expect(texts.map((s) => ("text" in s ? s.text : ""))).toContain("15 px");
    const polys = shapes.filter((s) => "points" in s);
    // pin ring + iris outer + core + centre + two axis handles
    expect(polys.length).toBe(6);
    const ring = polys[0]!;
    if (!("points" in ring)) throw new Error("not a polyline");
    const xs = ring.points.map((p) => p[0]);
    // the pin sits at image (100, 50) → page (60, 45)
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(60, 0);
  });

  it("drags a pin, places a new one on open canvas, Alt removes", () => {
    const grab = blurGalleryHit(values, 200, 100, [100, 50], false);
    expect(grab?.move([120, 60], 200, 100)).toEqual({
      fieldPins: [0.6, 0.6, 15],
    });
    const add = blurGalleryHit(values, 200, 100, [180, 90], false);
    expect(add?.move([180, 90], 200, 100)).toEqual({
      fieldPins: [0.5, 0.5, 15, 0.9, 0.9, 15],
    });
    const two = { ...values, fieldPins: [0.5, 0.5, 15, 0.9, 0.9, 15] };
    const del = blurGalleryHit(two, 200, 100, [180, 90], true);
    expect(del?.move([180, 90], 200, 100)).toEqual({
      fieldPins: [0.5, 0.5, 15],
    });
  });

  it("drags the iris centre and its x radius", () => {
    const centre = blurGalleryHit(values, 200, 100, [50, 50], false);
    expect(centre?.move([60, 40], 200, 100)).toEqual({
      irisX: 0.3,
      irisY: 0.4,
    });
    // x handle at centre + rx·span = 50 + 20
    const rim = blurGalleryHit(values, 200, 100, [70, 50], false);
    expect(rim?.move([90, 50], 200, 100)).toEqual({ irisRx: 0.2 });
  });

  it("with Field blur off a press on open canvas grabs nothing", () => {
    const v = { ...values, field: false };
    expect(blurGalleryHit(v, 200, 100, [180, 90], false)).toBeNull();
  });
});
