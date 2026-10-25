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

// paged.draw's SVG importer and exporter on the ENGINE lane (engine ADR
// 1016, `document.importSvg@1` / `document.exportSvg@1`): through the
// real engine, the registered importer brings in what the module's own
// reader never could — a gradient, `<use>`, a CSS class, a clip path — as
// ONE undo step, logs the engine's report, and the registered exporter
// writes what the selection draws. `svg-io.spec.ts` and
// `svg-compound.spec.ts` pin the fallback lane (`tsLane`).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { parseSvgDocument } from "@paged-media/draw-geometry";

import { drawBundle, importSvg, leafIdsOf, SVG_EXPORTER_ID } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
  <style>.hot { fill: #ff0000 }</style>
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#ff8800"/><stop offset="1" stop-color="#0088ff"/></linearGradient>
    <rect id="sq" width="40" height="40"/>
    <clipPath id="c"><circle cx="200" cy="200" r="30"/></clipPath>
    <filter id="f"><feGaussianBlur stdDeviation="2"/></filter>
  </defs>
  <rect x="20" y="20" width="120" height="80" fill="url(#g)"/>
  <use href="#sq" x="160" y="20" class="hot"/>
  <rect x="160" y="160" width="80" height="80" fill="#00aa00" clip-path="url(#c)"/>
  <rect x="20" y="160" width="40" height="40" fill="#000" filter="url(#f)"/>
</svg>`;

const file = (name: string, svg: string) => ({
  name,
  bytes: new TextEncoder().encode(svg),
  mimeType: "image/svg+xml",
});

describe("draw SVG on the engine lane [plugin-draw.interchange-v2]", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("the host offers the engine's doors", () => {
    expect(h.host.supports("document.importSvg@1")).toBe(true);
    expect(h.host.supports("document.exportSvg@1")).toBe(true);
  });

  it("imports a gradient, a <use> with a CSS class and a clip as native items in one undo step", async () => {
    covers("importer:media.paged.draw.importer.svg");
    const before = leafIdsOf(await h.host.document.tree()).length;
    const ids = await importSvg(h.host, file("engine.svg", SVG));
    // Four shapes, one of them inside its clip frame.
    expect(ids.length).toBeGreaterThanOrEqual(4);
    const after = leafIdsOf(await h.host.document.tree());
    expect(after.length).toBeGreaterThan(before);
    // The gradient is a native gradient swatch.
    const gradients = await h.host.document.collection<{ selfId: string }>(
      "gradients",
    );
    expect(gradients.some((g) => g.selfId.startsWith("Gradient/svg-"))).toBe(
      true,
    );
    await h.host.document.undo();
    expect(leafIdsOf(await h.host.document.tree()).length).toBe(before);
  });

  it("exports what the selection draws, its fill and stroke as one path", async () => {
    covers("exporter:media.paged.draw.exporter.svg");
    const exporter = h
      .exportersContributed()
      .find((c) => c.id === SVG_EXPORTER_ID)!;
    const ids = await importSvg(
      h.host,
      file(
        "two.svg",
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
          <rect x="20" y="20" width="100" height="50" fill="#ff8800" stroke="#222222" stroke-width="2"/>
          <circle cx="200" cy="60" r="40" fill="url(#none)" />
        </svg>`,
      ),
    );
    await h.host.selection.set(ids as ElementId[]);
    const out = await exporter.export();
    const text = new TextDecoder().decode(out!.bytes);
    expect(text).toContain('viewBox="19 19 102 52"');
    const shapes = parseSvgDocument(text)!.shapes;
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.style.fill).toBe("#ff8800");
    expect(shapes[0]!.style.stroke).toBe("#222222");
    await h.host.selection.set([]);
    await h.host.document.undo();
  });
});
