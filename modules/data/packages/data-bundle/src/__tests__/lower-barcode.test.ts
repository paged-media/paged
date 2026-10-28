// A barcode lands in its frame's page coordinates: the frame's own bounds go
// through its item transform first. On a verso the bounds alone sit a page
// width into the spread, and the symbol was drawn beside its frame.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import { commitLoweredBarcode } from "../lower";

const KEY = "x-paged:media.paged.data";

function fakeHost(itemTransform: number[] | null) {
  const sent: any[] = [];
  const host = {
    log: { info() {}, warn() {}, debug() {} },
    document: {
      meta: async () => ({ activePage: "p2" }),
      collection: async () => [],
      elementGeometry: async () => [
        {
          id: { kind: "rectangle", id: "u1" },
          pageId: "p2",
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
