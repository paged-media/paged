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

// OBJECT ▸ RASTERIZE (extensions ADR 338, `render.snapshot@2`) through the
// REAL engine: the selection becomes one image frame in ONE undo step, and
// the image draws what the vectors drew — its pixels match a snapshot of
// the originals within a resampling tolerance; one undo brings the vectors
// back. The pure parts are pinned in `test/commands/rasterize.spec.ts`.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";
import { rasterizeElements, type HeadlessHost } from "@paged-media/plugin-sdk";

import { applyRasterize, drawBundle } from "../../src/index";
import { packageWithSpread } from "../fixtures/build-idml";
import { countingHost } from "../perf/counting-host";
import { openHost } from "./host";
import { treeShapeOf, undoMarkOn, undoStepsBackTo } from "./one-batch";

const DOC = packageWithSpread(
  `<Rectangle Self="ur" GeometricBounds="100 100 160 220" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black" StrokeColor="Swatch/None"/>` +
    `<Group Self="ug" ItemTransform="1 0 0 1 0 0">` +
    `<Oval Self="uo" GeometricBounds="200 100 260 180" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black" StrokeColor="Swatch/None"/>` +
    `<Rectangle Self="us2" GeometricBounds="210 200 250 260" ItemTransform="1 0 0 1 0 0" FillColor="Swatch/None" StrokeColor="Color/Black" StrokeWeight="6"/>` +
    `</Group>` +
    `<Rectangle Self="ukeep" GeometricBounds="400 100 450 150" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black" StrokeColor="Swatch/None"/>`,
);

const RECT = { kind: "rectangle", id: "ur" } as ElementId;
const GROUP = { kind: "group", id: "ug" } as ElementId;
const KEEP = { kind: "rectangle", id: "ukeep" } as ElementId;

describe("draw — Object ▸ Rasterize (extensions ADR 338) [plugin-platform.render-snapshot-v2]", () => {
  describe("through the real engine", () => {
    let h: HeadlessHost;
    const leaves = async (): Promise<string[]> => {
      const out: string[] = [];
      const walk = (nodes: readonly SceneTreeNode[]) => {
        for (const n of nodes) {
          if (n.id && typeof n.id.id === "string")
            out.push(`${n.id.kind}:${n.id.id}`);
          walk(n.children ?? []);
        }
      };
      walk(await h.host.document.tree());
      return out;
    };

    beforeAll(async () => {
      h = await openHost();
      h.loadBundle(drawBundle);
    });
    beforeEach(async () => {
      await h.load(DOC);
    });
    afterAll(() => h?.dispose());

    it("the selection becomes ONE image frame in ONE undo step, drawing what the vectors drew", async () => {
      covers("command:media.paged.draw.command.rasterize");
      expect(h.host.supports("render.snapshot@2")).toBe(true);
      const selection = [RECT, GROUP];
      // The originals' pixels, alone on a transparent ground, at 144 ppi.
      const before = (await rasterizeElements(h.host, selection, {
        ppi: 144,
      }))!;
      expect(before).not.toBeNull();
      // The 6 pt stroke reaches 3 pt past its rectangle's right edge.
      expect(before.region.x).toBeLessThanOrEqual(100);
      expect(before.region.x + before.region.width).toBeGreaterThanOrEqual(263);

      const shape = treeShapeOf(await h.host.document.tree());
      const mark = await undoMarkOn(h, KEEP);
      await h.host.selection.set(selection);
      const counted = countingHost(h.host);
      const image = await applyRasterize(counted.host, {
        ppi: 144,
        background: "transparent",
      });
      expect(image).not.toBeNull();
      expect(counted.work.mutations).toHaveLength(1);

      const after = await leaves();
      for (const gone of [
        "rectangle:ur",
        "group:ug",
        "oval:uo",
        "rectangle:us2",
      ])
        expect(after).not.toContain(gone);
      expect(after).toContain("rectangle:ukeep");
      expect(after).toContain(`${image!.kind}:${String(image!.id)}`);
      expect(h.host.selection.get()).toEqual([image!]);

      // The image draws where the vectors drew, with their pixels.
      const drawn = (await rasterizeElements(h.host, [image!], { ppi: 144 }))!;
      expect(drawn).not.toBeNull();
      expect(Math.abs(drawn.region.x - before.region.x)).toBeLessThan(1);
      expect(Math.abs(drawn.region.y - before.region.y)).toBeLessThan(1);
      expect(Math.abs(drawn.widthPx - before.widthPx)).toBeLessThanOrEqual(1);
      expect(Math.abs(drawn.heightPx - before.heightPx)).toBeLessThanOrEqual(1);
      const w = Math.min(drawn.widthPx, before.widthPx);
      const hgt = Math.min(drawn.heightPx, before.heightPx);
      let far = 0;
      let sum = 0;
      for (let y = 0; y < hgt; y++) {
        for (let x = 0; x < w; x++) {
          const a = (y * before.widthPx + x) * 4;
          const b = (y * drawn.widthPx + x) * 4;
          // Compare premultiplied: a transparent pixel's colour is moot.
          let d = 0;
          for (let c = 0; c < 3; c++) {
            d = Math.max(
              d,
              Math.abs(
                (before.rgba[a + c] * before.rgba[a + 3]) / 255 -
                  (drawn.rgba[b + c] * drawn.rgba[b + 3]) / 255,
              ),
            );
          }
          d = Math.max(d, Math.abs(before.rgba[a + 3] - drawn.rgba[b + 3]));
          sum += d;
          if (d > 48) far++;
        }
      }
      // Resampling softens the edges a little; nothing else differs.
      expect(sum / (w * hgt)).toBeLessThan(6);
      expect(far / (w * hgt)).toBeLessThan(0.03);

      // ONE undo step, and taking it back restores the vectors.
      expect(await undoStepsBackTo(h, mark)).toBe(1);
      expect(treeShapeOf(await h.host.document.tree())).toBe(shape);
    });

    it("on a white ground the image is opaque; with nothing selected nothing happens", async () => {
      await h.host.selection.set([RECT]);
      const image = await applyRasterize(h.host, {
        ppi: 72,
        background: "paper",
      });
      expect(image).not.toBeNull();
      const drawn = (await rasterizeElements(h.host, [image!], { ppi: 72 }))!;
      let opaque = true;
      for (let i = 3; i < drawn.rgba.length; i += 4)
        if (drawn.rgba[i] !== 255) opaque = false;
      expect(opaque).toBe(true);

      await h.host.selection.set([]);
      const before = await leaves();
      expect(await applyRasterize(h.host)).toBeNull();
      expect(await leaves()).toEqual(before);
    });
  });
});
