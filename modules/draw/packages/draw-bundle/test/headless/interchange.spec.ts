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

// Draw ADR 364 — interchange through the engine's doors, on the real
// engine: SVG (the compound shape whose holes the old reader painted),
// DXF in and out, EPS through the PostScript interpreter, Illustrator
// through paged.pdf's placement — each one undo step, each loss logged,
// and no importer at all where the host lacks the door it rides.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { covers } from "@paged-media/test-kit";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  AI_IMPORTER_ID,
  DXF_EXPORTER_ID,
  DXF_IMPORTER_ID,
  EPS_IMPORTER_ID,
  MAX_SVG_BYTES,
  PDF_PLACE_VECTORS,
  SVG_IMPORTER_ID,
  bootInterchange,
  drawBundle,
  epsBoundingBox,
  importAi,
  importDxf,
  importEps,
  importSvg,
  leafIdsOf,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost, withoutSvgDoors } from "./host";

const built = existsSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
    "wasm",
    "trace_js_bg.wasm",
  ),
);

const file = (name: string, text: string, mimeType = "") => ({
  name,
  bytes: new TextEncoder().encode(text),
  mimeType,
});

/** `host` with its warnings kept. */
function logging(host: BundleHost): { host: BundleHost; warnings: string[] } {
  const warnings: string[] = [];
  const log = new Proxy(host.log, {
    get(target, key, receiver) {
      if (key === "warn") return (msg: string) => warnings.push(msg);
      const v = Reflect.get(target, key, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const wrapped = new Proxy(host, {
    get(target, key, receiver) {
      if (key === "log") return log;
      const v = Reflect.get(target, key, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { host: wrapped, warnings };
}

/** A synthetic DXF: two lines on layer "Walls" (red by index), a circle
 *  and a solid triangular HATCH on "Fixtures" in true colours, and a TEXT
 *  the reader does not import. */
const DXF = [
  "0",
  "SECTION",
  "2",
  "HEADER",
  "9",
  "$ACADVER",
  "1",
  "AC1024",
  "9",
  "$INSUNITS",
  "70",
  "4",
  "0",
  "ENDSEC",
  "0",
  "SECTION",
  "2",
  "ENTITIES",
  "0",
  "LINE",
  "8",
  "Walls",
  "62",
  "1",
  "370",
  "50",
  "10",
  "0",
  "20",
  "0",
  "30",
  "0",
  "11",
  "100",
  "21",
  "0",
  "31",
  "0",
  "0",
  "LINE",
  "8",
  "Walls",
  "62",
  "1",
  "370",
  "50",
  "10",
  "100",
  "20",
  "0",
  "30",
  "0",
  "11",
  "100",
  "21",
  "50",
  "31",
  "0",
  "0",
  "CIRCLE",
  "8",
  "Fixtures",
  "420",
  "1193046",
  "10",
  "50",
  "20",
  "25",
  "30",
  "0",
  "40",
  "10",
  "0",
  "HATCH",
  "8",
  "Fixtures",
  "420",
  "13382400",
  "100",
  "AcDbHatch",
  "10",
  "0",
  "20",
  "0",
  "30",
  "0",
  "210",
  "0",
  "220",
  "0",
  "230",
  "1",
  "2",
  "SOLID",
  "70",
  "1",
  "71",
  "0",
  "91",
  "1",
  "92",
  "1",
  "93",
  "3",
  "72",
  "1",
  "10",
  "60",
  "20",
  "10",
  "11",
  "80",
  "21",
  "10",
  "72",
  "1",
  "10",
  "80",
  "20",
  "10",
  "11",
  "70",
  "21",
  "30",
  "72",
  "1",
  "10",
  "70",
  "20",
  "30",
  "11",
  "60",
  "21",
  "10",
  "97",
  "0",
  "75",
  "0",
  "76",
  "1",
  "98",
  "0",
  "0",
  "TEXT",
  "8",
  "Walls",
  "10",
  "0",
  "20",
  "0",
  "40",
  "5",
  "1",
  "Plan",
  "0",
  "ENDSEC",
  "0",
  "EOF",
  "",
].join("\n");

/** A synthetic EPS: a red filled rectangle and a blue stroked circle in
 *  a 100 × 50 pt box. */
const EPS = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 100 50
%%HiResBoundingBox: 0 0 100 50
%%EndComments
1 0 0 setrgbcolor
10 10 moveto 90 10 lineto 90 40 lineto 10 40 lineto closepath fill
0 0 1 setrgbcolor 2 setlinewidth
50 25 10 0 360 arc closepath stroke
showpage
%%EOF
`;

describe("draw interchange through the engine's doors [plugin-draw.interchange-v2]", () => {
  let h: HeadlessHost;
  const leaves = async () => leafIdsOf(await h.host.document.tree());

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("registers the SVG, DXF, AI and EPS importers and the SVG and DXF exporters", () => {
    expect(h.importersContributed().map((c) => c.id)).toEqual(
      expect.arrayContaining([
        SVG_IMPORTER_ID,
        DXF_IMPORTER_ID,
        AI_IMPORTER_ID,
        EPS_IMPORTER_ID,
      ]),
    );
    expect(h.exportersContributed().map((c) => c.id)).toContain(
      DXF_EXPORTER_ID,
    );
  });

  it("a compound SVG shape is ONE element with its hole cut, in one undo step", async () => {
    covers("importer:media.paged.draw.importer.svg");
    const before = (await leaves()).length;
    for (const rule of ["evenodd", "nonzero"]) {
      const ids = await importSvg(
        h.host,
        file(
          "ring.svg",
          `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
            <path fill-rule="${rule}" fill="#cc3300" d="M10 10H110V110H10Z M40 40V80H80V40Z"/></svg>`,
        ),
      );
      expect(ids).toHaveLength(1);
      const table = await h.host.document.pathAnchors(ids[0]!);
      expect(table!.subpathStarts).toEqual([0, 4]);
      const props = await h.host.document.elementProperties(ids[0]!);
      const fillRule = props!.entries.find((e) => e.path === "frameFillRule");
      if (rule === "evenodd") {
        expect(fillRule?.value).toMatchObject({ value: "EvenOdd" });
      }
      await h.host.document.undo();
      expect((await leaves()).length).toBe(before);
    }
  });

  it.skipIf(!built)(
    "a DXF lands as one named group per layer, its colours, weights and solid hatch kept, the TEXT reported",
    async () => {
      covers("importer:media.paged.draw.importer.dxf");
      const before = (await leaves()).length;
      const { host, warnings } = logging(h.host);
      const ids = await importDxf(host, file("plan.dxf", DXF));
      // Two layer groups (the lines on Walls; the circle and the filled
      // hatch on Fixtures) and their four paths.
      const tree = await h.host.document.tree();
      const added = leafIdsOf(tree).slice(before);
      expect(added).toHaveLength(4);
      expect(ids.length).toBeGreaterThanOrEqual(4);
      expect(warnings.some((w) => /TEXT entities are left out/.test(w))).toBe(
        true,
      );
      expect(warnings.some((w) => /HATCH/.test(w))).toBe(false);
      // The group of the Walls layer is named after it.
      const groups = ids.filter((id) => id.kind === "group");
      expect(groups.length).toBeGreaterThanOrEqual(1);
      const names = await Promise.all(
        groups.map(async (g) => {
          const p = await h.host.document.elementProperties(g);
          return (
            p?.entries.find((e) => e.path === "itemName")?.value as {
              value?: string;
            }
          )?.value;
        }),
      );
      expect(names).toEqual(expect.arrayContaining(["Walls", "Fixtures"]));
      // Red by index, 0.5 mm.
      const swatches = await h.host.document.collection<{
        selfId: string;
        name: string;
      }>("swatches");
      const byId = new Map(swatches.map((s) => [s.selfId, s.name]));
      const paint = async (id: ElementId) => {
        const props = await h.host.document.elementProperties(id);
        const read = (path: string) =>
          (
            props!.entries.find((e) => e.path === path)?.value as {
              value?: unknown;
            }
          )?.value;
        return {
          fill: byId.get(read("frameFillColor") as string) ?? null,
          stroke: byId.get(read("frameStrokeColor") as string) ?? null,
          weight: read("frameStrokeWeight") as number,
        };
      };
      const painted = await Promise.all(added.map(paint));
      // The walls: red, 0.5 mm.
      const wall = painted.findIndex((p) => /ff0000/i.test(p.stroke ?? ""));
      expect(wall).toBeGreaterThanOrEqual(0);
      expect(painted[wall]!.weight).toBeCloseTo((0.5 * 72) / 25.4, 2);
      // 100 mm long.
      const geo = await h.host.document.pathAnchors(added[wall]!);
      expect(
        Math.abs(geo!.anchors[1]!.anchor[0] - geo!.anchors[0]!.anchor[0]),
      ).toBeCloseTo((100 * 72) / 25.4, 1);
      // The hatch: filled in its true colour, no stroke.
      expect(painted.some((p) => /cc3300/i.test(p.fill ?? ""))).toBe(true);
      await h.host.document.undo();
      expect((await leaves()).length).toBe(before);
    },
  );

  it.skipIf(!built)(
    "the DXF export writes what the selection draws, and it reads back",
    async () => {
      covers("exporter:media.paged.draw.exporter.dxf");
      const ids = await importSvg(
        h.host,
        file(
          "two.svg",
          `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
            <rect x="20" y="20" width="100" height="50" fill="none" stroke="#ff8800" stroke-width="2"/>
            <circle cx="200" cy="60" r="40" fill="none" stroke="#0000ff"/></svg>`,
        ),
      );
      await h.host.selection.set(ids as ElementId[]);
      const exporter = h
        .exportersContributed()
        .find((c) => c.id === DXF_EXPORTER_ID)!;
      const out = await exporter.export();
      expect(out!.fileName).toMatch(/\.dxf$/);
      const text = new TextDecoder().decode(out!.bytes);
      expect(text).toContain("LWPOLYLINE");
      expect(text).toContain("SPLINE");
      // Reads back: two shapes, the orange as a true colour.
      const back = (await bootInterchange()).dxfToSvg(out!.bytes);
      expect(back.report.items).toBe(2);
      expect(back.svg).toContain('stroke="#ff8800"');
      await h.host.selection.set([]);
      await h.host.document.undo();
    },
  );

  it("an EPS's bounding box is read from its DSC comments, the trailer's when deferred", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(epsBoundingBox(enc(EPS))).toEqual([0, 0, 100, 50]);
    expect(
      epsBoundingBox(
        enc(
          "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: (atend)\n%%EndComments\n%%Trailer\n%%BoundingBox: 5 5 25 15\n",
        ),
      ),
    ).toEqual([5, 5, 25, 15]);
    expect(epsBoundingBox(enc("%!PS\n"))).toBeNull();
  });

  it("an EPS lands as editable paths through the engine's PostScript, in one undo step", async () => {
    covers("importer:media.paged.draw.importer.eps");
    const before = (await leaves()).length;
    const { host, warnings } = logging(h.host);
    const ids = await importEps(host, file("art.eps", EPS));
    const added = (await leaves()).slice(before);
    expect(warnings.filter((w) => /placed as PostScript/.test(w))).toEqual([]);
    // The rectangle and the circle, as paths: the placement is gone.
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(added.every((id) => id.kind === "polygon")).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await h.host.document.undo();
    expect((await leaves()).length).toBe(before);
  });

  it("an Illustrator file is handed to paged.pdf's placement, its losses logged", async () => {
    covers("importer:media.paged.draw.importer.ai");
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const root: ElementId = { kind: "group", id: "g-ai" } as ElementId;
    const fake = new Proxy(h.host, {
      get(target, key, receiver) {
        if (key === "supports")
          return (f: string) => f === "objects.shared@1" || target.supports(f);
        if (key === "objects")
          return {
            ...target.objects,
            invoke: async (command: string, args: Record<string, unknown>) => {
              calls.push({ command, args });
              return {
                placed: true,
                root,
                losses: [
                  {
                    code: "aiPrivate",
                    count: 1,
                    message: "Illustrator's own data is not read",
                  },
                ],
              };
            },
          };
        const v = Reflect.get(target, key, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const { host, warnings } = logging(fake);
    const bytes = new TextEncoder().encode("%PDF-1.5\n");
    const placed = await importAi(host, {
      name: "art.ai",
      bytes,
      mimeType: "application/illustrator",
    });
    expect(placed).toEqual(root);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(PDF_PLACE_VECTORS);
    expect(calls[0]!.args).toMatchObject({ bytes, name: "art.ai", page: 1 });
    expect(warnings.some((w) => /Illustrator's own data/.test(w))).toBe(true);
  });

  it("a file past the SVG door's size is refused before it reaches the engine", async () => {
    const { host, warnings } = logging(h.host);
    const ids = await importSvg(host, {
      name: "huge.svg",
      bytes: new Uint8Array(MAX_SVG_BYTES + 1),
      mimeType: "image/svg+xml",
    });
    expect(ids).toEqual([]);
    expect(warnings.join("\n")).toMatch(/huge\.svg is larger than 32 MB/);
    // The engine still answers.
    expect((await leaves()).length).toBeGreaterThan(0);
  });

  it("without paged.pdf an Illustrator file is refused by name", async () => {
    const { host, warnings } = logging(h.host);
    const placed = await importAi(host, {
      name: "art.ai",
      bytes: new TextEncoder().encode("%PDF-1.5\n"),
      mimeType: "application/illustrator",
    });
    expect(placed).toBeNull();
    expect(warnings.join("\n")).toMatch(/art\.ai not imported/);
  });
});

describe("a host without the engine's SVG doors [plugin-draw.interchange-v2]", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
  });
  afterAll(() => h?.dispose());

  it("gets no SVG or DXF importer — a refusal, never a second SVG reader", async () => {
    const { host, warnings } = logging(withoutSvgDoors(h.host));
    const ids = await importSvg(
      host,
      file(
        "a.svg",
        `<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>`,
      ),
    );
    expect(ids).toEqual([]);
    expect(warnings.join("\n")).toMatch(/no document\.importSvg@1 door/);
  });
});
