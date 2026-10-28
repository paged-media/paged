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

// Engine ADR 1011 — the Artboards panel (paged.artboards) over the real
// engine: one row per board with its default name and size; a click
// selects the board (the Artboard tool's selection); Artboard options
// rename it, set a size preset and swap its orientation; Rearrange all
// is one batch (one undo step); Export writes one file per board, named
// after it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { artboardSelectionOf } from "@paged-media/tools";

import { ArtboardsPanel } from "../../src/panels/artboards-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  routeShellEvents,
  rows,
  structureIdml,
  STRUCTURE,
} from "./support/structure";

afterEach(unmountAll);

const mount = async () => {
  const h = await mountPanel(ArtboardsPanel, {
    id: "paged.artboards",
    document: structureIdml(),
  });
  routeShellEvents(h);
  return h;
};

const row = (root: Element, key: string) =>
  root.querySelector<HTMLElement>(`[data-list-row="${key}"]`)!;

type Page = {
  selfId: string;
  sizePt: [number, number];
  canvasOriginPt?: [number, number];
};
const pages = async (h: PanelHarness<unknown>) =>
  (await h.client.collection("pages")) as Page[];

describe("Artboards panel", () => {
  test("lists every board with its default name and size", async () => {
    covers("panel:paged.artboards");
    const h = await mount();
    expect(rows(h.root).map((r) => [r.key, r.primary, r.secondary])).toEqual([
      [STRUCTURE.page1, "Artboard 1", "612 × 792 pt"],
      [STRUCTURE.page2, "Artboard 2", "612 × 792 pt"],
    ]);
    expect(h.root.querySelector("[data-artboard-options]")).toBeNull();
  });

  test("a row selects its board for the tool too, and shows its options", async () => {
    covers("panel:paged.artboards");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page2));
    expect(artboardSelectionOf(h.client).get()).toBe(STRUCTURE.page2);
    expect(
      h.root
        .querySelector("[data-artboard-options]")
        ?.getAttribute("data-artboard-options"),
    ).toBe(STRUCTURE.page2);
  });

  test("renaming writes the page's artboard metadata; the row shows the name", async () => {
    covers("panel:paged.artboards");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page1));
    const input = h.root.querySelector<HTMLInputElement>(
      "[data-artboard-name]",
    )!;
    const from = h.mark();
    await h.user.click(input);
    await h.user.keyboard("Cover{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([
      {
        op: "setPageMetadata",
        args: {
          page: STRUCTURE.page1,
          key: "x-paged:paged.artboard",
          value: JSON.stringify({ v: 1, data: { name: "Cover" } }),
        },
      },
    ] as never);
    expect(rows(h.root)[0].primary).toBe("Cover");
  });

  test("a size preset resizes the board; Landscape swaps it; each one undo step", async () => {
    covers("panel:paged.artboards");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page1));
    const select = h.root.querySelector<HTMLSelectElement>(
      "[data-artboard-preset] select, select[data-artboard-preset]",
    )!;
    const from = h.mark();
    await h.user.selectOptions(select, "a4");
    await h.settle();
    expect(h.mutations(from)).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            {
              op: "resizePage",
              args: { pageId: STRUCTURE.page1, bounds: [0, 0, 841.89, 595.28] },
            },
          ],
        },
      },
    ] as never);
    expect((await pages(h))[0].sizePt.map(Math.round)).toEqual([595, 842]);
    await h.click(
      h.root.querySelector<HTMLElement>(
        '[data-artboard-orientation="landscape"]',
      )!,
    );
    expect((await pages(h))[0].sizePt.map(Math.round)).toEqual([842, 595]);
    await h.act(() => h.client.undo());
    expect((await pages(h))[0].sizePt.map(Math.round)).toEqual([595, 842]);
  });

  test("Rearrange all places every board in a grid; one undo puts them back", async () => {
    covers("panel:paged.artboards");
    const h = await mount();
    const before = (await pages(h)).map((p) => p.canvasOriginPt);
    const from = h.mark();
    await h.click(
      h.root.querySelector<HTMLElement>("[data-artboard-rearrange-apply]")!,
    );
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { ops: Array<{ op: string; args: { originPt: number[] } }> };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("batch");
    expect(sent[0].args.ops.map((o) => o.args.originPt)).toEqual([
      [0, 0],
      [612 + 72, 0],
    ]);
    expect((await pages(h)).map((p) => p.canvasOriginPt)).toEqual([
      [0, 0],
      [684, 0],
    ]);
    await h.act(() => h.client.undo());
    expect((await pages(h)).map((p) => p.canvasOriginPt)).toEqual(before);
  });

  test("Export all writes one PNG per board, named after it", async () => {
    covers("panel:paged.artboards");
    const h = await mount();
    const names: string[] = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      names.push(this.download);
    };
    try {
      await h.click(
        h.root.querySelector<HTMLElement>("[data-artboard-export-all]")!,
      );
      await h.settle();
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
    expect(names).toEqual(["Artboard 1.png", "Artboard 2.png"]);
    expect(
      h.root.querySelector("[data-artboard-export-status]")?.textContent,
    ).toBe("2 file(s) exported");
  });
});
