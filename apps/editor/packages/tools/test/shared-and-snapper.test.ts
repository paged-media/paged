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

// The pure maths every drawing tool shares (shared.ts) as properties
// (fast-check, fixed seed), the graphic-default paint, the post-insert
// flow, and the host snapper (engine snap with the plugin-side
// fallback).

import { afterEach, describe, expect, it } from "bun:test";
import fc from "fast-check";

import {
  setViewToggle,
  type CanvasPointerEvent,
  type PagedEditor,
} from "@paged-media/shell";
import type { Mutation } from "@paged-media/client";

import {
  beginPageDrag,
  drawBoundsFor,
  endLocalFor,
  graphicPaintFor,
  gridCellsFor,
  mutateAndSelect,
  pxToPt,
  withGraphicPaint,
  INDESIGN_GRAPHIC_PAINT,
} from "../src/handlers/shared";
import {
  createHostSnapper,
  engineSnapPoint,
  snappingOn,
  SNAP_TOLERANCE_PX,
} from "../src/handlers/snapper";
import { harness } from "./support";

const RUNS = { numRuns: 200, seed: 0x9e57 };
const coord = fc.double({ min: -5000, max: 5000, noNaN: true });
const pt = fc.tuple(coord, coord);
const mods = fc.record({ shift: fc.boolean(), alt: fc.boolean() });

const event = (
  doc: [number, number],
  page: { origin: [number, number] } | null,
): CanvasPointerEvent => ({
  pageId: page ? "p" : null,
  pagePoint: page ? [doc[0] - page.origin[0], doc[1] - page.origin[1]] : null,
  docPoint: doc,
  modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
  maxDelta: 0,
  button: 0,
  target: null,
  pressure: 0.5,
  tiltX: 0,
  tiltY: 0,
  pointerType: "mouse",
});

describe("drawBoundsFor — the drag box every shape tool uses (DR-01…03), as properties", () => {
  it("is always normalised (top ≤ bottom, left ≤ right)", () => {
    fc.assert(
      fc.property(pt, pt, mods, (s, e, m) => {
        const [t, l, b, r] = drawBoundsFor(s, e, m);
        expect(t).toBeLessThanOrEqual(b);
        expect(l).toBeLessThanOrEqual(r);
      }),
      RUNS,
    );
  });

  it("plain: the box spans the press and the pointer (to float rounding)", () => {
    fc.assert(
      fc.property(pt, pt, (s, e) => {
        const got = drawBoundsFor(s, e, { shift: false, alt: false });
        const want = [
          Math.min(s[1], e[1]),
          Math.min(s[0], e[0]),
          Math.max(s[1], e[1]),
          Math.max(s[0], e[0]),
        ];
        got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
      }),
      RUNS,
    );
  });

  it("Shift keeps the aspect 1:1 on the larger extent, anchored at the press corner", () => {
    fc.assert(
      fc.property(pt, pt, (s, e) => {
        const [t, l, b, r] = drawBoundsFor(s, e, { shift: true, alt: false });
        const side = Math.max(Math.abs(e[0] - s[0]), Math.abs(e[1] - s[1]));
        expect(r - l).toBeCloseTo(side, 6);
        expect(b - t).toBeCloseTo(side, 6);
        expect([l, r]).toContainEqual(s[0]);
        expect([t, b]).toContainEqual(s[1]);
      }),
      RUNS,
    );
  });

  it("Alt draws from the centre: the press is the box's centre", () => {
    fc.assert(
      fc.property(pt, pt, fc.boolean(), (s, e, shift) => {
        const [t, l, b, r] = drawBoundsFor(s, e, { shift, alt: true });
        expect((l + r) / 2).toBeCloseTo(s[0], 6);
        expect((t + b) / 2).toBeCloseTo(s[1], 6);
      }),
      RUNS,
    );
  });

  it("INV-5: it is a pure function of the current sample (no latched state)", () => {
    fc.assert(
      fc.property(pt, pt, mods, (s, e, m) => {
        expect(drawBoundsFor(s, e, m)).toEqual(drawBoundsFor(s, e, m));
      }),
      RUNS,
    );
  });
});

describe("gridCellsFor — gridify (DR-05…07), as properties", () => {
  const box = fc
    .tuple(
      fc.double({ min: 0, max: 500, noNaN: true }),
      fc.double({ min: 0, max: 500, noNaN: true }),
      fc.double({ min: 1, max: 800, noNaN: true }),
      fc.double({ min: 1, max: 800, noNaN: true }),
    )
    .map(
      ([t, l, h, w]) =>
        [t, l, t + h, l + w] as [number, number, number, number],
    );

  it("cols × rows equal cells, row-major, inside the box, never inverted; 1×1 is the box itself", () => {
    fc.assert(
      fc.property(
        box,
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        fc.double({ min: 0, max: 24, noNaN: true }),
        (b, c, r, gutter) => {
          const cells = gridCellsFor(b, c, r, gutter);
          expect(cells).toHaveLength(c * r);
          if (c === 1 && r === 1) expect(cells[0]).toEqual(b);
          const w = cells[0][3] - cells[0][1];
          const h = cells[0][2] - cells[0][0];
          for (const [t, l, bb, rr] of cells) {
            expect(rr - l).toBeCloseTo(w, 6);
            expect(bb - t).toBeCloseTo(h, 6);
            expect(w).toBeGreaterThan(0);
            expect(t).toBeGreaterThanOrEqual(b[0] - 1e-6);
            expect(l).toBeGreaterThanOrEqual(b[1] - 1e-6);
            expect(bb).toBeLessThanOrEqual(b[2] + 1e-6);
            expect(rr).toBeLessThanOrEqual(b[3] + 1e-6);
          }
          // The last cell closes the box: the gutters eat into it, the envelope stays.
          expect(cells.at(-1)![2]).toBeCloseTo(b[2], 6);
          expect(cells.at(-1)![3]).toBeCloseTo(b[3], 6);
        },
      ),
      RUNS,
    );
  });
});

describe("the page-anchored drag: doc → page-local → doc is an exact round trip", () => {
  it("endLocalFor(beginPageDrag(press), e) = e.docPoint − the press page's origin, wherever e is", () => {
    fc.assert(
      fc.property(pt, pt, pt, (origin, press, later) => {
        const drag = beginPageDrag(
          event([origin[0] + press[0], origin[1] + press[1]], { origin }),
        )!;
        expect(drag.startLocal[0]).toBeCloseTo(press[0], 6);
        expect(drag.startLocal[1]).toBeCloseTo(press[1], 6);
        const local = endLocalFor(drag, event(later, null));
        expect(local[0] + drag.pageOrigin[0]).toBeCloseTo(later[0], 6);
        expect(local[1] + drag.pageOrigin[1]).toBeCloseTo(later[1], 6);
      }),
      RUNS,
    );
  });

  it("a press off the page or with another button anchors nothing", () => {
    expect(beginPageDrag(event([5, 5], null))).toBeNull();
    expect(
      beginPageDrag({ ...event([5, 5], { origin: [0, 0] }), button: 2 }),
    ).toBeNull();
  });
});

describe("the graphic default and the post-insert flow", () => {
  const insert: Mutation = {
    op: "insertOval",
    args: { pageId: "p", bounds: [0, 0, 1, 1] },
  };

  it("withGraphicPaint paints every shape a batch mints, right after its insert; a line never gets a fill", () => {
    const paint = {
      fill: "Color/Paper",
      stroke: "Color/Black",
      strokeWeight: 1,
    };
    const line: Mutation = {
      op: "insertLine",
      args: { pageId: "p", start: [0, 0], end: [1, 1] },
    };
    const out = withGraphicPaint(
      { op: "batch", args: { ops: [insert, line] } },
      paint,
    ) as { args: { ops: Mutation[] } };
    expect(
      out.args.ops.map((m) =>
        m.op === "setElementProperty"
          ? (m.args as { path: string }).path
          : m.op,
      ),
    ).toEqual([
      "insertOval",
      "frameFillColor",
      "frameStrokeColor",
      "frameStrokeWeight",
      "insertLine",
      "frameStrokeColor",
      "frameStrokeWeight",
    ]);
    expect(withGraphicPaint(insert, null)).toBe(insert);
    expect(
      withGraphicPaint({ op: "deletePage", args: { pageId: "p" } }, paint),
    ).toEqual({ op: "deletePage", args: { pageId: "p" } });
  });

  it("graphicPaintFor: InDesign's default without a style; null when the document has defaults", async () => {
    expect(await graphicPaintFor(harness().fake.shell.client as never)).toEqual(
      INDESIGN_GRAPHIC_PAINT,
    );
    expect(
      await graphicPaintFor(
        harness({ documentMeta: { defaultFillColor: "x" } }).fake.shell
          .client as never,
      ),
    ).toBeNull();
  });

  it("mutateAndSelect: a refusal reaches onRefused and selects nothing; a transport error resolves null", async () => {
    const { fake } = harness({ refuse: () => "nope" });
    const refused: unknown[] = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const reply = await mutateAndSelect(
        fake.shell as unknown as PagedEditor,
        insert,
        "t",
        (r) => refused.push(r),
      );
      expect(reply?.kind).toBe("mutationFailed");
      expect(refused).toHaveLength(1);
      expect(fake.ofChannel("selection")).toEqual([]);
      const broken = {
        ...fake.shell,
        client: {
          ...fake.shell.client,
          mutate: () => Promise.reject(new Error("gone")),
        },
      };
      expect(
        await mutateAndSelect(broken as unknown as PagedEditor, insert, "t"),
      ).toBeNull();
    } finally {
      console.warn = warn;
    }
  });

  it("pxToPt reads the LIVE camera (the zoom now, not the one the tool was picked at)", () => {
    const { fake } = harness({ zoom: 2 });
    const editor = fake.shell as unknown as PagedEditor;
    expect(pxToPt(editor, 6)).toBe(3);
    fake.setZoom(0.5);
    expect(pxToPt(editor, 6)).toBe(12);
  });
});

describe("the host snapper (RFI C-68)", () => {
  afterEach(() => setViewToggle("snapToPoints", true));

  const mouse = (cmd = false, shift = false) => ({
    ...event([0, 0], null),
    modifiers: { shift, alt: false, cmd, ctrl: false },
  });

  it("snapping is off while Cmd or Shift is held, and when View ▸ Snap to points is off", () => {
    expect(snappingOn({})).toBe(true);
    expect(snappingOn({ cmd: true })).toBe(false);
    expect(snappingOn({ shift: true })).toBe(false);
    setViewToggle("snapToPoints", false);
    expect(snappingOn({})).toBe(false);
  });

  it("engineSnapPoint: the engine's answer when it gives one; null for no answer, a zero tolerance or a throw", async () => {
    const answer = { point: [10, 20], snapped: true, tolerancePt: 3 };
    expect(
      await engineSnapPoint(
        async () => ({ kind: "snapPoint", payload: { result: answer } }),
        { pageId: "p", point: [9, 19], cameraScale: 1 },
      ),
    ).toEqual(answer);
    expect(
      await engineSnapPoint(async () => ({ kind: "warning" }), {
        pageId: "p",
        point: [0, 0],
        cameraScale: 1,
      }),
    ).toBeNull();
    expect(
      await engineSnapPoint(
        async () => ({
          kind: "snapPoint",
          payload: { result: { ...answer, tolerancePt: 0 } },
        }),
        { pageId: "p", point: [0, 0], cameraScale: 1 },
      ),
    ).toBeNull();
    expect(
      await engineSnapPoint(() => Promise.reject(new Error("x")), {
        pageId: "p",
        point: [0, 0],
        cameraScale: 1,
      }),
    ).toBeNull();
  });

  it("the fallback snaps to the page's corners, centre and edges within 6 screen px, and to the tool's own points", async () => {
    const { fake } = harness();
    const snapper = createHostSnapper(
      () => fake.shell as unknown as PagedEditor,
    );
    await snapper.prepare("page-1");
    // 1 pt per px: the page centre (306, 396) from 4 pt away.
    expect(snapper.snap([303, 393], mouse(), 1)).toEqual([306, 396]);
    expect(snapper.last()?.point).toEqual([306, 396]);
    // Out of reach at 100% (10 px) — in reach at 25% (2.5 px).
    expect(snapper.snap([296, 386], mouse(), 1)).toEqual([296, 386]);
    expect(snapper.snap([296, 386], mouse(), 4)).toEqual([306, 396]);
    expect(snapper.snap([152, 152], mouse(), 1, [[150, 150]])).toEqual([
      150, 150,
    ]);
    expect(snapper.snap([303, 393], mouse(true), 1)).toEqual([303, 393]);
    expect(SNAP_TOLERANCE_PX).toBe(6);
  });

  it("snapAsync uses the engine's resolver when it answers, the fallback when it does not", async () => {
    const engine = harness({
      reply: (m) =>
        m.kind === ("requestSnapPoint" as never)
          ? {
              kind: "snapPoint",
              payload: {
                result: { point: [1, 2], snapped: true, tolerancePt: 6 },
              },
            }
          : undefined,
    });
    const s1 = createHostSnapper(
      () => engine.fake.shell as unknown as PagedEditor,
    );
    expect(await s1.snapAsync("page-1", [100, 100], mouse(), 1)).toEqual([
      1, 2,
    ]);
    const asked = engine.fake
      .ofChannel("send")
      .find((e) => (e.message as { kind: string }).kind === "requestSnapPoint");
    expect(
      (asked?.message as { payload: { query: { cameraScale: number } } })
        .payload.query.cameraScale,
    ).toBe(1);
    const none = harness();
    const s2 = createHostSnapper(
      () => none.fake.shell as unknown as PagedEditor,
    );
    await s2.prepare("page-1");
    expect(await s2.snapAsync("page-1", [303, 393], mouse(), 1)).toEqual([
      306, 396,
    ]);
    s2.reset();
    expect(s2.last()).toBeNull();
  });
});
