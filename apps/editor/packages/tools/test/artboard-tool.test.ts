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

// Engine ADR 1011 — the Artboard tool and the artboard geometry: select,
// move with snapping, Alt-drag duplicate, resize with the content staying,
// nudge, delete; one undo step per gesture.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  ARTBOARD_META_KEY,
  artboardFileName,
  artboardNameOf,
  artboardsOf,
  gridLayout,
  rearrangeMutation,
  renameArtboardMutation,
  resizeArtboardMutation,
  snapMove,
} from "../src/artboards/model";
import { artboardSelectionOf } from "../src/artboards/selection";
import { createArtboardHandler } from "../src/handlers/artboard-tool";
import { harness, quietWarnings } from "./support";

/** Two boards: a Letter page at the origin and a 400 × 300 board placed at
 *  (700, 0). */
const PAGES = [
  { id: "page-1", origin: [0, 0] as const, size: [612, 792] as const },
  { id: "page-2", origin: [700, 0] as const, size: [400, 300] as const },
];
const SUMMARIES = [
  {
    selfId: "page-1",
    index: 1,
    sizePt: [612, 792],
    canvasOriginPt: [0, 0],
    canvasPlaced: false,
    boundsPt: [0, 0, 792, 612],
    pluginMetadata: [],
  },
  {
    selfId: "page-2",
    index: 2,
    sizePt: [400, 300],
    canvasOriginPt: [700, 0],
    canvasPlaced: true,
    boundsPt: [0, 0, 300, 400],
    pluginMetadata: [
      {
        key: ARTBOARD_META_KEY,
        value: JSON.stringify({ v: 1, data: { name: "Banner" } }),
      },
    ],
  },
];

function boards() {
  return harness({ pages: PAGES, collections: { pages: SUMMARIES } });
}

describe("Artboard tool", () => {
  it("a drag moves the board it starts on, one placePage @level:gesture", async () => {
    covers("tool:paged.tool.artboard");
    const { fake, g } = boards();
    await g
      .tool(createArtboardHandler)
      .settle()
      .drag({ from: [800, 100], to: [900, 150] })
      .settle();
    expect(fake.mutations()).toEqual([
      { op: "placePage", args: { page: "page-2", originPt: [800, 50] } },
    ]);
    expect(fake.undoDepth()).toBe(1);
    expect(artboardSelectionOf(fake.shell.client).get()).toBe("page-2");
  });

  it("a moved board snaps to the default gap beside another @level:gesture", async () => {
    const { fake, g } = boards();
    // Left edge at 640: 4 pt from page-1's right edge + the 24 pt gap.
    await g
      .tool(createArtboardHandler)
      .settle()
      .drag({ from: [800, 100], to: [740, 100] })
      .settle();
    expect(fake.mutations()).toEqual([
      { op: "placePage", args: { page: "page-2", originPt: [636, 0] } },
    ]);
  });

  it("Shift keeps a move on one axis @level:gesture", async () => {
    const { fake, g } = boards();
    await g
      .tool(createArtboardHandler)
      .settle()
      .drag({ from: [800, 100], to: [900, 130], mods: ["shift"] })
      .settle();
    expect(fake.mutations()).toEqual([
      { op: "placePage", args: { page: "page-2", originPt: [800, 0] } },
    ]);
  });

  it("a click selects without writing; Escape deselects @level:gesture", async () => {
    const { fake, g } = boards();
    await g.tool(createArtboardHandler).settle().click([100, 100]).settle();
    const sel = artboardSelectionOf(fake.shell.client);
    expect(sel.get()).toBe("page-1");
    expect(fake.mutations()).toEqual([]);
    await g.key("Escape").settle();
    expect(sel.get()).toBeNull();
    // A click on the pasteboard deselects too.
    await g.click([100, 100]).click([650, 900]).settle();
    expect(sel.get()).toBeNull();
  });

  it("dragging a corner handle resizes the board, the content staying put @level:gesture", async () => {
    const { fake, g } = boards();
    await g
      .tool(createArtboardHandler)
      .settle()
      .click([800, 100])
      .drag({ from: [700, 0], to: [680, -10] })
      .settle();
    // The top-left moved by (-20, -10): the page grows on its own top and
    // left and moves by as much, so its content stays where it was.
    expect(fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            {
              op: "resizePage",
              args: { pageId: "page-2", bounds: [-10, -20, 300, 400] },
            },
            {
              op: "placePage",
              args: { page: "page-2", originPt: [680, -10] },
            },
          ],
        },
      },
    ]);
    expect(fake.undoDepth()).toBe(1);
  });

  it("Alt-drag duplicates the board where it is dropped, in one undo step @level:gesture", async () => {
    let amended: unknown = null;
    const { fake, g } = harness({
      pages: PAGES,
      collections: { pages: SUMMARIES },
      reply(message) {
        const m = message as { kind: string; payload?: { op?: string } };
        if (m.kind === "mutate" && m.payload?.op === "duplicatePage") {
          return {
            kind: "mutationApplied",
            payload: {
              appliedSeq: 41,
              pageIds: [],
              createdPages: ["page-3"],
              cacheStats: {},
            },
          };
        }
        if (m.kind === "amendMutation") {
          amended = m.payload;
          return { kind: "mutationApplied", payload: { appliedSeq: 41 } };
        }
        return undefined;
      },
    });
    await g
      .tool(createArtboardHandler)
      .settle()
      .drag({ from: [800, 100], to: [800, 550], mods: ["alt"] })
      .settle();
    const sent = fake.ofChannel("mutation");
    expect(sent.map((e) => e.mutation)).toEqual([
      { op: "duplicatePage", args: { page: "page-2" } },
      { op: "placePage", args: { page: "page-3", originPt: [700, 450] } },
    ]);
    expect(sent[1].amend).toBe(41);
    expect(amended).toEqual({
      appliedSeq: 41,
      mutation: {
        op: "placePage",
        args: { page: "page-3", originPt: [700, 450] },
      },
    });
    expect(artboardSelectionOf(fake.shell.client).get()).toBe("page-3");
  });

  it("arrow keys nudge the selected board; Delete deletes it @level:gesture", async () => {
    const { fake, g } = boards();
    await g
      .tool(createArtboardHandler)
      .settle()
      .click([800, 100])
      .key("ArrowRight")
      .key("ArrowDown", { mods: ["shift"] })
      .settle();
    await g.key("Delete").settle();
    expect(fake.mutations()).toEqual([
      { op: "placePage", args: { page: "page-2", originPt: [701, 0] } },
      { op: "placePage", args: { page: "page-2", originPt: [700, 10] } },
      { op: "deletePage", args: { pageId: "page-2" } },
    ]);
  });

  it("a refused placement is warned, not thrown @level:gesture", async () => {
    const { fake, g } = harness({
      pages: PAGES,
      collections: { pages: SUMMARIES },
      refuse: (m) => (m.op === "placePage" ? "locked" : null),
    });
    const restore = quietWarnings();
    try {
      await g
        .tool(createArtboardHandler)
        .settle()
        .drag({ from: [800, 100], to: [900, 150] })
        .settle();
    } finally {
      restore();
    }
    expect(fake.undoDepth()).toBe(0);
  });

  it("the selected board shows its outline, handles and name @level:gesture", async () => {
    const { fake, g } = boards();
    await g.tool(createArtboardHandler).settle().click([800, 100]).settle();
    const shapes = fake.currentPreview() as unknown as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(shapes)).toBe(true);
    expect(shapes[0]).toEqual({ pageId: "page-2", rect: [0, 0, 300, 400] });
    expect((shapes[1].cells as unknown[]).length).toBe(8);
    expect(shapes[2]).toMatchObject({ kind: "text", text: "Banner" });
  });
});

describe("artboard geometry", () => {
  it("reads boards, names and their default slots", () => {
    const list = artboardsOf(SUMMARIES, (i) => `Zeichenfläche ${i}`);
    expect(list.map((b) => [b.name, b.named, b.x, b.y])).toEqual([
      ["Zeichenfläche 1", false, 0, 0],
      ["Banner", true, 700, 0],
    ]);
    // Without origins (an older engine) the boards stack.
    const old = artboardsOf(
      SUMMARIES.map(({ canvasOriginPt: _, ...p }) => p),
      String,
    );
    expect(old.map((b) => [b.x, b.y])).toEqual([
      [0, 0],
      [0, 816],
    ]);
    expect(artboardNameOf({ selfId: "x", sizePt: [1, 1] })).toBeNull();
  });

  it("names a board through its page metadata", () => {
    expect(renameArtboardMutation("p", "  Cover ")).toEqual({
      op: "setPageMetadata",
      args: {
        page: "p",
        key: ARTBOARD_META_KEY,
        value: JSON.stringify({ v: 1, data: { name: "Cover" } }),
      },
    });
    expect(renameArtboardMutation("p", "").args.value).toBeNull();
  });

  it("lays boards out in a grid, rows as tall as their tallest", () => {
    const list = artboardsOf(
      [
        { selfId: "a", sizePt: [100, 50], canvasOriginPt: [10, 20] },
        { selfId: "b", sizePt: [80, 90], canvasOriginPt: [500, 500] },
        { selfId: "c", sizePt: [60, 40], canvasOriginPt: [0, 0] },
      ],
      String,
    );
    expect(gridLayout(list, 2, 10)).toEqual([
      [10, 20],
      [120, 20],
      [10, 120],
    ]);
    expect(
      rearrangeMutation(list, 1, 0).args.ops.map((o) => o.args.originPt),
    ).toEqual([
      [10, 20],
      [10, 70],
      [10, 160],
    ]);
  });

  it("snaps a move to another board's edge within the tolerance only", () => {
    const other = { x: 0, y: 0, w: 100, h: 100 };
    expect(snapMove({ x: 103, y: 300, w: 50, h: 50 }, [other], 4).rect.x).toBe(
      100,
    );
    expect(snapMove({ x: 110, y: 300, w: 50, h: 50 }, [other], 4).rect.x).toBe(
      110,
    );
  });

  it("a resize without known page bounds writes nothing", () => {
    const [b] = artboardsOf([{ selfId: "a", sizePt: [10, 10] }], String);
    expect(resizeArtboardMutation(b, { x: 0, y: 0, w: 20, h: 20 })).toBeNull();
  });

  it("names export files after their boards, unique and safe", () => {
    const taken = new Set<string>();
    expect(artboardFileName("Cover", "png", taken)).toBe("Cover.png");
    expect(artboardFileName("cover", "png", taken)).toBe("cover 2.png");
    expect(artboardFileName("a/b:c", "pdf", taken)).toBe("a-b-c.pdf");
    expect(artboardFileName("  ", "png", taken)).toBe("artboard.png");
  });
});
