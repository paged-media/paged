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

// Phase 8 conformance — the SVG importer + exporter (K-2). Three layers:
//   1. Registration: activating the bundle records the `.svg` importer +
//      exporter through the harness's recording registries, ids matching
//      the manifest.
//   2. Pure planning: `shapesFromSvgBytes` / `insertPathMutationsForShape`
//      / `styleDefaultsForShape` / `svgImportOpsFor` emit the EXACT shapes
//      + wire mutations the live importer commits (the no-second-copy
//      rule) — including the ORDER of the one batch, which is where the
//      engine's rules bite.
//   3. Live round-trip: a real SVG fixture is imported into the headless
//      engine (leaf count grows, the created element's anchor table
//      matches), then the inserted selection is exported back to SVG and
//      re-imported — geometry stable within tolerance.
//   4. What ONE BATCH has to keep: z-order = document order, a contour is
//      an element, groups flatten, the paint does not depend on the
//      user's creation defaults (and leaves them alone), one undo takes
//      the whole file back, and a refused contour costs that contour only.

import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import type { ElementId, Mutation, MutationInput } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import {
  parseSvgDocument,
  evalCubic,
  type AnchorTable,
} from "@paged-media/draw-geometry";

import {
  drawBundle,
  shapesFromSvgBytes,
  insertPathMutationsForShape,
  styleDefaultsForShape,
  importSvg,
  exportSvg,
  leafIdsOf,
  SVG_IMPORTER_ID,
  SVG_EXPORTER_ID,
} from "../../src";
import {
  commitSvgImport,
  svgImportHandle,
  svgImportOpsFor,
  svgImportUnitsFor,
  SVG_IMPORT_UNSTROKED,
} from "../../src/io/svg";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { countingHost } from "../perf/counting-host";
import { openHost } from "./host";
import { withoutHatch, withoutMintedOutcome } from "./one-batch";

const PAGE = F1_MULTI_SHAPE.pageId;
const enc = (s: string) => new TextEncoder().encode(s);

// A small, real, hand-authored SVG fixture: a filled+stroked rectangle,
// a filled circle, and an open cubic path. Coordinates land inside the
// fixture page so the engine accepts the inserted paths.
const FIXTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
  <rect x="20" y="20" width="120" height="80" fill="#ff8800" stroke="#222222" stroke-width="2"/>
  <circle cx="200" cy="60" r="40" fill="#0088ff"/>
  <path d="M20 200 C 60 150 120 150 160 200" fill="none" stroke="#00aa00" stroke-width="3"/>
</svg>`;

async function leafCount(h: HeadlessHost): Promise<number> {
  const roots = await h.host.document.tree();
  let n = 0;
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id) n++;
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return n;
}

/** Every leaf element, in tree (= paint) order. */
const leafList = async (h: HeadlessHost): Promise<ElementId[]> =>
  leafIdsOf(await h.host.document.tree());

const file = (name: string, svg: string) => ({
  name,
  bytes: enc(svg),
  mimeType: "image/svg+xml",
});

type SwatchRow = { selfId: string; name: string };

const swatchRows = async (h: HeadlessHost): Promise<SwatchRow[]> => [
  ...(await h.host.document.collection<SwatchRow>("swatches")),
];

/** What an element is painted with, colour refs resolved to the swatch
 *  NAME (the importer names a swatch with its hex). */
async function paintOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<{ fill: string | null; stroke: string | null; weight: number | null }> {
  const names = new Map((await swatchRows(h)).map((sw) => [sw.selfId, sw.name]));
  const props = await h.host.document.elementProperties(id);
  const read = (path: string): unknown =>
    (props?.entries.find((e) => e.path === path)?.value as { value?: unknown })
      ?.value ?? null;
  const name = (ref: unknown): string | null =>
    typeof ref === "string" ? (names.get(ref) ?? ref) : null;
  return {
    fill: name(read("frameFillColor")),
    stroke: name(read("frameStrokeColor")),
    weight: read("frameStrokeWeight") as number | null,
  };
}

/** The first anchor of each element, in the order given — enough to say
 *  WHICH contour landed where. */
async function firstAnchors(
  h: HeadlessHost,
  ids: readonly ElementId[],
): Promise<[number, number][]> {
  const out: [number, number][] = [];
  for (const id of ids) {
    const table = await h.host.document.pathAnchors(id);
    const a = table!.anchors[0].anchor;
    out.push([Math.round(a[0]), Math.round(a[1])]);
  }
  return out;
}

const creationDefaults = async (h: HeadlessHost): Promise<unknown[]> => {
  const meta = await h.host.document.meta();
  return [
    meta.defaultFillColor ?? null,
    meta.defaultStrokeColor ?? null,
    meta.defaultStrokeWeight ?? null,
  ];
};

function sample(t: AnchorTable, per = 8): [number, number][] {
  const out: [number, number][] = [];
  const starts = t.subpathStarts.length ? t.subpathStarts : [0];
  const open = t.subpathOpen ?? [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : t.anchors.length;
    const count = end - begin;
    if (!count) continue;
    const segs = (open[s] ?? false) ? count - 1 : count;
    for (let i = 0; i < segs; i++) {
      const a = t.anchors[begin + i];
      const b = t.anchors[begin + ((i + 1) % count)];
      for (let k = 0; k <= per; k++) {
        out.push(evalCubic(a.anchor, a.right, b.left, b.anchor, k / per));
      }
    }
  }
  return out;
}

describe("draw conformance — SVG import/export (Phase 8, K-2)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  // ----- pure planning -----

  it("shapesFromSvgBytes parses the fixture into 3 shapes with style", () => {
    const shapes = shapesFromSvgBytes(enc(FIXTURE_SVG));
    expect(shapes.length).toBe(3);
    expect(shapes[0].style.fill).toBe("#ff8800");
    expect(shapes[0].style.stroke).toBe("#222222");
    expect(shapes[0].style.strokeWidth).toBe(2);
    expect(shapes[1].style.fill).toBe("#0088ff");
    expect(shapes[2].style.fill).toBeNull();
    expect(shapes[2].style.stroke).toBe("#00aa00");
  });

  it("insertPathMutationsForShape emits one insertPath per contour", () => {
    const shapes = shapesFromSvgBytes(enc(FIXTURE_SVG));
    const muts = insertPathMutationsForShape(PAGE, shapes[0].anchors);
    expect(muts.length).toBe(1);
    const m = muts[0] as Extract<Mutation, { op: "insertPath" }>;
    expect(m.op).toBe("insertPath");
    expect(m.args.pageId).toBe(PAGE);
    expect(m.args.open).toBe(false); // a closed rect
    expect(m.args.anchors.length).toBe(4);
  });

  it("styleDefaultsForShape builds swatch-creates + resolved defaults for a solid fill", () => {
    const { swatches, defaults } = styleDefaultsForShape({
      fill: "#ff0000",
      stroke: "#000000",
      strokeWidth: 2,
    });
    // Two swatches (fill + stroke), each NAMED with its hex so the
    // exporter resolves the ref back.
    expect(swatches.map((m) => m.op)).toEqual(["createSwatch", "createSwatch"]);
    const sw = swatches[0] as Extract<Mutation, { op: "createSwatch" }>;
    expect(sw.args.spec.name).toBe("#ff0000");
    expect(sw.args.spec.value).toEqual([255, 0, 0]);
    // The paint points at the minted swatch ids + carries the weight.
    expect(defaults.fillColor).toBe(sw.args.spec.selfId);
    expect(defaults.strokeWeight).toBe(2);
  });

  it("styleDefaultsForShape with a palette creates a colour once and points at it again", () => {
    const palette = new Map<string, string>();
    const first = styleDefaultsForShape({ fill: "#ff0000", stroke: "red" }, palette);
    // `red` IS #ff0000: one swatch, and fill and stroke share it.
    expect(first.swatches).toHaveLength(1);
    expect(first.defaults.strokeColor).toBe(first.defaults.fillColor);
    const second = styleDefaultsForShape({ fill: "#f00", stroke: "#0000ff" }, palette);
    expect(second.swatches).toHaveLength(1); // only the blue is new
    expect(second.defaults.fillColor).toBe(first.defaults.fillColor);
    expect([...palette.keys()]).toEqual(["#ff0000", "#0000ff"]);
  });

  it("fill:none resolves the fill default to null (no swatch created)", () => {
    const { swatches, defaults } = styleDefaultsForShape({ fill: null });
    expect(swatches.length).toBe(0);
    expect(defaults.fillColor).toBeNull();
  });

  // THE BATCH. Its order is the engine's, not a style choice: a
  // `bindCreated` placed before its creating child is refused by name,
  // and a paint write can only address a path through the handle bound
  // right after its insert.
  it("svgImportOpsFor lays the file out as one batch: swatch, then insert → bind → three paint writes per contour", () => {
    const shapes = shapesFromSvgBytes(enc(FIXTURE_SVG));
    const ops = svgImportOpsFor(svgImportUnitsFor(PAGE, shapes), new Map());
    expect(ops.map((m) => m.op)).toEqual([
      // the rect: fill + stroke
      "createSwatch",
      "createSwatch",
      "insertPath",
      "bindCreated",
      "setElementProperty",
      "setElementProperty",
      "setElementProperty",
      // the circle: fill only
      "createSwatch",
      "insertPath",
      "bindCreated",
      "setElementProperty",
      "setElementProperty",
      "setElementProperty",
      // the open path: stroke only
      "createSwatch",
      "insertPath",
      "bindCreated",
      "setElementProperty",
      "setElementProperty",
      "setElementProperty",
    ]);
    // The creation defaults are never written: a batch carrying that
    // child takes the engine's per-child lane (see the edge pinned below).
    expect(ops.some((m) => m.op === "setDocumentDefaults")).toBe(false);

    type Write = Extract<Mutation, { op: "setElementProperty" }>;
    const writesOn = (contour: number): Write[] =>
      ops.filter(
        (m): m is Write =>
          m.op === "setElementProperty" &&
          (m.args.elementId as { id?: unknown }).id ===
            `$h:${svgImportHandle(contour)}`,
      );
    const swatchId = (hex: string): string =>
      (
        ops.find(
          (m) => m.op === "createSwatch" && m.args.spec.name === hex,
        ) as Extract<Mutation, { op: "createSwatch" }>
      ).args.spec.selfId as string;
    const bound = ops.filter((m) => m.op === "bindCreated") as Extract<
      MutationInput,
      { op: "bindCreated" }
    >[];
    expect(bound.map((m) => m.args.handle)).toEqual([0, 1, 2].map(svgImportHandle));

    // Each contour is painted through ITS handle, all three properties.
    expect(writesOn(0).map((m) => [m.args.path, m.args.value])).toEqual([
      ["frameFillColor", { type: "colorRef", value: swatchId("#ff8800") }],
      ["frameStrokeColor", { type: "colorRef", value: swatchId("#222222") }],
      ["frameStrokeWeight", { type: "length", value: 2 }],
    ]);
    expect(writesOn(1).map((m) => [m.args.path, m.args.value])).toEqual([
      ["frameFillColor", { type: "colorRef", value: swatchId("#0088ff") }],
      ["frameStrokeColor", { type: "colorRef", value: SVG_IMPORT_UNSTROKED.color }],
      ["frameStrokeWeight", { type: "length", value: SVG_IMPORT_UNSTROKED.weight }],
    ]);
    expect(writesOn(2).map((m) => [m.args.path, m.args.value])).toEqual([
      ["frameFillColor", { type: "colorRef", value: null }],
      ["frameStrokeColor", { type: "colorRef", value: swatchId("#00aa00") }],
      ["frameStrokeWeight", { type: "length", value: 3 }],
    ]);
  });

  it("a compound shape is one unit: one swatch set, then every contour inserted and painted in contour order", () => {
    const shapes = shapesFromSvgBytes(
      enc(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">` +
          `<path d="M10 10h20v20h-20Z M40 10h20v20h-20Z M70 10h20v20h-20Z" fill="#aa00aa"/>` +
          `</svg>`,
      ),
    );
    const units = svgImportUnitsFor(PAGE, shapes);
    expect(units).toHaveLength(1);
    expect(units[0].inserts).toHaveLength(3);
    const ops = svgImportOpsFor(units, new Map());
    expect(ops.filter((m) => m.op === "createSwatch")).toHaveLength(1);
    expect(ops.filter((m) => m.op === "insertPath")).toHaveLength(3);
    expect(ops.filter((m) => m.op === "setElementProperty")).toHaveLength(9);
    // A bind always directly follows the insert it names.
    ops.forEach((m, i) => {
      if (m.op === "bindCreated") expect(ops[i - 1].op).toBe("insertPath");
    });
  });

  // ----- live round-trip against the real engine -----

  it("importSvg inserts the fixture shapes into the document", async () => {
    const before = await leafCount(h);
    const ids = await importSvg(h.host, {
      name: "fixture.svg",
      bytes: enc(FIXTURE_SVG),
      mimeType: "image/svg+xml",
    });
    // Three shapes, each a single contour → three inserted elements.
    expect(ids.length).toBe(3);
    expect(await leafCount(h)).toBe(before + 3);

    // The first inserted element's geometry matches the imported rect.
    const table = await h.host.document.pathAnchors(ids[0]);
    expect(table).not.toBeNull();
    expect(table!.anchors.length).toBe(4);
    expect(table!.subpathOpen?.[0]).toBe(false);

    // ONE undo takes the whole file back — paths and swatches. (It used
    // to be seven: four swatches and three inserts.)
    await h.host.document.undo();
    expect(await leafCount(h)).toBe(before);
  });

  it("import → export → re-import is geometry-stable (round-trip)", async () => {
    // Import the fixture, select the inserts, export them to SVG, then
    // re-parse and compare geometry against the original parse.
    const baseline = await leafCount(h);
    const ids = await importSvg(h.host, {
      name: "rt.svg",
      bytes: enc(FIXTURE_SVG),
      mimeType: "image/svg+xml",
    });
    expect(ids.length).toBe(3);
    await h.host.selection.set(ids as never[]);

    const result = await exportSvg(h.host);
    expect(result).not.toBeNull();
    expect(result!.fileName.endsWith(".svg")).toBe(true);

    const exportedText = new TextDecoder().decode(result!.bytes);
    const reDoc = parseSvgDocument(exportedText);
    expect(reDoc).not.toBeNull();
    expect(reDoc!.shapes.length).toBe(3);

    // Compare the EXPORTED geometry against what the importer lowered
    // (the engine round-trips the anchors; the exporter re-applies the
    // item transform — so the exported coords should match the imported
    // page-frame coords within engine + rounding tolerance).
    const original = shapesFromSvgBytes(enc(FIXTURE_SVG));
    for (let i = 0; i < 3; i++) {
      const a = sample(original[i].anchors);
      const b = sample(reDoc!.shapes[i].anchors);
      expect(b.length).toBe(a.length);
      let maxDev = 0;
      for (let k = 0; k < a.length; k++) {
        maxDev = Math.max(
          maxDev,
          Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1]),
        );
      }
      // Within 0.5pt — the engine stores anchors faithfully; the residual
      // is coordinate rounding (precision 3) on both legs.
      expect(maxDev).toBeLessThan(0.5);
    }

    // Fill/stroke survive the round-trip (resolved via the swatch name).
    expect(reDoc!.shapes[0].style.fill).toBe("#ff8800");
    expect(reDoc!.shapes[0].style.stroke).toBe("#222222");
    expect(reDoc!.shapes[1].style.fill).toBe("#0088ff");

    // Clean up: clear selection + take the import back (one undo step).
    await h.host.selection.set([]);
    await h.host.document.undo();
    expect(await leafCount(h)).toBe(baseline);
  });

  // ----- what one batch has to keep -----

  it("one undo removes the paths AND the swatches; one redo brings both back", async () => {
    const leaves = await leafCount(h);
    const swatches = (await swatchRows(h)).length;
    const done = await commitSvgImport(h.host, file("undo.svg", FIXTURE_SVG));
    expect(done).toEqual({ shapes: 3, elements: 3, swatches: 4, batches: 1, refused: 0 });
    expect(await leafCount(h)).toBe(leaves + 3);
    expect((await swatchRows(h)).length).toBe(swatches + 4);

    await h.host.document.undo();
    expect(await leafCount(h)).toBe(leaves);
    expect((await swatchRows(h)).length).toBe(swatches);

    await h.host.document.redo();
    expect(await leafCount(h)).toBe(leaves + 3);
    expect((await swatchRows(h)).length).toBe(swatches + 4);

    await h.host.document.undo();
    expect(await leafCount(h)).toBe(leaves);
  });

  it("z-order is document order, a contour is an element, and groups flatten with their transform and paint", async () => {
    // Document order: a square, a three-contour compound path, then a
    // group (translated, with inherited paint) holding a square and a
    // nested rotated group.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">` +
      `<rect x="10" y="10" width="20" height="20" fill="#111111"/>` +
      `<path d="M40 10h20v20h-20Z M70 10h20v20h-20Z M100 10h20v20h-20Z" fill="#222222"/>` +
      `<g transform="translate(100 100)" fill="#333333" stroke="#444444" stroke-width="2">` +
      `<rect x="0" y="0" width="20" height="20"/>` +
      `<g transform="translate(50 0)"><rect x="0" y="0" width="20" height="20" fill="#555555"/></g>` +
      `</g>` +
      `</svg>`;
    const ids = await importSvg(h.host, file("order.svg", svg));
    // 1 + 3 + 1 + 1: every contour its own element, no group node.
    expect(ids).toHaveLength(6);
    expect(ids.every((id) => id.kind === "polygon")).toBe(true);
    // The ids come back in insertion order, and that IS the tree's
    // (= paint) order: later in the file paints on top.
    expect((await leafList(h)).slice(-6)).toEqual(ids);

    // WHICH contour landed where: the group's transforms are applied.
    expect(await firstAnchors(h, ids)).toEqual([
      [10, 10],
      [40, 10],
      [70, 10],
      [100, 10],
      [100, 100],
      [150, 100],
    ]);
    // …and each carries its own shape's paint: the compound path's three
    // contours share one, the group's children inherit the group's.
    const paints = [];
    for (const id of ids) paints.push(await paintOf(h, id));
    const black = { stroke: "Black", weight: 1 }; // SVG_IMPORT_UNSTROKED
    expect(paints).toEqual([
      { fill: "#111111", ...black },
      { fill: "#222222", ...black },
      { fill: "#222222", ...black },
      { fill: "#222222", ...black },
      { fill: "#333333", stroke: "#444444", weight: 2 },
      { fill: "#555555", stroke: "#444444", weight: 2 },
    ]);

    await h.host.document.undo();
  });

  it("the paint does not depend on the user's creation defaults, and the import leaves them alone", async () => {
    const original = await creationDefaults(h);
    // A user who draws with a fat black-filled default. (A top-level
    // defaults write is app state: it is not an undo step.)
    await h.host.document.mutate({
      op: "setDocumentDefaults",
      args: { fillColor: "Color/Black", strokeColor: "Color/Black", strokeWeight: 7 },
    });
    const users = await creationDefaults(h);
    expect(users).toEqual(["Color/Black", "Color/Black", 7]);

    const ids = await importSvg(h.host, file("defaults.svg", FIXTURE_SVG));
    const paints = [];
    for (const id of ids) paints.push(await paintOf(h, id));
    expect(paints).toEqual([
      { fill: "#ff8800", stroke: "#222222", weight: 2 },
      // No stroke named → the pinned fallback, NOT the user's 7 pt.
      { fill: "#0088ff", stroke: "Black", weight: SVG_IMPORT_UNSTROKED.weight },
      // fill="none" → no fill, NOT the user's black.
      { fill: null, stroke: "#00aa00", weight: 3 },
    ]);
    expect(await creationDefaults(h)).toEqual(users);

    await h.host.document.undo();
    expect(await creationDefaults(h)).toEqual(users);
    await h.host.document.mutate({
      op: "setDocumentDefaults",
      args: {
        fillColor: original[0] as string | null,
        strokeColor: original[1] as string | null,
        strokeWeight: original[2] as number | null,
      },
    });
    expect(await creationDefaults(h)).toEqual(original);
  });

  // PINNED, NOT ENDORSED — see `SVG_IMPORT_UNSTROKED`. An SVG shape with
  // no stroke has no stroke; the importer has always given it the
  // engine's creation fallback. Changing this is a decision about what
  // imported artwork looks like, so it fails here first.
  it("a shape whose SVG names no stroke still imports with a 1 pt Color/Black one (the fidelity gap, as found)", () => {
    expect(SVG_IMPORT_UNSTROKED).toEqual({ color: "Color/Black", weight: 1 });
  });

  it("a refused contour costs that contour only: the rest of the file lands, in order", async () => {
    // `1e999` parses to Infinity, which JSON carries as null — and the
    // engine refuses the WHOLE MESSAGE for it, not the one child.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">` +
      `<rect x="10" y="10" width="40" height="40" fill="#101010"/>` +
      `<path d="M1e999 10 L20 20 L40 60Z" fill="#202020" stroke="#212121"/>` +
      `<rect x="60" y="10" width="40" height="40" fill="#303030"/>` +
      `<path d="M10 100h20v20h-20Z M1e999 200h20v20h-20Z M50 100h20v20h-20Z" fill="#404040"/>` +
      `<rect x="110" y="10" width="40" height="40" fill="#202020"/>` +
      `</svg>`;
    const leaves = await leafCount(h);
    const swatchesBefore = (await swatchRows(h)).length;
    const before = new Set((await leafList(h)).map((id) => String(id.id)));

    const done = await commitSvgImport(h.host, file("refused.svg", svg));
    // Five shapes, seven contours, two of them unreadable.
    expect(done.shapes).toBe(5);
    expect(done.refused).toBe(2);
    expect(done.elements).toBe(5);
    // #212121 belonged to the refused shape alone: no orphan swatch.
    expect(done.swatches).toBe(4);
    expect((await swatchRows(h)).length).toBe(swatchesBefore + 4);
    expect(await leafCount(h)).toBe(leaves + 5);

    const made = (await leafList(h)).filter((id) => !before.has(String(id.id)));
    // Document order survives the bisection.
    expect(await firstAnchors(h, made)).toEqual([
      [10, 10],
      [60, 10],
      [10, 100],
      [50, 100],
      [110, 10],
    ]);
    const paints = [];
    for (const id of made) paints.push((await paintOf(h, id)).fill);
    expect(paints).toEqual(["#101010", "#303030", "#404040", "#404040", "#202020"]);

    // The broken file pays for itself: one undo step per batch the
    // bisection had to commit — more than one, and exactly that many.
    expect(done.batches).toBeGreaterThan(1);
    for (let i = 0; i < done.batches; i++) await h.host.document.undo();
    expect(await leafCount(h)).toBe(leaves);
    expect((await swatchRows(h)).length).toBe(swatchesBefore);
  });

  // `importSvg` answers its ids off the engine's reply (`commands/minted.ts`)
  // — one list per APPLIED batch, appended in commit order. A bisected file
  // is the case that can get that wrong: several batches, refused ones in
  // between. On every lane of the seam the answer must be exactly the new
  // leaves, in document order, and nothing a refused batch rolled back.
  it("importSvg across a bisected file: exactly the new leaves, in order, on every lane", async () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">` +
      `<rect x="10" y="10" width="40" height="40" fill="#101010"/>` +
      `<path d="M1e999 10 L20 20 L40 60Z" fill="#202020"/>` +
      `<rect x="60" y="10" width="40" height="40" fill="#303030"/>` +
      `<path d="M10 100h20v20h-20Z M1e999 200h20v20h-20Z M50 100h20v20h-20Z" fill="#404040"/>` +
      `</svg>`;
    // The shipped host answers through the outcome (plugin-sdk 0.2.38);
    // the two older lanes need an SDK whose outcome carries no list.
    for (const [lane, host] of [
      ["outcome", h.host],
      ["reply", withoutMintedOutcome(h.host)],
      ["diff", withoutHatch(withoutMintedOutcome(h.host))],
    ] as const) {
      const leaves = await leafCount(h);
      const before = new Set((await leafList(h)).map((id) => String(id.id)));
      const counted = countingHost(host);
      const ids = await importSvg(counted.host, file("bisected.svg", svg));
      const made = (await leafList(h)).filter((id) => !before.has(String(id.id)));
      expect(ids, lane).toEqual(made);
      expect(await firstAnchors(h, ids), lane).toEqual([
        [10, 10],
        [60, 10],
        [10, 100],
        [50, 100],
      ]);
      // No tree read on the outcome and reply lanes; two per APPLIED batch
      // on the diff lane (a refused batch reads its "before" and stops).
      if (lane !== "diff") expect(counted.work.count("document.tree"), lane).toBe(0);
      else expect(counted.work.count("document.tree")).toBeGreaterThan(2);
      while ((await leafCount(h)) > leaves) await h.host.document.undo();
    }
  });

  it("File ▸ Open — the registered importer — commits the file in one undo step", async () => {
    const importer = h.importersContributed().find((c) => c.id === SVG_IMPORTER_ID);
    expect(importer).toBeDefined();
    const before = await leafCount(h);
    // The contribution does not hand its promise back; wait for the
    // batch to land.
    void importer!.import(file("open.svg", FIXTURE_SVG));
    await vi.waitFor(async () => expect(await leafCount(h)).toBe(before + 3));
    await h.host.document.undo();
    expect(await leafCount(h)).toBe(before);
  });

  // THE ENGINE EDGE THE BATCH IS SHAPED AROUND. Styling through the
  // creation defaults inside the batch lands the same paint in fewer
  // children — and is not used, because of what this measures: a batch
  // carrying a `setDocumentDefaults` child takes the engine's per-child
  // lane, where the undo log's 10 000-entry cap applies MID-batch.
  //
  // WHEN THIS FAILS the engine has fixed it (the cap must apply to the
  // collapsed batch, not to its children). Nothing here has to change —
  // the handle lane stays correct — but `io/svg.ts`'s header, which
  // cites this, should say so.
  it("ENGINE EDGE: a batch with a setDocumentDefaults child, over the undo-log cap, is not one undo step", async () => {
    // Its own host: what this strands, undo can never reach again.
    const own = await openHost();
    try {
      await own.load(F1_MULTI_SHAPE.bytes());
      const base = await leafCount(own);
      const dot = (i: number) => {
        const x = 10 + (i % 200) * 2;
        const y = 10 + Math.floor(i / 200) * 2;
        return [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
        ].map((p) => ({ anchor: p, left: p, right: p })) as never;
      };
      // One defaults write + 10 500 inserts = 10 501 children.
      const INSERTS = 10_500;
      const ops: Mutation[] = [
        {
          op: "setDocumentDefaults",
          args: { fillColor: null, strokeColor: null, strokeWeight: null },
        },
      ];
      for (let i = 0; i < INSERTS; i++) {
        ops.push({
          op: "insertPath",
          args: { pageId: PAGE, anchors: dot(i), open: false },
        });
      }
      const outcome = await own.host.document.mutate({ op: "batch", args: { ops } });
      expect(outcome.applied).toBe(true);
      expect(await leafCount(own)).toBe(base + INSERTS);

      await own.host.document.undo();
      // 501 children fell off the front of the 10 000-entry log: the
      // defaults write and the first 500 inserts.
      expect((await leafCount(own)) - base).toBe(500);
      // …and they are out of undo's reach for good.
      await own.host.document.undo();
      await own.host.document.undo();
      expect((await leafCount(own)) - base).toBe(500);
    } finally {
      own.dispose();
    }
  });

  it("exportSvg returns null for an empty selection", async () => {
    await h.host.selection.set([]);
    expect(await exportSvg(h.host)).toBeNull();
  });

  it("the importer/exporter ids are namespaced under the manifest id", () => {
    expect(SVG_IMPORTER_ID.startsWith(drawBundle.manifest.id + ".")).toBe(true);
    expect(SVG_EXPORTER_ID.startsWith(drawBundle.manifest.id + ".")).toBe(true);
  });
});
