// Lowered content lands on its frame's page, proven against the REAL core
// engine (data ADR 551, amendment of 2026-11-18). The minimal fixture gets a
// second page; the bound frame sits on page 2 while page 1 is the active page
// (reported explicitly here; a headless host reports none and the bundle's
// fallback answers page 1 the same way). Before the fix the barcode's modules
// were drawn on page 1 at the frame's page-2 coordinates.
//
// Skips without a reachable canvas-wasm; REQUIRE_REAL_CORE=1 fails instead.

import { afterEach, describe, expect, it } from "bun:test";

import type { BundleHost, ElementId, PageId } from "@paged-media/plugin-api";
import { defineBundle, type HeadlessHost } from "@paged-media/plugin-sdk";

import type { LoweredBarcode, LoweredTable } from "../../data-host-model/src";
import manifestJson from "../manifest.json";
import { commitLoweredBarcode, commitLoweredTable } from "../src/lower";
import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";

const run = ENGINE_ANCHOR !== null || REQUIRE_REAL_CORE;

type Box = [number, number, number, number];

/** The fixture plus a page after it, and a host in this module's namespace
 *  (its labels go under x-paged:media.paged.data) that reports page 1 active. */
async function twoPages(
  h: HeadlessHost,
): Promise<{ host: BundleHost; p1: PageId; p2: PageId }> {
  let captured: BundleHost | null = null;
  h.loadBundle(
    defineBundle({
      manifest: manifestJson as never,
      activate(host) {
        captured = host;
        return { dispose() {} };
      },
    }),
  );
  const host = captured! as BundleHost;
  const added = await host.document.mutate({
    op: "insertPage",
    args: { afterPageId: "usp" as PageId, masterId: null },
  });
  expect(added.applied).toBe(true);
  const pages = await host.document.collection<{ selfId: string }>("pages");
  expect(pages.length).toBe(2);
  const p1 = pages[0]!.selfId as PageId;
  const p2 = pages[1]!.selfId as PageId;
  const meta = host.document.meta.bind(host.document);
  (host.document as { meta: unknown }).meta = async () => ({
    ...(await meta()),
    activePage: p1,
  });
  return { host, p1, p2 };
}

/** Where an item stands: its page and its page-local box. */
async function placed(
  h: HeadlessHost,
  ids: ElementId[],
): Promise<{ pageId: string | null | undefined; box: Box }[]> {
  const geom = await h.host.document.elementGeometry(ids);
  return geom.map((g) => {
    const [t, l, b, r] = g.bounds;
    const [a, bb, c, d, e, f] = g.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const xs = [l * a + t * c + e, r * a + b * c + e];
    const ys = [l * bb + t * d + f, r * bb + b * d + f];
    return {
      pageId: g.pageId,
      box: [
        Math.min(...ys),
        Math.min(...xs),
        Math.max(...ys),
        Math.max(...xs),
      ] as Box,
    };
  });
}

const within = (inner: Box, outer: Box) =>
  inner[0] >= outer[0] - 0.01 &&
  inner[1] >= outer[1] - 0.01 &&
  inner[2] <= outer[2] + 0.01 &&
  inner[3] <= outer[3] + 0.01;

const code128 = (target: string): LoweredBarcode =>
  ({
    kind: "barcode",
    target,
    symbology: "code128",
    modules: [
      { xPt: 0, yPt: 0, wPt: 2, hPt: 40 },
      { xPt: 6, yPt: 0, wPt: 1, hPt: 40 },
      { xPt: 10, yPt: 0, wPt: 3, hPt: 40 },
    ],
    modulesX: 13,
    modulesY: 1,
    bounds: { widthPt: 13, heightPt: 40 },
    text: "",
  }) as LoweredBarcode;

const table: LoweredTable = {
  kind: "table",
  region: "region",
  columns: [{ index: 0, header: "SKU", xPt: 0, widthPt: 60 }],
  rows: [
    { cells: ["SKU"], yPt: 0, heightPt: 14, header: true },
    { cells: ["A1"], yPt: 14, heightPt: 14, header: false },
  ],
  rules: [],
  text: "SKU\nA1",
  bounds: { widthPt: 60, heightPt: 28 },
} as LoweredTable;

describe.skipIf(!run)(
  "lowered content lands on its frame's page, against real core [data.barcode.symbology]",
  () => {
    let h: HeadlessHost | null = null;
    afterEach(() => {
      h?.dispose();
      h = null;
    });

    it("draws a barcode bound on page 2 inside its frame on page 2 while page 1 is active", async () => {
      h = await openRealHost();
      const { host, p2 } = await twoPages(h);
      const frame: Box = [200, 100, 260, 220];
      const made = await host.document.mutate({
        op: "insertFrame",
        args: { pageId: p2, bounds: frame },
      });
      if (!made.applied) throw new Error("insertFrame was refused");
      const rect = made.createdId!;
      const [at] = await placed(h, [rect]);
      expect(at!.pageId).toBe(p2);

      const minted: ElementId[] = [];
      const drawn = await commitLoweredBarcode(
        host,
        code128(String(rect.id)),
        String(rect.id),
        undefined,
        { onMinted: (ids) => minted.push(...ids) },
      );
      expect(drawn).toBe(3);
      const modules = minted.filter((e) => e.kind === "polygon");
      expect(modules.length).toBe(3);
      for (const m of await placed(h, modules)) {
        expect(m.pageId).toBe(p2);
        expect(within(m.box, at!.box)).toBe(true);
      }
    });

    it("a table re-lowered over its old frame lands on that frame's page and corner", async () => {
      h = await openRealHost();
      const { host, p2 } = await twoPages(h);
      // The first lowering, on page 2.
      const first = await commitLoweredTable(host, table, undefined, {
        page: Promise.resolve(p2),
      });
      expect(first).not.toBeNull();
      const old = { kind: "textFrame", id: first! } as ElementId;
      const [was] = await placed(h, [old]);
      expect(was!.pageId).toBe(p2);

      // The re-lower that cannot swap it in place: the old frame goes in the
      // batch that places the new one, from page 1.
      const next = await commitLoweredTable(host, table, undefined, undefined, {
        clear: [{ op: "deleteFrame", args: { frameId: first! } }],
        at: { pageId: p2, topPt: was!.box[0], leftPt: was!.box[1] },
      });
      expect(next).not.toBeNull();
      expect(next).not.toBe(first);
      const [now] = await placed(h, [
        { kind: "textFrame", id: next! } as ElementId,
      ]);
      expect(now!.pageId).toBe(p2);
      expect(now!.box[0]).toBeCloseTo(was!.box[0], 1);
      expect(now!.box[1]).toBeCloseTo(was!.box[1], 1);
      expect(await placed(h, [old])).toEqual([]);
    });
  },
);
