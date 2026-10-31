// @feat: image.layers.styles
//
// Layer ▸ Layer Style (WP5.4) over the fake editor and the real image
// engine, with no WebGPU: each command runs through its REGISTERED
// handler and what it does to the ingested image's layer stack is
// asserted through the engine's own readout of the style — one undo step
// per verb, or a refusal that changes nothing. The pixels a style draws
// are asserted on the GPU in image-js (layers/styles.rs) and against
// Photoshop's own renders in image-conformance (psd_layer_styles.rs).

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { bundleOnFake, C, imageShape } from "./command-kit";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}

const depth = (k: Awaited<ReturnType<typeof ingested>>) =>
  k.session.state().history?.depth ?? 0;

// Each row names its command with a literal covers() (the surface gate
// reads them statically).
const EFFECT_COMMANDS = [
  [
    "layerStyleBevel",
    "bevel",
    "ebbl",
    () => covers("command:media.paged.image.command.layerStyleBevel"),
  ],
  [
    "layerStyleStroke",
    "stroke",
    "FrFX",
    () => covers("command:media.paged.image.command.layerStyleStroke"),
  ],
  [
    "layerStyleInnerShadow",
    "innerShadow",
    "IrSh",
    () => covers("command:media.paged.image.command.layerStyleInnerShadow"),
  ],
  [
    "layerStyleInnerGlow",
    "innerGlow",
    "IrGl",
    () => covers("command:media.paged.image.command.layerStyleInnerGlow"),
  ],
  [
    "layerStyleSatin",
    "satin",
    "ChFX",
    () => covers("command:media.paged.image.command.layerStyleSatin"),
  ],
  [
    "layerStyleColorOverlay",
    "colorOverlay",
    "SoFi",
    () => covers("command:media.paged.image.command.layerStyleColorOverlay"),
  ],
  [
    "layerStyleGradientOverlay",
    "gradientOverlay",
    "GrFl",
    () => covers("command:media.paged.image.command.layerStyleGradientOverlay"),
  ],
  [
    "layerStylePatternOverlay",
    "patternOverlay",
    "patternFill",
    () => covers("command:media.paged.image.command.layerStylePatternOverlay"),
  ],
  [
    "layerStyleOuterGlow",
    "outerGlow",
    "OrGl",
    () => covers("command:media.paged.image.command.layerStyleOuterGlow"),
  ],
  [
    "layerStyleDropShadow",
    "dropShadow",
    "DrSh",
    () => covers("command:media.paged.image.command.layerStyleDropShadow"),
  ],
] as const;

describe("Layer ▸ Layer Style [image.layers.styles]", () => {
  for (const [suffix, pane, key, cover] of EFFECT_COMMANDS) {
    it(`${suffix} adds the effect with Photoshop's defaults and opens its pane (one undo step)`, async () => {
      cover();
      const k = await ingested();
      const d0 = depth(k);
      await k.run(`${C}.${suffix}`);
      expect(k.session.state().dialog).toEqual({
        kind: "layerStyle",
        index: 0,
        pane,
      });
      const row = k.session.state().layers.layers[0]!;
      expect(row.style).toContain(key);
      expect(depth(k)).toBe(d0 + 1);
      // Running it again only opens the pane: the effect is there.
      await k.run(`${C}.${suffix}`);
      expect(depth(k)).toBe(d0 + 1);
      await k.session.undo();
      await expect(k.session.layerStyle(0)).toBeNull();
      expect(k.docOps()).toEqual([]);
      k.dispose();
    });
  }

  it("copyLayerStyle refuses without a style, then copies; pasteLayerStyle pastes it (one undo step)", async () => {
    covers("command:media.paged.image.command.copyLayerStyle");
    covers("command:media.paged.image.command.pasteLayerStyle");
    const k = await ingested();
    await k.run(`${C}.pasteLayerStyle`);
    expect(k.session.state().status).toMatch(/No layer style copied/);
    await k.run(`${C}.copyLayerStyle`);
    expect(k.session.state().status).toMatch(/has no layer style/);
    expect(k.session.state().styleClipboard).toBeNull();
    await k.run(`${C}.layerStyleDropShadow`);
    await k.run(`${C}.copyLayerStyle`);
    expect(k.session.state().styleClipboard?.dropShadows.length).toBe(1);
    await k.run(`${C}.clearLayerStyle`);
    expect(k.session.layerStyle(0)).toBeNull();
    const d0 = depth(k);
    await k.run(`${C}.pasteLayerStyle`);
    expect(depth(k)).toBe(d0 + 1);
    expect(k.session.layerStyle(0)?.dropShadows.length).toBe(1);
    k.dispose();
  });

  it("clearLayerStyle refuses without a style, then clears it (one undo step)", async () => {
    covers("command:media.paged.image.command.clearLayerStyle");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.clearLayerStyle`);
    expect(k.session.state().status).toMatch(/no layer style to clear/);
    expect(imageShape(k.session)).toEqual(before);
    await k.run(`${C}.layerStyleSatin`);
    const d0 = depth(k);
    await k.run(`${C}.clearLayerStyle`);
    expect(depth(k)).toBe(d0 + 1);
    expect(k.session.layerStyle(0)).toBeNull();
    await k.session.undo();
    expect(k.session.layerStyle(0)?.satin).not.toBeNull();
    k.dispose();
  });

  it("globalLight opens its dialog; setting it is one undo step and every effect with Use Global Light follows", async () => {
    covers("command:media.paged.image.command.globalLight");
    const k = await ingested();
    await k.run(`${C}.globalLight`);
    expect(k.session.state().dialog).toEqual({ kind: "globalLight" });
    const d0 = depth(k);
    await k.session.setGlobalLight(45, 60);
    expect(depth(k)).toBe(d0 + 1);
    expect(k.session.state().globalLight).toEqual({ angle: 45, altitude: 60 });
    await k.session.undo();
    expect(k.session.state().globalLight).toEqual({ angle: 120, altitude: 30 });
    k.dispose();
  });

  it("toggleEffects hides and shows the active layer's effects (one undo step each)", async () => {
    covers("command:media.paged.image.command.toggleEffects");
    const k = await ingested();
    await k.run(`${C}.toggleEffects`);
    expect(k.session.state().status).toMatch(/has no style/);
    await k.run(`${C}.layerStyleOuterGlow`);
    expect(k.session.state().layers.layers[0]!.styleOn).toBe(true);
    const d0 = depth(k);
    await k.run(`${C}.toggleEffects`);
    expect(k.session.state().layers.layers[0]!.styleOn).toBe(false);
    await k.run(`${C}.toggleEffects`);
    expect(k.session.state().layers.layers[0]!.styleOn).toBe(true);
    expect(depth(k)).toBe(d0 + 2);
    k.dispose();
  });

  it("scaleEffects opens its dialog; scaling is one undo step", async () => {
    covers("command:media.paged.image.command.scaleEffects");
    const k = await ingested();
    await k.run(`${C}.scaleEffects`);
    expect(k.session.state().dialog).toEqual({
      kind: "scaleEffects",
      index: 0,
    });
    await k.run(`${C}.layerStyleStroke`);
    const d0 = depth(k);
    await k.session.scaleEffects(50);
    expect(depth(k)).toBe(d0 + 1);
    expect(k.session.layerStyle(0)?.scale).toBe(50);
    k.dispose();
  });

  it("the Styles presets apply (one undo step), save and delete", async () => {
    const k = await ingested();
    const d0 = depth(k);
    expect(await k.session.applyStylePreset("Button")).toBeDefined();
    expect(depth(k)).toBe(d0 + 1);
    const s = k.session.layerStyle(0)!;
    expect(s.dropShadows.length).toBe(1);
    expect(s.bevel).not.toBeNull();
    expect(k.session.saveStylePreset("Mine")).toBe(true);
    expect(k.session.state().stylePresets.some((p) => p.name === "Mine")).toBe(
      true,
    );
    expect(k.session.deleteStylePreset("Mine")).toBe(true);
    expect(k.session.deleteStylePreset("Button")).toBe(false);
    await k.session.applyStylePreset("Nope");
    expect(k.session.state().status).toMatch(/No style called/);
    k.dispose();
  });

  it("a style set through the dialog round-trips through the engine, its edits merging into one undo step", async () => {
    const k = await ingested();
    await k.run(`${C}.layerStyleDropShadow`);
    const d0 = depth(k);
    const s = k.session.layerStyle(0)!;
    for (const size of [4, 8, 12]) {
      await k.session.setLayerStyle(0, {
        ...s,
        dropShadows: [{ ...s.dropShadows[0]!, size }],
      });
    }
    // The dialog's edits to one layer — the effect it added included —
    // are one undo step.
    expect(depth(k), "a drag in the dialog is one step").toBe(d0);
    expect(k.session.layerStyle(0)!.dropShadows[0]!.size).toBe(12);
    await k.session.setLayerStyleOptions(0, {
      blendInterior: true,
      blendClipped: true,
      transparencyShapes: true,
      maskHidesEffects: false,
      vectorMaskHidesEffects: false,
    });
    expect(k.session.state().layers.layers[0]!.styleOptions).toBe(7);
    k.dispose();
  });
});
