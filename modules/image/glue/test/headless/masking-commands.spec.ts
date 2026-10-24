// SELECTION AND MASKING commands (WP5.5, image ADR 470) against the REAL
// canvas engine (the headless host): the integration twin of
// masking.spec.ts. Each command changes the image's selection, channels
// or paths and sends the DOCUMENT nothing; a channel saved in the session
// travels with the session's layer data when the image is committed, and
// the document's undo takes that commit back.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C } from "../command-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

const sel = (k: K) => {
  const s = k.session.state().selection;
  return s && [s.x, s.y, s.w, s.h];
};
const m = (k: K) => k.session.masking();

function selectLeft(k: K) {
  const machine = k.session.selectionMachine()!;
  machine.begin("rect", [0, 0], "replace");
  machine.update([2, 2]);
  machine.end();
  k.session.refreshSelection();
}

describe("[image.selection.select-and-mask] Select menu commands on the headless host", () => {
  it("colorRange opens the dialog and its OK selects; the document is untouched", async () => {
    covers("command:media.paged.image.command.colorRange");
    const k = await ingested();
    await k.run(`${C}.colorRange`);
    await m(k).sampleColorRange(3, 0, "replace");
    expect(await m(k).colorRangeOk()).toBe(true);
    expect(sel(k)).toEqual([2, 0, 2, 2]);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("grow and similar", async () => {
    covers("command:media.paged.image.command.grow");
    covers("command:media.paged.image.command.similar");
    const k = await ingested();
    const machine = k.session.selectionMachine()!;
    machine.begin("rect", [3, 1], "replace");
    machine.update([4, 2]);
    machine.end();
    await k.run(`${C}.grow`);
    expect(sel(k)).toEqual([2, 0, 2, 2]);
    await k.session.undo();
    await k.run(`${C}.similar`);
    expect(sel(k)).toEqual([2, 0, 2, 2]);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("focusArea opens its dialog", async () => {
    covers("command:media.paged.image.command.focusArea");
    const k = await ingested();
    await k.run(`${C}.focusArea`);
    expect(m(k).state().focusArea).not.toBeNull();
    expect(await m(k).focusAreaOk()).toBe(true);
    expect(k.session.state().selection).not.toBeNull();
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("quickMask toggles in and out", async () => {
    covers("command:media.paged.image.command.quickMask");
    const k = await ingested();
    selectLeft(k);
    await k.run(`${C}.quickMask`);
    expect(m(k).state().info.quickMask).not.toBeNull();
    await k.run(`${C}.quickMask`);
    expect(m(k).state().info.quickMask).toBeNull();
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("selectAndMask opens the workspace over the selection", async () => {
    covers("command:media.paged.image.command.selectAndMask");
    const k = await ingested();
    selectLeft(k);
    await k.run(`${C}.selectAndMask`);
    expect(m(k).state().refine).not.toBeNull();
    expect(await m(k).refineOk()).toBe(true);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("makeWorkPath stores a path in the session, not on the page", async () => {
    covers("command:media.paged.image.command.makeWorkPath");
    const k = await ingested();
    selectLeft(k);
    await k.run(`${C}.makeWorkPath`);
    expect(m(k).state().info.paths).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("saveSelection and loadSelection; the channel travels with the commit and the document undo takes it back", async () => {
    covers("command:media.paged.image.command.saveSelection");
    covers("command:media.paged.image.command.loadSelection");
    const k = await ingested();
    selectLeft(k);
    await k.run(`${C}.saveSelection`);
    expect(m(k).state().info.channels).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.session.deselect();
    await k.run(`${C}.loadSelection`);
    expect(m(k).loadSelectionOk()).toBe(true);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.changes()).toBe(0);
    // Commit: the layer record carries the channel.
    await k.commit();
    expect(k.session.state().committedRev).toBe(1);
    expect(k.changes()).toBeGreaterThan(0);
    await k.h.host.document.undo();
    const back = await k.framePixels();
    expect([back.w, back.h]).toEqual([4, 2]);
    k.dispose();
  });
});
