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

// CREATE OUTLINES (protocol 66, RFI C-69). Pins:
//   (1) the pure batch — one compound path per colour, inserted as its
//       FIRST contour and re-merged through `framePath`, painted with a
//       swatch named by its hex (reused when the document has one, and
//       `Color/Black` for process black), grouped when there are several,
//       the frame deleted LAST (insert-then-delete is the order the
//       engine accepts);
//   (2) through the REAL engine, when it speaks protocol 66: the frame
//       goes, its glyphs come back as paths inside its box, ONE undo
//       restores the frame;
//   (3) on an OLDER engine the command refuses and the frame survives —
//       it never deletes text it could not replace.
// (2) and (3) are exclusive and each skips on the other engine;
// `PAGED_REQUIRE_V66=1` turns (2)'s skip into a failure, for the local
// override lane that is meant to prove it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CommandContribution, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  CREATE_OUTLINES_COMMAND_ID,
  applyCreateOutlines,
  createOutlinesBatchFor,
  outlineSwatchFor,
  rawTextOutlines,
  type TextOutlinesWire,
} from "../../src/index";
import { transformBounds, type Affine } from "@paged-media/draw-geometry";

import { buildIdml } from "../fixtures/build-idml";
import { countingHost } from "../perf/counting-host";
import { openHost } from "./host";

const square = (x: number, y: number, s: number) =>
  [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ].map(([px, py]) => ({ anchor: [px, py] as [number, number], left: [px, py] as [number, number], right: [px, py] as [number, number] }));

/** Two runs: black "o" (outer + inner contour) and a red bar. */
const RESULT: TextOutlinesWire = {
  id: { kind: "textFrame", id: "tf1" } as ElementId,
  pageId: "p1",
  skippedGlyphs: 0,
  runs: [
    {
      rgb: [0, 0, 0],
      cmyk: [0, 0, 0, 1],
      anchors: [...square(0, 0, 10), ...square(3, 3, 4)],
      subpathStarts: [0, 4],
      glyphs: 1,
    },
    { rgb: [1, 0, 0], cmyk: null, anchors: square(20, 0, 5), subpathStarts: [0], glyphs: 1 },
  ],
};

/** Lora (OFL, `test/fixtures/fonts/OFL-lora.txt`). The headless host
 *  loads with no fallback font, so text composes glyphs only in a family
 *  the font registry holds: the document below NAMES Lora, and the face
 *  is registered under that name BEFORE the load (fonts seed at load). */
const LORA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/fonts/Lora.ttf"),
);

/** One page; a text frame whose story is "Ho" in black then "o" in red,
 *  set in Lora — two colours, and two rings (each "o" has a hole). */
const TEXT_DOC = buildIdml([
  { name: "mimetype", data: "application/vnd.adobe.indesign-idml-package", store: true },
  {
    name: "designmap.xml",
    data: `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0" Self="d">
<idPkg:Graphic src="Resources/Graphic.xml"/>
<idPkg:Spread src="Spreads/Spread_s.xml"/>
<idPkg:Story src="Stories/Story_st.xml"/>
</Document>`,
  },
  {
    name: "Resources/Graphic.xml",
    data: `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
<Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
</idPkg:Graphic>`,
  },
  {
    name: "Spreads/Spread_s.xml",
    data: `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Spread Self="s" PageCount="1" ItemTransform="1 0 0 1 0 0">
<Page Self="p" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<TextFrame Self="tf" ParentStory="st" GeometricBounds="300 40 380 400" ItemTransform="1 0 0 1 0 0" StrokeWeight="0"/>
</Spread>
</idPkg:Spread>`,
  },
  {
    name: "Stories/Story_st.xml",
    data: `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Story Self="st"><ParagraphStyleRange>
<CharacterStyleRange AppliedFont="Lora" PointSize="36" FillColor="Color/Black"><Content>Ho</Content></CharacterStyleRange>
<CharacterStyleRange AppliedFont="Lora" PointSize="36" FillColor="Color/Red"><Content>o</Content></CharacterStyleRange>
</ParagraphStyleRange></Story>
</idPkg:Story>`,
  },
]);

type Op = { op: string; args: Record<string, unknown> };
const opsOf = (m: unknown): Op[] => (m as { args: { ops: Op[] } }).args.ops;

describe("draw conformance — create outlines (C-69, protocol 66)", () => {
  describe("the pure batch", () => {
    it("one path per colour, first contour inserted then re-merged, grouped, the frame deleted LAST", () => {
      const existing = new Map([["Color/Black", "Color/Black"]]);
      const ops = opsOf(createOutlinesBatchFor({ frame: RESULT.id, result: RESULT, existing }));
      expect(ops.map((o) => o.op)).toEqual([
        // black: no swatch (process black → Color/Black)
        "insertPath",
        "bindCreated",
        "setElementProperty", // framePath — the hole
        "setElementProperty", // fill
        "setElementProperty", // stroke off
        // red: a new swatch named by its hex, one contour → no framePath
        "createSwatch",
        "insertPath",
        "bindCreated",
        "setElementProperty",
        "setElementProperty",
        "createGroup",
        "deleteFrame",
      ]);
      const firstInsert = ops[0].args as { anchors: unknown[]; open: boolean };
      expect(firstInsert.anchors).toHaveLength(4);
      expect(firstInsert.open).toBe(false);
      const merge = ops[2].args as { path: string; value: { value: { subpathStarts: number[]; anchors: unknown[] } } };
      expect(merge.path).toBe("framePath");
      expect(merge.value.value.subpathStarts).toEqual([0, 4]);
      expect(merge.value.value.anchors).toHaveLength(8);
      expect((ops[3].args as { value: { value: string } }).value.value).toBe("Color/Black");
      const swatch = (ops[5].args as { spec: { name: string; selfId: string } }).spec;
      expect(swatch.name.toLowerCase()).toBe("#ff0000");
      expect((ops[8].args as { value: { value: string } }).value.value).toBe(swatch.selfId);
      expect((ops[9].args as { value: { value: string | null } }).value.value).toBeNull();
      expect(ops[11].args).toEqual({ frameId: "tf1" });
    });

    it("an existing swatch named with the hex is reused; a single colour is not grouped", () => {
      const one: TextOutlinesWire = { ...RESULT, runs: [RESULT.runs[1]] };
      const ops = opsOf(
        createOutlinesBatchFor({ frame: RESULT.id, result: one, existing: new Map([["#FF0000", "Color/u9"]]) }),
      );
      expect(ops.some((o) => o.op === "createSwatch")).toBe(false);
      expect(ops.some((o) => o.op === "createGroup")).toBe(false);
      expect(ops.at(-1)!.op).toBe("deleteFrame");
    });

    it("process black without a Color/Black swatch mints a hex swatch; nothing to outline → no batch", () => {
      const plan = outlineSwatchFor(RESULT.runs[0], new Map());
      expect(plan.create?.name.toLowerCase()).toBe("#000000");
      expect(
        createOutlinesBatchFor({ frame: RESULT.id, result: { ...RESULT, runs: [] }, existing: new Map() }),
      ).toBeNull();
    });
  });

  describe("through the real engine", () => {
    let h: HeadlessHost;
    let frame: ElementId;
    let v66 = false;

    const commandFor = (id: string): CommandContribution => {
      const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
      if (!rec) throw new Error(`no command recorded for ${id}`);
      return rec.value as CommandContribution;
    };

    const leafKinds = async (): Promise<string[]> => {
      const out: string[] = [];
      const walk = (nodes: { id?: { kind?: string; id?: string }; children?: unknown[] }[]) => {
        for (const n of nodes) {
          if (n.id?.id) out.push(`${n.id.kind}:${n.id.id}`);
          if (n.children) walk(n.children as never);
        }
      };
      walk((await h.host.document.tree()) as never);
      return out;
    };

    beforeAll(async () => {
      h = await openHost();
      h.loadBundle(drawBundle);
    });
    beforeEach(async () => {
      await h.host.editor.client.send({
        kind: "registerFont",
        payload: { family: "Lora", style: null, bytes: Array.from(LORA) },
      } as never);
      await h.load(TEXT_DOC);
      frame = { kind: "textFrame", id: "tf" } as ElementId;
      v66 = (await rawTextOutlines(h.host, frame)) !== null;
    });
    afterAll(() => h?.dispose());

    it("protocol 66: the frame becomes paths inside its own box, in ONE batch; one undo brings the frame back", async (ctx) => {
      if (!v66) {
        if (process.env.PAGED_REQUIRE_V66 === "1") throw new Error("PAGED_REQUIRE_V66=1 but the engine does not answer requestTextOutlines");
        ctx.skip();
      }
      const read = (await rawTextOutlines(h.host, frame))!;
      expect(read.runs.reduce((n, r) => n + r.glyphs, 0)).toBe(3);
      expect(read.runs).toHaveLength(2);
      const [geom] = await h.host.document.elementGeometry([frame]);
      const m = (geom.itemTransform ?? null) as Affine | null;
      const [top, left, bottom, right] = m ? transformBounds(geom.bounds, m) : geom.bounds;
      const before = await leafKinds();
      await h.host.selection.set([frame]);
      const counted = countingHost(h.host);
      expect(await applyCreateOutlines(counted.host)).toEqual([frame]);
      expect(counted.work.mutations).toHaveLength(1);

      const after = await leafKinds();
      const frameKey = `${frame.kind}:${String(frame.id)}`;
      expect(after).not.toContain(frameKey);
      const added = after.filter((k) => !before.includes(k));
      expect(added.length).toBeGreaterThanOrEqual(1);
      for (const key of added.filter((k) => k.startsWith("polygon:"))) {
        const id = { kind: "polygon", id: key.slice("polygon:".length) } as ElementId;
        const anchors = (await h.host.document.pathAnchors(id))!;
        expect(anchors.subpathStarts.length).toBeGreaterThanOrEqual(1);
        // Inside the frame's page-space box (pathAnchors answers the
        // path's own space, and an inserted path has no transform).
        for (const a of anchors.anchors) {
          expect(a.anchor[0]).toBeGreaterThan(left - 1);
          expect(a.anchor[0]).toBeLessThan(right + 1);
          expect(a.anchor[1]).toBeGreaterThan(top - 1);
          expect(a.anchor[1]).toBeLessThan(bottom + 1);
        }
      }
      // Two colours → two compound paths, grouped. "o" is a ring, so the
      // red path (one "o") has two contours and the black one ("H" + "o")
      // at least three.
      const holes = await Promise.all(
        added
          .filter((k) => k.startsWith("polygon:"))
          .map(async (k) => (await h.host.document.pathAnchors({ kind: "polygon", id: k.slice(8) } as ElementId))!.subpathStarts.length),
      );
      expect(holes.sort((a, b) => a - b)).toHaveLength(2);
      expect(holes[0]).toBe(2);
      expect(holes[1]).toBeGreaterThanOrEqual(3);
      expect(added.some((k) => k.startsWith("group:"))).toBe(true);
      // The red one is painted with a swatch named by its hex.
      const swatches = (await h.host.document.collection("swatches")) as { name: string }[];
      expect(swatches.some((sw) => sw.name.toLowerCase() === "#ff0000")).toBe(true);

      await h.host.document.undo();
      expect(await leafKinds()).toEqual(before);
    });

    it("an OLDER engine: the command refuses and the frame is left as text", async (ctx) => {
      if (v66) ctx.skip();
      const before = await leafKinds();
      await h.host.selection.set([frame]);
      await commandFor(CREATE_OUTLINES_COMMAND_ID).handler(undefined);
      expect(await leafKinds()).toEqual(before);
    });
  });
});
