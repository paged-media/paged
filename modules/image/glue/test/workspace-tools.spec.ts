// @feat: image.editor.workspace
//
// WP5.12 — the Ruler, Count, Note and Slice tools driven through the
// gesture DSL over their registered contributions (the frame is 200×100 pt
// holding 4×2 px: 50 pt per pixel, origin (0, 0)). Each completed gesture
// is one undo step in the image's history; none touches the document.

import { describe, expect, it } from "bun:test";

import { covers, gestures } from "@paged-media/test-kit";

import { bundleOnFake, C } from "./command-kit";
import { constrain45 } from "../src/workspace-tools";

const T = "media.paged.image.tool";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

const info = (k: K) => k.session.workspace().state().info;

describe("the workspace tools", () => {
  it("ruler: a drag measures a line, Shift keeps it to 45°, a click clears it", async () => {
    covers("tool:media.paged.image.tool.ruler");
    const k = await ingested();
    const g = gestures(k.toolTarget);
    await g
      .tool(`${T}.ruler`)
      .settle()
      .drag({ from: [0, 0], to: [150, 0] });
    await g.settle();
    expect(k.session.workspace().state().ruler).toEqual({
      from: [0, 0],
      to: [3, 0],
    });
    expect(k.session.workspace().rulerReadout()?.distance).toBe(3);
    // Not document state: no undo step, no document write.
    expect(k.session.state().history?.undoLabel ?? null).toBeNull();
    await g.click([50, 50]).settle();
    expect(k.session.workspace().state().ruler).toBeNull();
    expect(constrain45([0, 0], [10, 1])[1]).toBeCloseTo(0, 9);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("count: clicks number marks; a drag moves one; Alt-click removes it", async () => {
    covers("tool:media.paged.image.tool.count");
    const k = await ingested();
    const g = gestures(k.toolTarget);
    await g.tool(`${T}.count`).settle().click([25, 25]).settle();
    await g.click([125, 75]).settle();
    expect(info(k).counts[0]!.marks).toEqual([
      [0.5, 0.5],
      [2.5, 1.5],
    ]);
    expect(k.session.state().history?.undoLabel).toBe("Count");
    await g.drag({ from: [25, 25], to: [75, 25] }).settle();
    expect(info(k).counts[0]!.marks[0]).toEqual([1.5, 0.5]);
    await g.click([75, 25], { mods: ["alt"] }).settle();
    expect(info(k).counts[0]!.marks).toEqual([[2.5, 1.5]]);
    await k.run(`${C}.undo`);
    expect(info(k).counts[0]!.marks).toHaveLength(2);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("note: a click pins a note and raises the panel; Alt-click deletes it", async () => {
    covers("tool:media.paged.image.tool.note");
    const k = await ingested();
    const g = gestures(k.toolTarget);
    await g.tool(`${T}.note`).settle().click([60, 40]).settle();
    expect(info(k).notes).toEqual([{ at: [1.2, 0.8], author: "", text: "" }]);
    expect(k.opened).toContain("media.paged.image.panel.adjustments");
    await g.click([62, 42], { mods: ["alt"] }).settle();
    expect(info(k).notes).toEqual([]);
    k.dispose();
  });

  it("slice: a drag makes a whole-pixel slice; Alt-click inside deletes it", async () => {
    covers("tool:media.paged.image.tool.slice");
    const k = await ingested();
    const g = gestures(k.toolTarget);
    await g
      .tool(`${T}.slice`)
      .settle()
      .drag({ from: [10, 10], to: [140, 90] });
    await g.settle();
    expect(info(k).slices).toEqual([
      { x: 0, y: 0, w: 3, h: 2, name: "slice_01" },
    ]);
    expect(k.session.state().history?.undoLabel).toBe("Slice");
    await g.click([60, 40], { mods: ["alt"] }).settle();
    expect(info(k).slices).toEqual([]);
    k.dispose();
  });

  it("every image tool feeds the Info panel's pixel under the cursor", async () => {
    const k = await ingested();
    const g = gestures(k.toolTarget);
    await g.tool(`${T}.count`).settle();
    await g.move([175, 75]).settle();
    expect(k.session.workspace().state().cursor).toEqual({
      at: [3.5, 1.5],
      rgba: [0, 0, 200, 255],
    });
    k.dispose();
  });
});
