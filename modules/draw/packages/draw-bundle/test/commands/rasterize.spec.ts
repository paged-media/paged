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

// OBJECT ▸ RASTERIZE (extensions ADR 338) — the pure parts: the
// parameters' sanitiser, what a selected group removes, and the ONE
// batch's wire shape (insert, bind, place, then the originals: dissolves
// before deletes). Through the real engine: `test/headless/rasterize.spec.ts`.

import { describe, expect, it } from "bun:test";

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import {
  pngDataUri,
  rasterizeBatchFor,
  rasterizeParamsFrom,
  removalOf,
} from "../../src/index";

const RECT = { kind: "rectangle", id: "ur" } as ElementId;
const GROUP = { kind: "group", id: "ug" } as ElementId;
const KEEP = { kind: "rectangle", id: "ukeep" } as ElementId;

type Op = { op: string; args: Record<string, unknown> };
const opsOf = (m: unknown): Op[] => (m as { args: { ops: Op[] } }).args.ops;

const node = (
  id: ElementId | null,
  children: SceneTreeNode[] = [],
): SceneTreeNode =>
  ({ id, kind: id?.kind ?? "page", label: "", children }) as SceneTreeNode;

describe("draw — Object ▸ Rasterize, the pure parts [plugin-platform.render-snapshot-v2]", () => {
  it("parameters: a ppi clamped to 1–2400 and rounded, the ground one of two", () => {
    expect(rasterizeParamsFrom(undefined)).toEqual({
      ppi: 300,
      background: "transparent",
    });
    expect(rasterizeParamsFrom({ ppi: 99999, background: "paper" })).toEqual({
      ppi: 2400,
      background: "paper",
    });
    expect(rasterizeParamsFrom({ ppi: 0.2, background: "green" })).toEqual({
      ppi: 1,
      background: "transparent",
    });
    expect(rasterizeParamsFrom({ ppi: 149.6 }).ppi).toBe(150);
  });

  it("a selected group removes itself, its nested groups (outermost first) and every leaf", () => {
    const roots = [
      node(null, [
        node(RECT),
        node(GROUP, [
          node({ kind: "oval", id: "uo" } as ElementId),
          node({ kind: "group", id: "inner" } as ElementId, [
            node({ kind: "polygon", id: "up" } as ElementId),
          ]),
        ]),
        node(KEEP),
      ]),
    ];
    expect(removalOf(roots, [RECT, GROUP])).toEqual({
      groups: ["ug", "inner"],
      leaves: ["ur", "uo", "up"],
    });
    // A member of a selected group is covered by the group.
    expect(
      removalOf(roots, [GROUP, { kind: "oval", id: "uo" } as ElementId]),
    ).toEqual({ groups: ["ug", "inner"], leaves: ["uo", "up"] });
  });

  it("one batch: insert, bind, place the PNG fitted to the frame, then dissolves before deletes", () => {
    covers("command:media.paged.draw.command.rasterize");
    const ops = opsOf(
      rasterizeBatchFor({
        pageId: "p",
        bounds: [10, 20, 30, 40],
        png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        remove: { groups: ["g"], leaves: ["a", "b"] },
      }),
    );
    expect(ops.map((o) => o.op)).toEqual([
      "insertFrame",
      "bindCreated",
      "placeImage",
      "dissolveGroup",
      "deleteFrame",
      "deleteFrame",
    ]);
    expect(ops[0].args).toEqual({ pageId: "p", bounds: [10, 20, 30, 40] });
    expect(ops[2].args).toEqual({
      elementId: "$h:raster",
      uri: "data:image/png;base64,iVBORw==",
      fit: "FitContentToFrame",
    });
    expect(ops[3].args).toEqual({ groupId: "g" });
    expect(ops[5].args).toEqual({ frameId: "b" });
  });

  it("a PNG of any size becomes one base64 data URI", () => {
    const big = new Uint8Array(100_000).map((_, i) => i & 0xff);
    const uri = pngDataUri(big);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    const back = Uint8Array.from(
      atob(uri.slice("data:image/png;base64,".length)),
      (c) => c.charCodeAt(0),
    );
    expect(back).toEqual(big);
  });
});
