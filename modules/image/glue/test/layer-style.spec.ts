// @feat: image.layers.styles
//
// The layer-style MODEL as the bundle edits it (src/layer-style.ts): an
// effect switched on is added with Photoshop's defaults, switched off it
// stays (its settings kept), repeatable effects gain instances, the
// Blending Options switches round-trip through the engine's bits, and the
// built-in Styles presets each draw something.

import { describe, expect, it } from "bun:test";

import {
  EFFECT_KINDS,
  REPEATABLE,
  addInstance,
  builtInPresets,
  defaultShadow,
  effectEnabled,
  emptyStyle,
  firstEffect,
  hasEffect,
  setEffectEnabled,
  styleDraws,
  styleOptionsBits,
  styleOptionsFromBits,
  DEFAULT_STYLE_OPTIONS,
} from "../src/layer-style";

describe("the layer-style model [image.layers.styles]", () => {
  it("switching an effect on adds it with Photoshop's defaults; off keeps it", () => {
    for (const k of EFFECT_KINDS) {
      const on = setEffectEnabled(emptyStyle(), k, true);
      expect(hasEffect(on, k)).toBe(true);
      expect(effectEnabled(on, k)).toBe(true);
      const off = setEffectEnabled(on, k, false);
      expect(hasEffect(off, k)).toBe(true);
      expect(effectEnabled(off, k)).toBe(false);
      expect(effectEnabled(on, k), "the input is not changed").toBe(true);
    }
    const shadow = firstEffect(
      setEffectEnabled(emptyStyle(), "dropShadow", true),
      "dropShadow",
    );
    expect(shadow).toEqual(defaultShadow(false));
    expect(defaultShadow(false).knocksOut).toBe(true);
    expect(defaultShadow(true).knocksOut).toBe(false);
  });

  it("repeatable effects gain instances, the others are switched on", () => {
    for (const k of REPEATABLE) {
      const two = addInstance(addInstance(emptyStyle(), k), k);
      const lists = {
        dropShadow: two.dropShadows,
        innerShadow: two.innerShadows,
        colorOverlay: two.colorOverlays,
        gradientOverlay: two.gradientOverlays,
        stroke: two.strokes,
      } as Record<string, unknown[]>;
      expect(lists[k]?.length).toBe(2);
    }
    expect(addInstance(emptyStyle(), "satin").satin).not.toBeNull();
  });

  it("a style draws only with its master switch and an enabled effect", () => {
    expect(styleDraws(null)).toBe(false);
    expect(styleDraws(emptyStyle())).toBe(false);
    const s = setEffectEnabled(emptyStyle(), "stroke", true);
    expect(styleDraws(s)).toBe(true);
    expect(styleDraws({ ...s, enabled: false })).toBe(false);
  });

  it("Blending Options' switches round-trip through the engine's bits", () => {
    expect(styleOptionsBits(DEFAULT_STYLE_OPTIONS)).toBe(6);
    for (let b = 0; b < 32; b++) {
      expect(styleOptionsBits(styleOptionsFromBits(b))).toBe(b);
    }
  });

  it("every built-in preset draws, and none is editable away", () => {
    const presets = builtInPresets();
    expect(presets.length).toBeGreaterThanOrEqual(6);
    for (const p of presets) {
      expect(p.builtIn).toBe(true);
      expect(styleDraws(p.style)).toBe(true);
    }
  });
});
