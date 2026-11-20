// The bars are filled with Color/Black (paged-data-lower BARCODE_FILL_SWATCH),
// which every IDML document carries; a document read back from a PDF
// (publish ADR 660) may not. Then the lowering's batch makes it first, so the
// bars resolve to black and swatch and bars are one undo step
// (blackSwatchMutations). Proven against the REAL core engine.
//
// Skips without a reachable canvas-wasm; REQUIRE_REAL_CORE=1 fails instead.
import { afterEach, describe, expect, it } from "bun:test";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import {
  BARCODE_BLACK,
  barcodeToMutations,
  blackSwatchMutations,
  type LoweredBarcode,
} from "../../data-host-model/src";
import { ENGINE_ANCHOR, openRealHost, REQUIRE_REAL_CORE } from "./real-core";

const run = ENGINE_ANCHOR !== null || REQUIRE_REAL_CORE;

const ean: LoweredBarcode = {
  kind: "barcode",
  target: "bc-frame",
  symbology: "ean13",
  modules: [
    { xPt: 0, yPt: 0, wPt: 1, hPt: 30 },
    { xPt: 3, yPt: 0, wPt: 2, hPt: 30 },
  ],
  modulesX: 95,
  modulesY: 1,
  bounds: { widthPt: 95, heightPt: 30 },
  text: "",
} as LoweredBarcode;

describe("blackSwatchMutations [data.barcode.symbology]", () => {
  it("adds nothing to a document that has Color/Black", () => {
    expect(
      blackSwatchMutations([
        { selfId: "Color/Black" },
        { selfId: "Color/Paper" },
      ]),
    ).toEqual([]);
  });

  it("makes Color/Black, process CMYK 0/0/0/100, for a document without it", () => {
    const ops = blackSwatchMutations([{ selfId: "Color/R=0 G=2 B=5" }]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "createSwatch",
      args: {
        spec: {
          selfId: BARCODE_BLACK,
          space: "CMYK",
          value: [0, 0, 0, 100],
          model: "Process",
        },
      },
    });
  });
});

describe.skipIf(!run)(
  "a barcode in a document without Color/Black, against real core [data.barcode.symbology]",
  () => {
    let h: HeadlessHost | null = null;
    afterEach(() => {
      h?.dispose();
      h = null;
    });

    it("the swatch and the bars land in one batch, and the bars are black", async () => {
      h = await openRealHost();
      const host = h.host;
      // A document as a PDF read-back leaves it: no swatch named Color/Black.
      const gone = await host.document.mutate({
        op: "deleteSwatch",
        args: { swatchId: BARCODE_BLACK },
      });
      expect(gone.applied, "the fresh document's Black removed").toBe(true);
      const lacking = await host.document.collection<{ selfId: string }>(
        "swatches",
      );
      expect(lacking.some((s) => s.selfId === BARCODE_BLACK)).toBe(false);
      const ops = [
        ...blackSwatchMutations(lacking),
        ...barcodeToMutations(ean, {
          pageId: "usp" as never,
          topPt: 50,
          leftPt: 50,
        }),
      ];
      const out = await host.document.mutate({ op: "batch", args: { ops } });
      expect(out.applied).toBe(true);
      const after = await host.document.collection<{ selfId: string }>(
        "swatches",
      );
      expect(after.some((s) => s.selfId === BARCODE_BLACK)).toBe(true);
      const tree = JSON.stringify(await host.document.tree());
      const ids = [...tree.matchAll(/"kind":"polygon","id":"([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(ids).toHaveLength(2);
      for (const id of ids) {
        const props = await host.document.elementProperties({
          kind: "polygon",
          id,
        } as never);
        const fill = (
          props?.entries as { path: string; value: { value: unknown } }[]
        ).find((e) => e.path === "frameFillColor")?.value.value;
        expect(fill).toBe(BARCODE_BLACK);
      }
    });
  },
);
