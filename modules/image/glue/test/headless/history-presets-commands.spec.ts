// Image ADR 477's commands against the REAL canvas engine — the
// integration twin of history-presets.spec.ts. Snapshots and presets are
// the plugin's state: none of these commands may send the document
// anything, and a snapshot restores the real engine's pixels.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C, sourcePixels } from "../command-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}

describe("[image.editor.snapshots-presets] history and preset commands (plugin state, never the document)", () => {
  it("newSnapshot names the state; restoring it brings the pixels back as one undo step", async () => {
    covers("command:media.paged.image.command.newSnapshot");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await k.run(`${C}.newSnapshot`);
    const snaps = k.session.state().history!.snapshots;
    expect(snaps.map((s) => s.name)).toEqual(["Opened", "Snapshot 2"]);
    await k.run(`${C}.flipHorizontal`);
    expect((await sourcePixels(k.session)).px).not.toEqual(before.px);
    expect(await k.session.restoreSnapshot(snaps[1]!.id)).toBe(true);
    expect((await sourcePixels(k.session)).px).toEqual(before.px);
    expect(k.session.state().history!.undoSteps.at(-1)).toBe(
      "Restore Snapshot 2",
    );
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("historyOptions opens the dialog; the depth it sets reaches the engine", async () => {
    covers("command:media.paged.image.command.historyOptions");
    const k = await ingested();
    await k.run(`${C}.historyOptions`);
    expect(k.session.state().dialog).toEqual({ kind: "historyOptions" });
    k.session.setHistoryPrefs({ depth: 64 });
    expect(k.session.state().history!.maxEntries).toBe(64);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("presetManager opens the dialog on the brushes and sends nothing", async () => {
    covers("command:media.paged.image.command.presetManager");
    const k = await ingested();
    await k.run(`${C}.presetManager`);
    expect(k.session.state().dialog).toEqual({
      kind: "presetManager",
      tab: "brushes",
    });
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});
