// A barcode lands in its frame: on the frame's own page, whatever page is
// active, at the frame's page coordinates — its own bounds through its item
// transform. On a verso the bounds alone sit a page width into the spread, and
// the symbol was drawn beside its frame; drawn on the active page, it landed
// at the frame's coordinates on whatever page was showing (the cover, in the
// showcase's catalog chapter).

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import { commitLoweredBarcode } from "../lower";

const KEY = "x-paged:media.paged.data";

function fakeHost(
  itemTransform: number[] | null,
  where: { active?: string; framePage?: string | null } = {},
) {
  const sent: any[] = [];
  const framePage = "framePage" in where ? where.framePage : "p2";
  const host = {
    log: { info() {}, warn() {}, debug() {} },
    document: {
      meta: async () => ({ activePage: where.active ?? "p2" }),
      collection: async () => [],
      elementGeometry: async () => [
        {
          id: { kind: "rectangle", id: "u1" },
          ...(framePage !== undefined ? { pageId: framePage } : {}),
          bounds: [100, -480, 172, -408],
          ...(itemTransform ? { itemTransform } : {}),
        },
      ],
      mutate: async (m: any) => {
        sent.push(m);
        return { applied: true, minted: [] };
      },
    },
  } as unknown as BundleHost;
  return { host, sent };
}

const BARCODE: any = {
  target: "u1",
  symbology: "qr",
  modules: [
    { xPt: 0, yPt: 0, wPt: 2, hPt: 2 },
    { xPt: 4, yPt: 0, wPt: 2, hPt: 2 },
  ],
  modulesX: 3,
  modulesY: 1,
  bounds: { widthPt: 72, heightPt: 72 },
  text: "",
};

const firstAnchor = (sent: any[]) =>
  sent[0].args.ops.find((o: any) => o.op === "insertPath").args.anchors[0]
    .anchor;

const pagesDrawnOn = (sent: any[]) => [
  ...new Set(
    sent[0].args.ops
      .filter((o: any) => o.op === "insertPath")
      .map((o: any) => o.args.pageId),
  ),
];

describe("commitLoweredBarcode [data.barcode.symbology]", () => {
  it("draws a verso frame's symbol inside the frame, through its item transform", async () => {
    const { host, sent } = fakeHost([1, 0, 0, 1, 540, 0]);
    await commitLoweredBarcode(host, BARCODE, "u1", {
      binding: "b1",
      def: null,
      session: null,
    });
    expect(firstAnchor(sent)).toEqual([60, 100]);
  });

  it("draws on the frame's page, not the active page", async () => {
    const { host, sent } = fakeHost([1, 0, 0, 1, 540, 0], {
      active: "p1",
      framePage: "p2",
    });
    expect(await commitLoweredBarcode(host, BARCODE, "u1")).toBe(2);
    expect(pagesDrawnOn(sent)).toEqual(["p2"]);
    expect(firstAnchor(sent)).toEqual([60, 100]);
  });

  it("refuses a frame on the pasteboard instead of drawing on the active page", async () => {
    const { host, sent } = fakeHost([1, 0, 0, 1, 540, 0], {
      active: "p1",
      framePage: null,
    });
    expect(await commitLoweredBarcode(host, BARCODE, "u1")).toBe(0);
    expect(sent).toEqual([]);
  });

  it("falls back to the active page for a host that names no page", async () => {
    const { host, sent } = fakeHost([1, 0, 0, 1, 540, 0], {
      active: "p1",
      framePage: undefined,
    });
    await commitLoweredBarcode(host, BARCODE, "u1");
    expect(pagesDrawnOn(sent)).toEqual(["p1"]);
  });

  it("reads bounds as they are from a host that sends no transform", async () => {
    const { host, sent } = fakeHost(null);
    await commitLoweredBarcode(host, BARCODE, "u1");
    expect(firstAnchor(sent)).toEqual([-480, 100]);
  });

  it("stamps the last module with the symbol's module count", async () => {
    const { host, sent } = fakeHost(null);
    await commitLoweredBarcode(host, BARCODE, "u1", {
      binding: "b1",
      def: null,
      session: null,
    });
    const stamps = sent[0].args.ops.filter(
      (o: any) => o.op === "setPluginMetadata" && o.args.key === KEY,
    );
    expect(stamps).toHaveLength(1);
    expect(JSON.parse(stamps[0].args.value).data).toMatchObject({
      kind: "barcode",
      binding: "b1",
      modules: 2,
    });
  });
});
