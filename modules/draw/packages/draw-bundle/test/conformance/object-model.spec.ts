/*
 * This file is part of paged (https://paged.media).
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

// THE OBJECT MODEL (ADR 323) against the REAL engine: paged.draw's kinds
// reached through the SHARED registry the headless host injects
// (`h.objects` — what the Node CLI, a Boa bridge and the editor call),
// with get / set / batch / undo round trips on real core.
//
// What each kind's WRITE is, and therefore what undo must do:
//   · `path`, `appearance`, `symbolInstance` — core-backed: the write is
//     engine mutations (framePath; the metadata stamp + the top-layer
//     bake; the per-leaf unlink), ONE batch ⇒ ONE undo step;
//   · `graphicStyle`, `symbol`, `pattern`, `repeat`, `blend`, `livePaint`,
//     `objectsOnPath` — plugin state: the label-hash pattern
//     (src/recipe-store.ts). A content-addressed part + the document
//     label naming it, in the registry's ONE commit. Undo reverts the
//     label and the library reads back as it was — the thing a recipe
//     write could never do before.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle, readGraphicStyleLibrary, readRepeatLibrary } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const D = "media.paged.draw";
const A = (kind: string, id: string) => `plugin:${D}/${kind}/${id}`;
const POLY = "polygon:upoly";
const RECT = "rectangle:urect";
const LINE = "graphicLine:uline";
const POLY_ID = { kind: "polygon", id: "upoly" } as ElementId;

const value = (v: { kind: string; value?: unknown }) => {
  expect(v.kind).toBe("value");
  return v.value;
};

const KINDS = [
  "path",
  "appearance",
  "graphicStyle",
  "symbol",
  "symbolInstance",
  "pattern",
  "repeat",
  "blend",
  "livePaint",
  "objectsOnPath",
];

describe("paged.draw — the object model (ADR 323) on a real engine", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("registers its ten kinds, every one with typed schema rows", async () => {
    const kinds = (await h.objects.kinds()).filter((k) => k.owner === D);
    expect(kinds.map((k) => k.kind).sort()).toEqual(
      KINDS.map((k) => `plugin:${D}/${k}`).sort(),
    );
    for (const k of KINDS) {
      const rows = await h.objects.schema(`plugin:${D}/${k}`);
      expect(rows.length, k).toBeGreaterThan(0);
    }
  });

  // ------------------------------------------------------------ path

  describe("path — geometry and points (core-backed: framePath)", () => {
    it("reads the anchor table the engine holds", async () => {
      const table = await h.host.document.pathAnchors(POLY_ID);
      const points = value(await h.objects.get(A("path", POLY), "points")) as unknown[];
      expect(points).toEqual(
        table!.anchors.map((a) => ({ anchor: a.anchor, left: a.left, right: a.right })),
      );
      expect(value(await h.objects.get(A("path", POLY), "pointCount"))).toBe(3);
      expect(value(await h.objects.get(A("path", POLY), "contourCount"))).toBe(1);
    });

    it("SET points = ONE undo step; undo restores the table", async () => {
      const before = value(await h.objects.get(A("path", POLY), "points")) as {
        anchor: [number, number];
        left: [number, number];
        right: [number, number];
      }[];
      const moved = before.map((p, i) =>
        i === 1
          ? {
              anchor: [p.anchor[0] + 10, p.anchor[1]] as [number, number],
              left: [p.left[0] + 10, p.left[1]] as [number, number],
              right: [p.right[0] + 10, p.right[1]] as [number, number],
            }
          : p,
      );
      const out = await h.objects.set(A("path", POLY), "points", moved);
      expect(out).toMatchObject({ applied: true, undoSteps: 1 });
      expect(value(await h.objects.get(A("path", POLY), "points"))).toEqual(moved);
      await h.host.document.undo();
      expect(value(await h.objects.get(A("path", POLY), "points"))).toEqual(before);
    });

    it("a derived path refuses a write, a malformed value is refused before planning", async () => {
      expect(await h.objects.set(A("path", POLY), "pointCount", 9)).toMatchObject({
        applied: false,
        code: "readOnly",
      });
      expect(await h.objects.set(A("path", POLY), "points", [{ anchor: [1, 2] }])).toMatchObject({
        applied: false,
        code: "invalidValue",
      });
    });

    it("query lists path-bearing items", async () => {
      const all = await h.objects.query(`plugin:${D}/path`);
      expect(all).toEqual(expect.arrayContaining([A("path", POLY), A("path", LINE)]));
    });
  });

  // ------------------------------------------------------ appearance

  describe("appearance — fills / strokes stack (core-backed: stamp + bake)", () => {
    const fills = [
      { color: "Color/Black", tint: 100, opacity: 100, blendMode: "Normal" },
      { color: "Color/Paper", tint: 50, opacity: 80, blendMode: "Multiply" },
    ];

    it("SET fills = ONE undo step: the stack lands AND the top layer bakes to the frame", async () => {
      const out = await h.objects.set(A("appearance", RECT), "fills", fills);
      expect(out).toMatchObject({ applied: true, undoSteps: 1 });
      expect(value(await h.objects.get(A("appearance", RECT), "fills"))).toEqual(fills);
      expect(value(await h.objects.get(RECT, "frameFillColor"))).toBe("Color/Paper");
      await h.host.document.undo();
      expect(value(await h.objects.get(A("appearance", RECT), "fills"))).toEqual([]);
      expect(value(await h.objects.get(RECT, "frameFillColor"))).toBe("Color/Black");
    });

    it("a blend mode outside the IDML set is refused by the schema", async () => {
      const bad = [{ color: "Color/Black", tint: 100, opacity: 100, blendMode: "Glow" }];
      expect(await h.objects.set(A("appearance", RECT), "fills", bad)).toMatchObject({
        applied: false,
        code: "invalidValue",
      });
    });
  });

  // -------------------------------------------- graphic styles (state)

  describe("graphicStyle — a library entry, written with the label-hash pattern", () => {
    let style = "";

    it("CREATE through a batch = ONE undo step, and the name selects it", async () => {
      const out = await h.objects.batch([
        {
          op: "create",
          kind: `plugin:${D}/graphicStyle`,
          props: {
            name: "Bold outline",
            strokes: [{ color: "Color/Black", weight: 4, opacity: 100, blendMode: "Normal" }],
          },
        },
      ]);
      expect(out).toMatchObject({ applied: true, undoSteps: 1 });
      const found = await h.objects.query(`plugin:${D}/graphicStyle[name="Bold outline"]`);
      expect(found).toHaveLength(1);
      style = found[0]!;
      expect(value(await h.objects.get(style, "baseStrokeWeight"))).toBe(4);
    });

    it("linking an element is an appearance write; editing the STYLE propagates in ONE undo step", async () => {
      expect(await h.objects.set(A("appearance", POLY), "graphicStyle", style)).toMatchObject({
        applied: true,
        undoSteps: 1,
      });
      expect(value(await h.objects.get(A("appearance", POLY), "graphicStyle"))).toBe(style);
      expect(value(await h.objects.get(A("appearance", POLY), "graphicStyleOverridden"))).toBe(false);
      expect(value(await h.objects.get(POLY, "frameStrokeWeight"))).toBe(4);

      const out = await h.objects.set(style, "strokes", [
        { color: "Color/Black", weight: 9, opacity: 100, blendMode: "Normal" },
      ]);
      expect(out).toMatchObject({ applied: true, undoSteps: 1 });
      expect(value(await h.objects.get(POLY, "frameStrokeWeight"))).toBe(9);
      expect(value(await h.objects.get(style, "linkedCount"))).toBe(1);

      // ONE undo brings back BOTH the library entry and the follower.
      await h.host.document.undo();
      expect(value(await h.objects.get(POLY, "frameStrokeWeight"))).toBe(4);
      expect(value(await h.objects.get(style, "baseStrokeWeight"))).toBe(4);
    });

    it("RENAME is undoable now (it was a container write nothing could undo)", async () => {
      expect(await h.objects.set(style, "name", "Heavy outline")).toMatchObject({
        applied: true,
        undoSteps: 1,
      });
      expect((await readGraphicStyleLibrary(h.host)).styles.map((s) => s.name)).toContain(
        "Heavy outline",
      );
      await h.host.document.undo();
      expect((await readGraphicStyleLibrary(h.host)).styles.map((s) => s.name)).toContain(
        "Bold outline",
      );
      // …and redo walks forward again.
      await h.host.document.redo();
      expect(value(await h.objects.get(style, "name"))).toBe("Heavy outline");
    });

    it("undoing the FIRST labelled write falls back to the library before it", async () => {
      // Undo: redo'd rename, the propagate is already undone, the link, the create.
      await h.host.document.undo(); // rename
      await h.host.document.undo(); // link
      await h.host.document.undo(); // create
      expect((await readGraphicStyleLibrary(h.host)).styles).toEqual([]);
      expect(await h.objects.query(`plugin:${D}/graphicStyle`)).toEqual([]);
    });
  });

  // ------------------------------------------------- recipes (state)

  describe("repeat — a typed command makes it, the object model edits its parameters", () => {
    it("typed makeRadialRepeat, then SET count = ONE undo step on the recipe", async () => {
      await h.objects.invoke(`${D}.command.makeRadialRepeat`, {
        targets: [POLY],
        name: "Ring",
      });
      const repeats = await h.objects.query(`plugin:${D}/repeat[name="Ring"]`);
      expect(repeats).toHaveLength(1);
      const ring = repeats[0]!;
      const count = value(await h.objects.get(ring, "count")) as number;
      expect(await h.objects.set(ring, "count", count + 2)).toMatchObject({
        applied: true,
        undoSteps: 1,
      });
      expect((await readRepeatLibrary(h.host)).repeats[0]!.params.count).toBe(count + 2);
      await h.host.document.undo();
      expect((await readRepeatLibrary(h.host)).repeats[0]!.params.count).toBe(count);
      expect(value(await h.objects.get(ring, "instances"))).not.toEqual([]);
    });

    it("two draw LIBRARIES in one batch are refused (they share the document label)", async () => {
      const [ring] = await h.objects.query(`plugin:${D}/repeat`);
      const out = await h.objects.batch([
        { op: "set", address: ring!, path: "name", value: "Ring 2" },
        { op: "create", kind: `plugin:${D}/graphicStyle`, props: { name: "x" } },
      ]);
      expect(out).toMatchObject({ applied: false });
      expect(out.reason).toMatch(/share the document label/);
    });
  });

  // ----------------------------------------------------------- batch

  it("a mixed batch — core paths, path points, appearance — is ONE undo step", async () => {
    const before = value(await h.objects.get(A("path", POLY), "points"));
    const out = await h.objects.batch([
      { op: "set", address: RECT, path: "frameStrokeWeight", value: 3 },
      { op: "set", address: A("appearance", LINE), path: "strokes", value: [
        { color: "Color/Black", weight: 2, opacity: 100, blendMode: "Normal" },
      ] },
      { op: "set", address: A("path", POLY), path: "subpathStarts", value: [] },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(value(await h.objects.get(RECT, "frameStrokeWeight"))).toBe(3);
    await h.host.document.undo();
    expect(value(await h.objects.get(A("appearance", LINE), "strokes"))).toEqual([]);
    expect(value(await h.objects.get(A("path", POLY), "points"))).toEqual(before);
  });

  // -------------------------------------------------- typed commands

  describe("typed commands (ADR 323) — the untyped handlers, with typed args", () => {
    it("every typed twin is listed with a struct args schema", async () => {
      const cmds = (await h.objects.commands()).filter((c) => c.owner === D);
      expect(cmds.length).toBeGreaterThanOrEqual(90);
      for (const c of cmds) expect(c.args.kind, c.id).toBe("struct");
    });

    it("insertArc runs with typed args and inserts a path", async () => {
      const before = (await h.objects.query(`plugin:${D}/path`)).length;
      await h.objects.invoke(`${D}.command.insertArc`, {
        cx: 300,
        cy: 300,
        rx: 50,
        ry: 50,
        startAngleDeg: 0,
        sweepDeg: 180,
        closed: false,
      });
      expect((await h.objects.query(`plugin:${D}/path`)).length).toBe(before + 1);
      await h.host.document.undo();
    });

    it("selectSameFill answers the selection it made", async () => {
      const got = (await h.objects.invoke(`${D}.command.selectSameFill`, {
        targets: [RECT],
      })) as string[];
      expect(got).toContain(RECT);
    });

    it("bad args are refused before the handler runs", async () => {
      await expect(
        h.objects.invoke(`${D}.command.insertArc`, { cx: "left" }),
      ).rejects.toThrow(/invalidValue/);
    });
  });
});
