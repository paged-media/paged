/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The gesture DSL's BROWSER backend, proved against the running editor:
// real pointer events in document points through the live camera, at
// 25 / 100 / 400 %, model first (the document's dump), waiting on the
// editor going quiet rather than on timers; the universal invariants
// (one gesture = one undo step, exact undo/redo, Escape commits
// nothing); pen and touch through CDP; pinch as ctrl + wheel; rotated,
// grouped and locked targets; a recorded tape replayed.

import { expect, test } from "@playwright/test";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  checkCancel,
  checkUndoRedo,
  GESTURE_TARGETS as T,
  parseTape,
} from "@paged-media/test-kit";

import { cancelSandwich, modelSandwich, runGesture } from "./harness/gesture";
import {
  boxOf,
  browserModel,
  cornersOf,
  gestureEditor,
  idsOfKind,
  selectElements,
} from "./harness/gesture-kit";

const TAPE = fileURLToPath(
  new URL("./tapes/rectangle-frame-gridify.tape.json", import.meta.url),
);

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

test.describe("the gesture DSL in the browser", () => {
  for (const zoom of [0.25, 1, 4]) {
    test(`Rectangle drag at ${zoom * 100}%: one new frame where the document points say, one undo step @level:gesture`, async ({
      page,
    }) => {
      const { g } = await gestureEditor(page);
      await g.zoom(zoom).tool("paged.tool.rectangleFrame").settle();
      const before = await idsOfKind(page, "rectangle");
      const model = browserModel(page);
      const report = await checkUndoRedo(model, () =>
        g.drag({ from: [360, 560], to: [504, 632] }).settle(),
      );
      expect(report.changed).toBe(true);
      const fresh = (await idsOfKind(page, "rectangle")).filter(
        (id) => !before.includes(id),
      );
      expect(fresh).toHaveLength(1);
      const b = boxOf(
        (await cornersOf(page, { kind: "rectangle", id: fresh[0] }))!,
      );
      // One screen px of slack, in pt at this zoom.
      const tol = 1.5 / zoom;
      expect(
        near(b.left, 360, tol) &&
          near(b.top, 560, tol) &&
          near(b.right, 504, tol) &&
          near(b.bottom, 632, tol),
      ).toBe(true);
    });
  }

  test("Escape mid-drag commits nothing: the model is byte-identical (INV-2) @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.rectangle").settle();
    await checkCancel(browserModel(page), () =>
      g
        .drag({ from: [360, 560], to: [504, 632], release: false })
        .settle()
        .cancel()
        .up()
        .settle(),
    );
  });

  test("a recorded tape replays through the browser: the 3×2 gridify is six frames in ONE undo step @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    const tape = parseTape(readFileSync(TAPE, "utf8"));
    const before = (await idsOfKind(page, "rectangle")).length;
    const report = await checkUndoRedo(browserModel(page), () =>
      g.replay(tape).settle(),
    );
    expect(report.changed).toBe(true);
    expect((await idsOfKind(page, "rectangle")).length).toBe(
      before + Number(tape.expect?.rectangles),
    );
    // What the replay sent re-records as the same stream.
    expect(g.tape().samples.filter((x) => x.type !== "zoom")).toEqual(
      tape.samples,
    );
  });

  test("a PEN stroke (CDP, pointerType pen + pressure) reaches the Pencil with its pressure and commits one path @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.pencil").settle();
    const before = (await idsOfKind(page, "polygon")).length;
    const pressures: number[] = [];
    await page.exposeFunction(
      "__gestPressure",
      (p: number) => void pressures.push(p),
    );
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="viewport-canvas-host"]')!
        .addEventListener("pointermove", (e) => {
          const pe = e as PointerEvent;
          if (pe.pointerType === "pen")
            (
              globalThis as unknown as { __gestPressure(p: number): void }
            ).__gestPressure(pe.pressure);
        });
    });
    await g
      .drag({
        from: [360, 520],
        to: [520, 600],
        via: [[440, 540]],
        steps: 6,
        device: "pen",
        pressureAt: (i, n) => 0.2 + (0.7 * i) / n,
      })
      .settle();
    expect((await idsOfKind(page, "polygon")).length).toBe(before + 1);
    expect(pressures.length).toBeGreaterThan(3);
    expect(Math.max(...pressures)).toBeGreaterThan(0.6);
    const last = await page.evaluate(
      () =>
        (globalThis as unknown as { __canvasPointer?: { pointerType: string } })
          .__canvasPointer?.pointerType,
    );
    expect(last).toBe("pen");
  });

  test("a TOUCH drag (CDP) draws with the Rectangle tool @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.rectangleFrame").settle();
    const before = (await idsOfKind(page, "rectangle")).length;
    await g
      .drag({ from: [360, 560], to: [504, 632], device: "touch" })
      .settle();
    expect((await idsOfKind(page, "rectangle")).length).toBe(before + 1);
  });

  test("a pinch (ctrl + wheel) zooms about the cursor: the document point under it stays put (inverse round trip) @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    const at: [number, number] = [T.frame.at[0], T.frame.at[1]];
    /** Where `at` is on screen, and the zoom. */
    const onScreen = async () =>
      page.evaluate((p) => {
        const host = document
          .querySelector('[data-testid="viewport-canvas-host"]')!
          .getBoundingClientRect();
        const cam = (
          globalThis as unknown as {
            __canvas: {
              client: {
                camera: { read(): { scale: number; tx: number; ty: number } };
              };
            };
          }
        ).__canvas.client.camera.read();
        return {
          scale: cam.scale,
          x: host.left + p[0] * cam.scale + cam.tx,
          y: host.top + p[1] * cam.scale + cam.ty,
        };
      }, at);
    // The DSL's wheel moves the pointer onto `at` first, as a hand would.
    await g.hover(at).settle();
    const s0 = await onScreen();
    await g.wheel({ at, ctrl: true, deltaY: -120 }).settle();
    const s1 = await onScreen();
    expect(s1.scale).toBeGreaterThan(s0.scale * 1.5);
    // The document point the pinch was made over is still under the cursor.
    expect(Math.abs(s1.x - s0.x)).toBeLessThan(1);
    expect(Math.abs(s1.y - s0.y)).toBeLessThan(1);
  });

  test("Rotate tool on the ROTATED frame: one commit, exact undo/redo; the frame's centre stays (about its centroid) @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    await selectElements(page, [T.rotated.id]);
    await g.tool("paged.tool.rotate").settle();
    const c0 = boxOf((await cornersOf(page, T.rotated.id))!);
    const report = await checkUndoRedo(browserModel(page), () =>
      g.drag({ from: [260, 330], to: [250, 380] }).settle(),
    );
    expect(report.changed).toBe(true);
    const c1 = boxOf((await cornersOf(page, T.rotated.id))!);
    expect((c1.left + c1.right) / 2).toBeCloseTo((c0.left + c0.right) / 2, 0);
    expect((c1.top + c1.bottom) / 2).toBeCloseTo((c0.top + c0.bottom) / 2, 0);
  });

  test("Selection tool on a SELECTED group: the drag moves the whole group, one undo step @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.select").settle();
    await selectElements(page, [T.group.id]);
    const a0 = boxOf((await cornersOf(page, T.group.childA))!);
    const report = await checkUndoRedo(browserModel(page), () =>
      g
        .drag({
          from: T.group.at,
          to: [T.group.at[0] + 30, T.group.at[1] + 200],
        })
        .settle(),
    );
    expect(report.changed).toBe(true);
    const a1 = boxOf((await cornersOf(page, T.group.childA))!);
    // Snapping may pull the drop a few points; the child moved with the group.
    expect(a1.top - a0.top).toBeGreaterThan(150);
  });

  test("a LOCKED frame does not move under the Selection tool, selected or not @level:gesture", async ({
    page,
  }) => {
    const { g } = await gestureEditor(page);
    await g.tool("paged.tool.select").settle();
    await selectElements(page, [T.locked.id]);
    const report = await checkUndoRedo(browserModel(page), () =>
      g
        .drag({
          from: T.locked.at,
          to: [T.locked.at[0] + 60, T.locked.at[1] + 40],
        })
        .settle(),
    );
    expect(report.changed).toBe(false);
  });

  test("the worker gesture channel through the SAB lane, as the canvas streams it: exact undo/redo per kind @level:gesture", async ({
    page,
  }) => {
    await gestureEditor(page);
    const mods = { shift: false, alt: false, disableSnap: true };
    const steps = [
      [10, 4],
      [24, 9],
      [37, 15],
    ].map((d) => ({ delta: d as [number, number], mods }));
    const anchor = {
      pageId: T.pageId,
      pointInPage: [216, 172] as [number, number],
    };
    for (const spec of [
      { kind: "translate" },
      { kind: "resize", handle: "southEast" },
      { kind: "rotate" },
      { kind: "shear" },
    ] as const) {
      const report = await modelSandwich(
        page,
        () =>
          runGesture(page, [T.frame.id], spec, steps, { anchor, lane: "sab" }),
        spec.kind,
      );
      expect(report.changed, spec.kind).toBe(true);
      await cancelSandwich(
        page,
        () =>
          runGesture(page, [T.frame.id], spec, steps, {
            anchor,
            lane: "sab",
            commit: false,
          }),
        spec.kind,
      );
    }
  });
});
