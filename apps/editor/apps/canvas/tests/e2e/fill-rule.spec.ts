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

// The fill rule (engine ADR 1006) through the Attributes panel, on a
// donut whose hole is wound THE SAME WAY as its ring: under non-zero it
// fills solid, under even-odd the hole opens. The toggle is driven in the
// real panel; the render must change in the donut's box, the property
// must read back, and one undo must restore the model and the pixels.
// Corpus-free: the document is File ▸ New and the donut is written in
// code.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../journey/driver/designer";
import { opSandwich } from "./harness/op-sandwich";
import { mutate, openPanel, selectElements } from "./harness/ui";

type Ref = { kind: string; id: string };

interface CanvasGlobal {
  __canvas: {
    client: {
      collection: (n: string) => Promise<Array<Record<string, unknown>>>;
      executeScript: (
        s: string,
      ) => Promise<{ output: string[]; error: string | null }>;
      elementProperties: (id: unknown) => Promise<{
        entries: Array<{ path: string; value: unknown }>;
      } | null>;
    };
  };
}

/** A clockwise square (y down) as corner anchors, offset by `o`. */
const square = (
  x: number,
  y: number,
  n: number,
  o: readonly [number, number] = [0, 0],
) =>
  (
    [
      [x, y],
      [x + n, y],
      [x + n, y + n],
      [x, y + n],
    ] as const
  ).map(([px, py]) => {
    const p: [number, number] = [px + o[0], py + o[1]];
    return { anchor: p, left: p, right: p };
  });

async function firstPage(page: Page) {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.pages()");
    const pages = JSON.parse(r.output[0] ?? "[]") as Array<{
      selfId: string;
      sizePt: [number, number];
    }>;
    const rows = await c.collection("pages");
    const row = rows.find((p) => p.selfId === pages[0]!.selfId);
    const origin = Array.isArray(row?.pageOrigin)
      ? (row!.pageOrigin as [number, number])
      : ([0, 0] as [number, number]);
    return { pageId: pages[0]!.selfId, widthPt: pages[0]!.sizePt[0], origin };
  });
}

async function polygons(page: Page): Promise<Ref[]> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.tree()");
    type Node = { id?: Ref | null; children?: Node[] };
    const out: Ref[] = [];
    const walk = (nodes: Node[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.id?.kind === "polygon") out.push(n.id);
        walk(n.children);
      }
    };
    walk(JSON.parse(r.output[0] ?? "[]") as Node[]);
    return out;
  });
}

async function fillRule(page: Page, ref: Ref): Promise<unknown> {
  return page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const props = await c.elementProperties(id);
    const v = props?.entries.find((e) => e.path === "frameFillRule")?.value as
      { value?: unknown } | undefined;
    return v?.value ?? null;
  }, ref);
}

test.describe("the fill rule in the Attributes panel", () => {
  test("AC-FILL-RULE-1 — Even-Odd opens the hole of a same-wound donut, reads back, one undo restores @feat:frames-paths.fill-rule-even-odd @feat:editor-shell.panels.attributes @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.attributes");
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const { pageId, widthPt, origin } = await firstPage(page);

    // The ring and its hole, both clockwise: one path of two contours.
    // `insertPath` takes page space, `framePath` stores spread space.
    const outer = square(100, 100, 200);
    const before = (await polygons(page)).length;
    await mutate(page, {
      op: "batch",
      args: {
        ops: [
          { op: "insertPath", args: { pageId, anchors: outer, open: false } },
          { op: "bindCreated", args: { handle: "d" } },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "polygon", id: "$h:d" },
              path: "framePath",
              value: {
                type: "framePath",
                value: {
                  anchors: [
                    ...square(100, 100, 200, origin),
                    ...square(160, 160, 80, origin),
                  ],
                  subpathStarts: [0, 4],
                },
              },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "polygon", id: "$h:d" },
              path: "frameFillColor",
              value: { type: "colorRef", value: "Color/Black" },
            },
          },
        ],
      },
    });
    const all = await polygons(page);
    expect(all.length).toBe(before + 1);
    const donut = all[all.length - 1]!;

    await openPanel(page, "paged.attributes");
    await selectElements(page, [donut]);
    const evenOdd = page.locator('[data-fill-rule="EvenOdd"]');
    const nonZero = page.locator('[data-fill-rule="NonZero"]');
    await expect(nonZero).toHaveAttribute("aria-pressed", "true");
    await expect(evenOdd).toBeEnabled();
    expect(await fillRule(page, donut)).toBe("NonZero");

    await opSandwich(page, {
      pageId,
      pageWidthPt: widthPt,
      // The hole: the only pixels the rule changes.
      region: { top: 160, left: 160, bottom: 240, right: 240 },
      regionSlackPx: 4,
      apply: async () => {
        await evenOdd.click();
      },
      expectModel: async () => {
        expect(await fillRule(page, donut)).toBe("EvenOdd");
        await expect(evenOdd).toHaveAttribute("aria-pressed", "true");
      },
      dumpModel: async () => JSON.stringify(await fillRule(page, donut)),
      expectRestored: async () => {
        expect(await fillRule(page, donut)).toBe("NonZero");
        await expect(nonZero).toHaveAttribute("aria-pressed", "true");
      },
    });
  });
});
