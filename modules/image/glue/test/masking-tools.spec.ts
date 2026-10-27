// The MAGNETIC LASSO and the REFINE EDGE brush (WP5.5, image ADR 470)
// through the gesture DSL: each tool is mounted from its REGISTERED
// contribution and driven with pointer samples in document points over
// the 4×2 two-colour image (200×100 pt, 50 pt per pixel). Plus the
// Magnetic Lasso's tool options, set the way the options bar sets them.

import { describe, expect, it } from "bun:test";

import type { ToolContribution } from "@paged-media/plugin-api";
import { inMemoryToolSettings } from "@paged-media/plugin-sdk";
import { covers, gestures } from "@paged-media/test-kit";

import { bundleOnFake } from "./command-kit";

const T = "media.paged.image.tool";

async function ingested(toolSettings = inMemoryToolSettings()) {
  const k = await bundleOnFake({ toolSettings });
  await k.ingest();
  return { k, settings: toolSettings };
}

const lastPreview = (k: Awaited<ReturnType<typeof ingested>>["k"]) =>
  k.fake.overlayShapes.filter((x) => x !== null).at(-1) as
    { dashed?: boolean; anchors?: unknown[] } | undefined;

describe("[image.selection.select-and-mask] the Magnetic Lasso", () => {
  it("clicks place anchors along the edge, Enter closes into one selection step; Escape abandons", async () => {
    covers("tool:media.paged.image.tool.magneticLasso");
    const { k } = await ingested();
    // At 100 % contrast no edge is strong enough to pull the wire, so on
    // this 4×2 image the outline follows the clicks (the edge-hugging
    // wire is image-js magnetic.rs's own test).
    k.session.masking().setMagneticOptions({ width: 1, contrast: 100 });
    const g = gestures(k.toolTarget).tool(`${T}.magneticLasso`).settle();
    // Abandoned: two anchors, then Escape — nothing selected.
    await g.click([10, 10]).click([90, 10]).key("Escape").settle();
    expect(k.session.state().selection).toBeNull();
    // Around the red half's corners, then Enter.
    await g
      .click([10, 10])
      .move([190, 10])
      .click([190, 10])
      .click([190, 90])
      .click([10, 90])
      .settle();
    expect(lastPreview(k)).toMatchObject({ dashed: true });
    await g.key("Enter").settle();
    const s = k.session.state().selection;
    expect(s).not.toBeNull();
    expect(s!.coverage).toBeGreaterThan(0);
    expect(k.session.state().history?.undoSteps.at(-1)).toBe("Magnetic Lasso");
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("its options reach the session: width, contrast and frequency", async () => {
    covers("setting:media.paged.image.tool.magneticLasso.width");
    covers("setting:media.paged.image.tool.magneticLasso.contrast");
    covers("setting:media.paged.image.tool.magneticLasso.frequency");
    const { k, settings } = await ingested();
    const field = (key: string) =>
      (
        k.fake.tools.get(`${T}.magneticLasso`) as unknown as ToolContribution
      ).options?.fields.find((f) => f.key === key);
    expect(field("width")).toMatchObject({ kind: "number", unit: "px" });
    expect(field("contrast")).toMatchObject({ kind: "number", unit: "%" });
    expect(field("frequency")).toMatchObject({ kind: "number", max: 100 });
    expect(k.session.masking().magneticOptions()).toEqual({
      width: 10,
      contrast: 10,
      frequency: 57,
    });
    settings.set(`${T}.magneticLasso`, "width", 24);
    settings.set(`${T}.magneticLasso`, "contrast", 30);
    settings.set(`${T}.magneticLasso`, "frequency", 80);
    expect(k.session.masking().magneticOptions()).toEqual({
      width: 24,
      contrast: 30,
      frequency: 80,
    });
    // A value of the wrong type is ignored, not coerced.
    settings.set(`${T}.magneticLasso`, "width", "wide");
    expect(k.session.masking().magneticOptions().width).toBe(24);
    k.dispose();
  });
});

describe("[image.selection.select-and-mask] the Refine Edge brush", () => {
  it("outside Select and Mask it says where it works; inside it marks the band", async () => {
    covers("tool:media.paged.image.tool.refineEdge");
    const { k } = await ingested();
    const g = gestures(k.toolTarget).tool(`${T}.refineEdge`).settle();
    await g.click([25, 25]).settle();
    expect(k.session.state().status).toContain("Select and Mask");
    // Select the red half and open the workspace.
    const machine = k.session.selectionMachine()!;
    machine.begin("rect", [0, 0], "replace");
    machine.update([2, 2]);
    machine.end();
    k.session.refreshSelection();
    expect(await k.session.masking().openRefine()).toBe(true);
    k.session.masking().setRefineBrush(1);
    const e = k.session.masking().engine()!;
    expect(e.samTrimap()[0]).toBe(255);
    await g.drag({ from: [25, 25], to: [30, 30] }).settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(e.samTrimap()[0]).toBe(128);
    // Alt erases the mark.
    await g.drag({ from: [25, 25], to: [30, 30], mods: ["alt"] }).settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(e.samTrimap()[0]).toBe(255);
    await k.session.masking().refineCancel();
    k.dispose();
  });
});
