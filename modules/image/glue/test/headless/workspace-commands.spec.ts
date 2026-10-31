// @feat: image.editor.workspace
//
// WP5.12 — the workspace commands on the headless host (the real canvas
// engine's document, the image placed in the minimal IDML's rectangle):
// the View menu's ruler units and guide verbs, slices, notes, count and
// the Ruler. None sends the document anything until the image is
// committed; a commit then carries the workspace with the layers.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C } from "../command-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

const ws = (k: K) => k.session.workspace();
const info = (k: K) => ws(k).state().info;

describe("the workspace commands, headless", () => {
  it("the ruler units follow the image's resolution", async () => {
    covers(
      "command:media.paged.image.command.rulerUnitPx",
      "command:media.paged.image.command.rulerUnitIn",
      "command:media.paged.image.command.rulerUnitCm",
      "command:media.paged.image.command.rulerUnitMm",
    );
    const k = await ingested();
    k.session.setResolution(100);
    await k.run(`${C}.rulerUnitIn`);
    expect(ws(k).state().view.rulerUnit).toBe("in");
    await k.run(`${C}.rulerUnitCm`);
    expect(ws(k).state().view.rulerUnit).toBe("cm");
    await k.run(`${C}.rulerUnitMm`);
    expect(ws(k).state().view.rulerUnit).toBe("mm");
    await k.run(`${C}.rulerUnitPx`);
    expect(ws(k).state().view.rulerUnit).toBe("px");
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("guides: show, lock, snap, new and clear", async () => {
    covers(
      "command:media.paged.image.command.toggleGuides",
      "command:media.paged.image.command.toggleLockGuides",
      "command:media.paged.image.command.toggleSnapGuides",
      "command:media.paged.image.command.newGuide",
      "command:media.paged.image.command.clearGuides",
    );
    const k = await ingested();
    await k.run(`${C}.newGuide`);
    expect(k.session.state().dialog).toEqual({ kind: "newGuide" });
    // The dialog's OK.
    expect(ws(k).addGuide("vertical", 2)).toBe(true);
    await k.run(`${C}.toggleGuides`);
    expect(ws(k).state().view.guidesVisible).toBe(false);
    await k.run(`${C}.toggleLockGuides`);
    expect(ws(k).state().view.guidesLocked).toBe(true);
    await k.run(`${C}.toggleSnapGuides`);
    expect(ws(k).state().view.snapToGuides).toBe(false);
    await k.run(`${C}.clearGuides`);
    expect(info(k).guides).toEqual([]);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("slices, notes and count, and the Ruler", async () => {
    covers(
      "command:media.paged.image.command.slicesFromGuides",
      "command:media.paged.image.command.clearSlices",
      "command:media.paged.image.command.exportSlices",
      "command:media.paged.image.command.clearNotes",
      "command:media.paged.image.command.clearCount",
      "command:media.paged.image.command.newCountGroup",
      "command:media.paged.image.command.straightenToRuler",
      "command:media.paged.image.command.clearRuler",
    );
    const k = await ingested();
    ws(k).addGuide("horizontal", 1);
    await k.run(`${C}.slicesFromGuides`);
    expect(info(k).slices.map((s) => [s.y, s.h])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    // The headless host saves nothing; the command says how many it saved.
    await k.run(`${C}.exportSlices`);
    expect(k.session.state().status).toMatch(/slices saved|cannot save/);
    await k.run(`${C}.clearSlices`);
    expect(info(k).slices).toEqual([]);
    ws(k).addNote([1, 1], "n");
    await k.run(`${C}.clearNotes`);
    expect(info(k).notes).toEqual([]);
    ws(k).addCount([1, 1]);
    await k.run(`${C}.newCountGroup`);
    expect(info(k).counts).toHaveLength(2);
    await k.run(`${C}.clearCount`);
    expect(info(k).counts[1]!.marks).toEqual([]);
    ws(k).setRuler({ from: [0, 0], to: [3, 0] });
    await k.run(`${C}.straightenToRuler`);
    expect(k.session.state().status).toMatch(/already straight/);
    await k.run(`${C}.clearRuler`);
    expect(ws(k).state().ruler).toBeNull();
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("a commit carries the workspace into the document", async () => {
    const k = await ingested();
    ws(k).addGuide("vertical", 1);
    await k.commit();
    expect(k.session.state().committedRev).toBe(1);
    expect(k.changes()).toBeGreaterThan(0);
    expect(info(k).guides).toEqual([{ orientation: "vertical", position: 1 }]);
    k.dispose();
  });
});
