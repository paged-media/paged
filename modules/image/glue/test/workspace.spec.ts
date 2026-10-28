// @feat: image.editor.workspace
//
// WP5.12 — the workspace (image ADR 474) over the fake editor and the real
// image engine: every View-menu verb as a command, one undo step per
// workspace change, the ruler units following the image's resolution,
// snapping, the Ruler's measurement and Straighten, and the binding
// provider's workspace and readout lanes (extensions ADR 3XX).

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnFake, C } from "./command-kit";
import {
  makeWorkspaceBindingProvider,
  measure,
  pxPerUnit,
  straightenAngle,
} from "../src/workspace";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

const ws = (k: K) => k.session.workspace();
const info = (k: K) => ws(k).state().info;
const undo = (k: K) => k.run(`${C}.undo`);

describe("the ruler units", () => {
  it("count pixels, or inches, centimetres and millimetres at the image's resolution", () => {
    expect(pxPerUnit("px", 300)).toBe(1);
    expect(pxPerUnit("in", 300)).toBe(300);
    expect(pxPerUnit("cm", 254)).toBeCloseTo(100, 9);
    expect(pxPerUnit("mm", 254)).toBeCloseTo(10, 9);
  });

  it("the four unit commands set what the rulers count in", async () => {
    covers(
      "command:media.paged.image.command.rulerUnitPx",
      "command:media.paged.image.command.rulerUnitIn",
      "command:media.paged.image.command.rulerUnitCm",
      "command:media.paged.image.command.rulerUnitMm",
    );
    const k = await ingested();
    await ws(k).refreshFit();
    k.session.setResolution(254);
    await k.run(`${C}.rulerUnitIn`);
    expect(ws(k).state().view.rulerUnit).toBe("in");
    expect(ws(k).workspace()?.unit).toEqual({ label: "in", basePerUnit: 254 });
    await k.run(`${C}.rulerUnitCm`);
    expect(ws(k).workspace()?.unit.basePerUnit).toBeCloseTo(100, 9);
    await k.run(`${C}.rulerUnitMm`);
    expect(ws(k).workspace()?.unit.label).toBe("mm");
    await k.run(`${C}.rulerUnitPx`);
    expect(ws(k).workspace()?.unit).toEqual({ label: "px", basePerUnit: 1 });
    // A view setting: no undo step, nothing sent to the document.
    expect(k.session.state().history?.undoLabel ?? null).toBeNull();
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

describe("guides", () => {
  it("add, move and delete are one undo step each, and undo brings them back", async () => {
    const k = await ingested();
    expect(ws(k).addGuide("vertical", 2)).toBe(true);
    expect(info(k).guides).toEqual([{ orientation: "vertical", position: 2 }]);
    expect(k.session.state().history?.undoLabel).toBe("New Guide");
    expect(ws(k).moveGuide(0, 3)).toBe(true);
    expect(info(k).guides[0]!.position).toBe(3);
    await undo(k);
    expect(info(k).guides[0]!.position).toBe(2);
    await undo(k);
    expect(info(k).guides).toEqual([]);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("Clear Guides removes every guide as one step; with none it says so", async () => {
    covers("command:media.paged.image.command.clearGuides");
    const k = await ingested();
    await k.run(`${C}.clearGuides`);
    expect(k.session.state().status).toMatch(/no guides/);
    ws(k).addGuide("vertical", 1);
    ws(k).addGuide("horizontal", 1);
    await k.run(`${C}.clearGuides`);
    expect(info(k).guides).toEqual([]);
    expect(k.session.state().history?.undoLabel).toBe("Clear Guides");
    await undo(k);
    expect(info(k).guides).toHaveLength(2);
    k.dispose();
  });

  it("Show, Lock and Snap to Guides toggle the session's view settings", async () => {
    covers(
      "command:media.paged.image.command.toggleGuides",
      "command:media.paged.image.command.toggleLockGuides",
      "command:media.paged.image.command.toggleSnapGuides",
    );
    const k = await ingested();
    await ws(k).refreshFit();
    ws(k).addGuide("vertical", 1);
    await k.run(`${C}.toggleGuides`);
    expect(ws(k).workspace()?.guidesVisible).toBe(false);
    await k.run(`${C}.toggleGuides`);
    expect(ws(k).workspace()?.guidesVisible).toBe(true);
    await k.run(`${C}.toggleLockGuides`);
    expect(ws(k).workspace()?.guidesLocked).toBe(true);
    // A locked guide neither moves nor goes.
    expect(ws(k).moveGuide(0, 2)).toBe(false);
    expect(ws(k).deleteGuide(0)).toBe(false);
    await k.run(`${C}.toggleLockGuides`);
    await k.run(`${C}.toggleSnapGuides`);
    expect(ws(k).state().view.snapToGuides).toBe(false);
    k.dispose();
  });

  it("New Guide… opens the dialog", async () => {
    covers("command:media.paged.image.command.newGuide");
    const k = await ingested();
    await k.run(`${C}.newGuide`);
    expect(k.session.state().dialog).toEqual({ kind: "newGuide" });
    expect(k.opened).toContain("media.paged.image.panel.adjustments");
    k.dispose();
  });
});

describe("snapping", () => {
  it("snaps to guides and edges within the tolerance, and to the host grid", async () => {
    const k = await ingested();
    await ws(k).refreshFit();
    // 50 pt per pixel at zoom 1: a 25 px tolerance is half an image pixel.
    ws(k).setHostView({
      showGrid: false,
      snapToGrid: false,
      gridEveryPt: 72,
      gridSubdivisions: 1,
      snapTolerancePx: 25,
    });
    ws(k).addGuide("vertical", 2);
    expect(ws(k).snap([2.4, 0.9])).toEqual([2, 0.9]);
    expect(ws(k).snap([0.3, 1.8])).toEqual([0, 2]);
    expect(ws(k).snap([3.4, 1.2])).toEqual([3.4, 1.2]);
    ws(k).setSnapToGuides(false);
    expect(ws(k).snap([2.4, 0.9])).toEqual([2.4, 0.9]);
    // The grid: every 72 pt at 72 ppi with 24 subdivisions is 3 px.
    ws(k).setHostView({
      showGrid: true,
      snapToGrid: true,
      gridEveryPt: 72,
      gridSubdivisions: 24,
      snapTolerancePx: 25,
    });
    expect(ws(k).snap([2.6, 0.2])).toEqual([3, 0]);
    k.dispose();
  });
});

describe("the Ruler", () => {
  it("measures distance and angle the way Photoshop's Info panel does", () => {
    const r = measure({ from: [0, 0], to: [3, -4] });
    expect(r.distance).toBe(5);
    expect(r.angle).toBeCloseTo(53.13, 2);
    expect(measure({ from: [0, 0], to: [-1, 0] }).angle).toBe(180);
    expect(straightenAngle({ from: [0, 0], to: [10, -1] })).toBeCloseTo(
      5.71,
      2,
    );
    expect(straightenAngle({ from: [0, 0], to: [1, -10] })).toBeCloseTo(
      -5.71,
      2,
    );
    expect(straightenAngle({ from: [0, 0], to: [10, 0] })).toBe(0);
  });

  it("Clear ruler and Straighten to ruler", async () => {
    covers(
      "command:media.paged.image.command.clearRuler",
      "command:media.paged.image.command.straightenToRuler",
    );
    const k = await ingested();
    await k.run(`${C}.straightenToRuler`);
    expect(k.session.state().status).toMatch(/Ruler tool/);
    ws(k).setRuler({ from: [0, 0], to: [4, 0] });
    await k.run(`${C}.straightenToRuler`);
    expect(k.session.state().status).toMatch(/already straight/);
    // A tilted line rotates the canvas by the turn that levels it.
    const turns: number[] = [];
    k.session.rotateCanvas = (d: number) => {
      turns.push(d);
      return Promise.resolve(true);
    };
    ws(k).setRuler({ from: [0, 0], to: [10, -1] });
    await k.run(`${C}.straightenToRuler`);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toBeCloseTo(5.71, 2);
    ws(k).setRuler({ from: [0, 0], to: [1, 1] });
    await k.run(`${C}.clearRuler`);
    expect(ws(k).state().ruler).toBeNull();
    k.dispose();
  });
});

describe("count, notes and slices", () => {
  it("count marks number per group; New Count Group and Clear Count", async () => {
    covers(
      "command:media.paged.image.command.newCountGroup",
      "command:media.paged.image.command.clearCount",
    );
    const k = await ingested();
    ws(k).addCount([1, 1]);
    ws(k).addCount([2, 1]);
    await k.run(`${C}.newCountGroup`);
    ws(k).addCount([3, 1]);
    expect(info(k).counts.map((g) => [g.name, g.marks.length])).toEqual([
      ["Count Group 1", 2],
      ["Count Group 2", 1],
    ]);
    await k.run(`${C}.clearCount`);
    expect(info(k).counts[1]!.marks).toEqual([]);
    await undo(k);
    expect(info(k).counts[1]!.marks).toHaveLength(1);
    k.dispose();
  });

  it("notes keep their text; Delete All Notes is one step", async () => {
    covers("command:media.paged.image.command.clearNotes");
    const k = await ingested();
    const i = ws(k).addNote([1, 1], "check the sky");
    expect(i).toBe(0);
    expect(ws(k).editNote(0, "check the sky again")).toBe(true);
    expect(info(k).notes[0]!.text).toBe("check the sky again");
    await k.run(`${C}.clearNotes`);
    expect(info(k).notes).toEqual([]);
    await undo(k);
    expect(info(k).notes).toHaveLength(1);
    k.dispose();
  });

  it("slices: from guides, export each as a PNG, delete all", async () => {
    covers(
      "command:media.paged.image.command.slicesFromGuides",
      "command:media.paged.image.command.exportSlices",
      "command:media.paged.image.command.clearSlices",
    );
    const saved: { suggestedName: string; bytes: Uint8Array }[] = [];
    const k = await bundleOnFake({
      shell: {
        saveFile: (o) => {
          saved.push(o);
          return Promise.resolve(true);
        },
      },
    });
    await k.ingest();
    ws(k).addGuide("vertical", 2);
    await k.run(`${C}.slicesFromGuides`);
    expect(info(k).slices.map((s) => [s.x, s.y, s.w, s.h])).toEqual([
      [0, 0, 2, 2],
      [2, 0, 2, 2],
    ]);
    await k.run(`${C}.exportSlices`);
    expect(saved.map((s) => s.suggestedName)).toEqual([
      expect.stringMatching(/_slice_01\.png$/),
      expect.stringMatching(/_slice_02\.png$/),
    ]);
    expect(Array.from(saved[0]!.bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    await k.run(`${C}.clearSlices`);
    expect(info(k).slices).toEqual([]);
    k.dispose();
  });
});

describe("the binding provider's workspace and readout lanes", () => {
  it("hands the host the frame, the unit and the guides, and takes guide edits back", async () => {
    const k = await ingested();
    await ws(k).refreshFit();
    const p = makeWorkspaceBindingProvider(() => ws(k));
    ws(k).addGuide("horizontal", 1);
    const read = await p.readWorkspace!();
    expect(read.kind).toBe("workspace");
    if (read.kind !== "workspace") return;
    // The 4×2 image fills the 200×100 pt frame: 50 pt per pixel.
    expect(read.workspace).toMatchObject({
      pageId: "pg1",
      origin: [0, 0],
      ptPerBase: 50,
      size: [4, 2],
      unit: { label: "px", basePerUnit: 1 },
      guides: [{ id: "g0", orientation: "horizontal", position: 1 }],
    });
    const created = await p.editGuide!({
      kind: "create",
      orientation: "vertical",
      position: 3,
    });
    expect(created.kind === "applied" && created.outcome.applied).toBe(true);
    await p.editGuide!({ kind: "move", id: "g0", position: 0 });
    expect(info(k).guides).toEqual([
      { orientation: "horizontal", position: 0 },
      { orientation: "vertical", position: 3 },
    ]);
    await p.editGuide!({ kind: "delete", id: "g1" });
    expect(info(k).guides).toHaveLength(1);
    const unknown = await p.editGuide!({ kind: "delete", id: "g9" });
    expect(unknown.kind === "applied" && unknown.outcome.applied).toBe(false);
    k.dispose();
  });

  it("readouts: the pixel under the cursor, the Ruler and the count", async () => {
    const k = await ingested();
    await ws(k).refreshFit();
    const p = makeWorkspaceBindingProvider(() => ws(k));
    // Page (25, 25) is pixel (0, 0) — red.
    ws(k).setCursor([25, 25]);
    ws(k).setRuler({ from: [0, 0], to: [3, 0] });
    ws(k).addCount([1, 1]);
    const r = await p.readReadouts!({ surface: "info" });
    expect(r.kind).toBe("readouts");
    if (r.kind !== "readouts") return;
    const rows = Object.fromEntries(
      r.sections[0]!.rows.map((x) => [x.id, x.value]),
    );
    expect(rows["Image X"]).toBe("0.5 px");
    expect(rows["Image RGB"]).toBe("200 0 0");
    expect(rows["Ruler distance"]).toBe("3 px");
    expect(rows["Ruler angle"]).toBe("0°");
    expect(rows.Count).toBe("1 (Count Group 1)");
    ws(k).setCursor([999, 999]);
    expect(ws(k).state().cursor).toBeNull();
    k.dispose();
  });
});
