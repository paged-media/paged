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
//      / `styleMutationsFor` emit the EXACT shapes + wire mutations the
//      live importer commits (the no-second-copy rule).
//   3. Live round-trip: a real SVG fixture is imported into the headless
//      engine (leaf count grows, the created element's anchor table
//      matches), then the inserted selection is exported back to SVG and
//      re-imported — geometry stable within tolerance.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { Mutation } from "@paged-media/plugin-api";
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
  SVG_IMPORTER_ID,
  SVG_EXPORTER_ID,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

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
    // The defaults point at the minted swatch ids + carry the weight.
    expect(defaults.fillColor).toBe(sw.args.spec.selfId);
    expect(defaults.strokeWeight).toBe(2);
  });

  it("fill:none resolves the fill default to null (no swatch created)", () => {
    const { swatches, defaults } = styleDefaultsForShape({ fill: null });
    expect(swatches.length).toBe(0);
    expect(defaults.fillColor).toBeNull();
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

    // Tear the inserts back out so the suite stays order-independent.
    for (let i = 0; i < ids.length; i++) await h.host.document.undo();
    // Each shape is insertPath (+ style mutations); undo per insert is
    // coarse — just confirm we didn't leave more than we found.
    // (The style mutations are separate undo steps; drain to baseline.)
    let guard = 0;
    while ((await leafCount(h)) > before && guard++ < 30) {
      await h.host.document.undo();
    }
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

    // Clean up: clear selection + drain the inserts.
    await h.host.selection.set([]);
    let guard = 0;
    while ((await leafCount(h)) > baseline && guard++ < 40) {
      await h.host.document.undo();
    }
    expect(await leafCount(h)).toBe(baseline);
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
