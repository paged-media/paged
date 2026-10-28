// @feat: image.layers.styles
//
// The integration twin of layer-style-commands.spec.ts: Layer ▸ Layer
// Style against the REAL canvas engine (the headless host). Every verb
// acts on the image's own layer stack and history — each one undo step —
// and the DOCUMENT receives nothing until Commit; a style the stack
// carries is stored with the layers by Commit.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C } from "../command-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}

type K = Awaited<ReturnType<typeof ingested>>;
const depth = (k: K) => k.session.state().history?.depth ?? 0;

/** Run an effect command: it adds the effect (one undo step), opens its
 *  pane, and sends nothing to the document. */
async function addsEffect(suffix: string, pane: string, key: string) {
  const k = await ingested();
  const d0 = depth(k);
  await k.run(`${C}.${suffix}`);
  expect(k.session.state().dialog).toEqual({
    kind: "layerStyle",
    index: 0,
    pane,
  });
  expect(k.session.state().layers.layers[0]!.style).toContain(key);
  expect(depth(k)).toBe(d0 + 1);
  expect(k.changes()).toBe(0);
  k.dispose();
}

describe("Layer ▸ Layer Style over the real document [image.layers.styles]", () => {
  it("layerStyleBevel adds Bevel and Emboss", async () => {
    covers("command:media.paged.image.command.layerStyleBevel");
    await addsEffect("layerStyleBevel", "bevel", "ebbl");
  });
  it("layerStyleStroke adds a Stroke", async () => {
    covers("command:media.paged.image.command.layerStyleStroke");
    await addsEffect("layerStyleStroke", "stroke", "FrFX");
  });
  it("layerStyleInnerShadow adds an Inner Shadow", async () => {
    covers("command:media.paged.image.command.layerStyleInnerShadow");
    await addsEffect("layerStyleInnerShadow", "innerShadow", "IrSh");
  });
  it("layerStyleInnerGlow adds an Inner Glow", async () => {
    covers("command:media.paged.image.command.layerStyleInnerGlow");
    await addsEffect("layerStyleInnerGlow", "innerGlow", "IrGl");
  });
  it("layerStyleSatin adds a Satin", async () => {
    covers("command:media.paged.image.command.layerStyleSatin");
    await addsEffect("layerStyleSatin", "satin", "ChFX");
  });
  it("layerStyleColorOverlay adds a Color Overlay", async () => {
    covers("command:media.paged.image.command.layerStyleColorOverlay");
    await addsEffect("layerStyleColorOverlay", "colorOverlay", "SoFi");
  });
  it("layerStyleGradientOverlay adds a Gradient Overlay", async () => {
    covers("command:media.paged.image.command.layerStyleGradientOverlay");
    await addsEffect("layerStyleGradientOverlay", "gradientOverlay", "GrFl");
  });
  it("layerStylePatternOverlay adds a Pattern Overlay", async () => {
    covers("command:media.paged.image.command.layerStylePatternOverlay");
    await addsEffect(
      "layerStylePatternOverlay",
      "patternOverlay",
      "patternFill",
    );
  });
  it("layerStyleOuterGlow adds an Outer Glow", async () => {
    covers("command:media.paged.image.command.layerStyleOuterGlow");
    await addsEffect("layerStyleOuterGlow", "outerGlow", "OrGl");
  });
  it("layerStyleDropShadow adds a Drop Shadow", async () => {
    covers("command:media.paged.image.command.layerStyleDropShadow");
    await addsEffect("layerStyleDropShadow", "dropShadow", "DrSh");
  });

  it("copyLayerStyle, pasteLayerStyle and clearLayerStyle: each one undo step, nothing in the document", async () => {
    covers("command:media.paged.image.command.copyLayerStyle");
    covers("command:media.paged.image.command.pasteLayerStyle");
    covers("command:media.paged.image.command.clearLayerStyle");
    const k = await ingested();
    await k.run(`${C}.layerStyleSatin`);
    await k.run(`${C}.copyLayerStyle`);
    expect(k.session.state().styleClipboard?.satin).not.toBeNull();
    const d0 = depth(k);
    await k.run(`${C}.clearLayerStyle`);
    expect(k.session.layerStyle(0)).toBeNull();
    await k.run(`${C}.pasteLayerStyle`);
    expect(k.session.layerStyle(0)?.satin).not.toBeNull();
    expect(depth(k)).toBe(d0 + 2);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("globalLight opens its dialog; toggleEffects and scaleEffects act on the active layer's style", async () => {
    covers("command:media.paged.image.command.globalLight");
    covers("command:media.paged.image.command.toggleEffects");
    covers("command:media.paged.image.command.scaleEffects");
    const k = await ingested();
    await k.run(`${C}.globalLight`);
    expect(k.session.state().dialog).toEqual({ kind: "globalLight" });
    await k.run(`${C}.layerStyleDropShadow`);
    const d0 = depth(k);
    await k.run(`${C}.toggleEffects`);
    expect(k.session.state().layers.layers[0]!.styleOn).toBe(false);
    await k.run(`${C}.scaleEffects`);
    expect(k.session.state().dialog).toEqual({
      kind: "scaleEffects",
      index: 0,
    });
    await k.session.scaleEffects(200);
    expect(k.session.layerStyle(0)?.scale).toBe(200);
    expect(depth(k)).toBe(d0 + 2);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});
