// paged.image's TOOL OPTIONS (the host's tool-options bar,
// `tools.settings@1`): every field the six optioned tools declare, set
// the way the bar sets it (`inMemoryToolSettings`, the headless stand-in
// for the editor's store) and asserted where it lands — the session's
// brush, wand and gradient state, in the session's own units (the bar
// speaks percent, the brush 0..1). The bundle is loaded as the editor
// loads it; its tools are the registered contributions, so the declared
// field (its key, range and unit) is asserted from the contribution too.
//
// pencil and eraser share the brush's parameters (one brush engine, the
// tool picks the stroke's name), and the bucket shares the wand's
// tolerance and contiguity: setting either moves the shared state, which
// is what a user sees in the other tool's bar.

import { describe, expect, it } from "bun:test";

import type { ToolContribution } from "@paged-media/plugin-api";
import { inMemoryToolSettings } from "@paged-media/plugin-sdk";
import { covers, gestures } from "@paged-media/test-kit";

import { bundleOnFake } from "./command-kit";

const T = "media.paged.image.tool";

async function withSettings() {
  const settings = inMemoryToolSettings();
  const k = await bundleOnFake({ toolSettings: settings });
  await k.ingest();
  /** The field the registered tool declares for `key`. */
  const field = (tool: string, key: string) =>
    (
      k.fake.tools.get(`${T}.${tool}`) as unknown as ToolContribution
    ).options?.fields.find((f) => f.key === key);
  return { k, settings, field, state: () => k.session.state() };
}

describe("brush options", () => {
  it("brush · size, in px", async () => {
    covers("setting:media.paged.image.tool.brush.size");
    const { k, settings, field, state } = await withSettings();
    expect(field("brush", "size")).toMatchObject({
      kind: "number",
      min: 1,
      max: 2000,
      unit: "px",
    });
    settings.set(`${T}.brush`, "size", 40);
    expect(state().brush.size).toBe(40);
    // Below the range clamps to one pixel rather than a zero tip.
    settings.set(`${T}.brush`, "size", 0);
    expect(state().brush.size).toBe(1);
    k.dispose();
  });

  it("brush · hardness, percent → 0..1", async () => {
    covers("setting:media.paged.image.tool.brush.hardness");
    const { k, settings, field, state } = await withSettings();
    expect(field("brush", "hardness")).toMatchObject({ unit: "%", max: 100 });
    settings.set(`${T}.brush`, "hardness", 50);
    expect(state().brush.hardness).toBe(0.5);
    k.dispose();
  });

  it("brush · opacity, percent → 0..1", async () => {
    covers("setting:media.paged.image.tool.brush.opacity");
    const { k, settings, field, state } = await withSettings();
    expect(field("brush", "opacity")).toMatchObject({ unit: "%" });
    settings.set(`${T}.brush`, "opacity", 80);
    expect(state().brush.opacity).toBe(0.8);
    k.dispose();
  });

  it("brush · flow, percent → 0..1", async () => {
    covers("setting:media.paged.image.tool.brush.flow");
    const { k, settings, field, state } = await withSettings();
    expect(field("brush", "flow")).toMatchObject({ unit: "%" });
    settings.set(`${T}.brush`, "flow", 25);
    expect(state().brush.flow).toBe(0.25);
    // A mistyped value is ignored, not coerced.
    settings.set(`${T}.brush`, "flow", "lots");
    expect(state().brush.flow).toBe(0.25);
    k.dispose();
  });

  it("pencil · size moves the shared brush size", async () => {
    covers("setting:media.paged.image.tool.pencil.size");
    const { k, settings, field, state } = await withSettings();
    expect(field("pencil", "size")).toMatchObject({ unit: "px" });
    settings.set(`${T}.pencil`, "size", 7);
    expect(state().brush.size).toBe(7);
    k.dispose();
  });

  it("pencil · opacity moves the shared brush opacity", async () => {
    covers("setting:media.paged.image.tool.pencil.opacity");
    const { k, settings, field, state } = await withSettings();
    expect(field("pencil", "opacity")).toMatchObject({ unit: "%" });
    // The pencil declares no hardness: its tip is hard by definition.
    expect(field("pencil", "hardness")).toBeUndefined();
    settings.set(`${T}.pencil`, "opacity", 30);
    expect(state().brush.opacity).toBeCloseTo(0.3, 9);
    k.dispose();
  });

  it("eraser · size", async () => {
    covers("setting:media.paged.image.tool.eraser.size");
    const { k, settings, field, state } = await withSettings();
    expect(field("eraser", "size")).toMatchObject({ unit: "px" });
    settings.set(`${T}.eraser`, "size", 12);
    expect(state().brush.size).toBe(12);
    k.dispose();
  });

  it("eraser · hardness", async () => {
    covers("setting:media.paged.image.tool.eraser.hardness");
    const { k, settings, field, state } = await withSettings();
    expect(field("eraser", "hardness")).toMatchObject({ unit: "%" });
    settings.set(`${T}.eraser`, "hardness", 10);
    expect(state().brush.hardness).toBeCloseTo(0.1, 9);
    k.dispose();
  });

  it("eraser · opacity", async () => {
    covers("setting:media.paged.image.tool.eraser.opacity");
    const { k, settings, field, state } = await withSettings();
    expect(field("eraser", "opacity")).toMatchObject({ unit: "%" });
    settings.set(`${T}.eraser`, "opacity", 60);
    expect(state().brush.opacity).toBeCloseTo(0.6, 9);
    k.dispose();
  });
});

describe("wand and bucket options", () => {
  it("magic wand · tolerance: 255 lets one click select both colours", async () => {
    covers("setting:media.paged.image.tool.magicWand.tolerance");
    const { k, settings, field, state } = await withSettings();
    expect(field("magicWand", "tolerance")).toMatchObject({
      kind: "number",
      min: 0,
      max: 255,
    });
    // Default: a click on red selects the red half.
    const g = gestures(k.toolTarget).tool(`${T}.magicWand`).settle();
    await g.click([50, 50]).settle();
    expect(state().selection!.coverage).toBeCloseTo(0.5, 2);
    settings.set(`${T}.magicWand`, "tolerance", 255);
    expect(state().wand.tolerance).toBe(255);
    await g.click([50, 50]).settle();
    expect(state().selection!.coverage).toBeCloseTo(1, 2);
    k.dispose();
  });

  it("magic wand · contiguous, a toggle", async () => {
    covers("setting:media.paged.image.tool.magicWand.contiguous");
    const { k, settings, field, state } = await withSettings();
    expect(field("magicWand", "contiguous")).toMatchObject({ kind: "toggle" });
    settings.set(`${T}.magicWand`, "contiguous", false);
    expect(state().wand.contiguous).toBe(false);
    settings.set(`${T}.magicWand`, "contiguous", true);
    expect(state().wand.contiguous).toBe(true);
    k.dispose();
  });

  it("paint bucket · tolerance moves the shared wand tolerance", async () => {
    covers("setting:media.paged.image.tool.bucket.tolerance");
    const { k, settings, field, state } = await withSettings();
    expect(field("bucket", "tolerance")).toMatchObject({ max: 255 });
    settings.set(`${T}.bucket`, "tolerance", 9);
    expect(state().wand.tolerance).toBe(9);
    k.dispose();
  });

  it("paint bucket · contiguous", async () => {
    covers("setting:media.paged.image.tool.bucket.contiguous");
    const { k, settings, field, state } = await withSettings();
    expect(field("bucket", "contiguous")).toMatchObject({ kind: "toggle" });
    settings.set(`${T}.bucket`, "contiguous", false);
    expect(state().wand.contiguous).toBe(false);
    k.dispose();
  });
});

describe("gradient options", () => {
  it("gradient · kind: a known shape is taken, an unknown one ignored", async () => {
    covers("setting:media.paged.image.tool.gradient.kind");
    const { k, settings, field, state } = await withSettings();
    const f = field("gradient", "kind") as {
      kind: string;
      options: Array<{ value: string }>;
    };
    expect(f.kind).toBe("select");
    expect(f.options.map((o) => o.value)).toContain("radial");
    settings.set(`${T}.gradient`, "kind", "radial");
    expect(state().gradientKind).toBe("radial");
    settings.set(`${T}.gradient`, "kind", "spiral");
    expect(state().gradientKind).toBe("radial");
    k.dispose();
  });
});
