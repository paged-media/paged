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

// Sheet ADR 525 — document chart styles on the real engine and the real
// document: a chart's roles and series take the document's swatches (with
// their colour model), styles and colour groups through the object model;
// the workbook default reaches every chart and survives a save; a placed
// chart names the swatches, so editing a swatch recolours it on the page
// without the chart being drawn again.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import type { BundleHost, ObjectValue } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { createWorkbookSession, type WorkbookSession } from "../src";
import { contributeObjectModel, WORKBOOK_ADDRESS } from "../src/object-model";

import {
  ENGINE_BUILT,
  WASM,
  authorWorkbook,
  blankPageIdml,
  exportedIdmlParts,
  openHost,
  settle,
  sheetHost,
} from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("chart styles (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

const P = "plugin:media.paged.sheet";
const val = (v: ObjectValue): unknown => (v.kind === "value" ? v.value : v);

describe.skipIf(!ENGINE_BUILT)(
  "document chart styles [sheet.chart.style-roles]",
  () => {
    setDefaultTimeout(60_000);
    let h: HeadlessHost;
    let host: BundleHost;
    let s: WorkbookSession;
    let om: { dispose(): void };

    async function swatch(
      selfId: string,
      space: "CMYK" | "RGB",
      value: number[],
      model: "Process" | "Spot" = "Process",
    ): Promise<void> {
      const made = await host.document.mutate({
        op: "createSwatch",
        args: { spec: { selfId, name: selfId.slice(6), space, value, model } },
      } as never);
      expect(made.applied).toBe(true);
    }

    beforeEach(async () => {
      h = await openHost();
      await h.load(blankPageIdml());
      host = sheetHost(h);
      s = createWorkbookSession(host);
      om = contributeObjectModel(host, s);
      await s.import(
        await authorWorkbook(4, 3, (r, c) =>
          c === 0 ? `k${r}` : String((r + 1) * (c + 1)),
        ),
        "book.xlsx",
      );
      const made = s.authorChart("B1:C4", "A1:A4", "column", "Sales");
      expect(made.ok).toBe(true);
      await swatch("Color/Brand Red", "CMYK", [0, 100, 80, 5], "Spot");
      await swatch("Color/Paper", "CMYK", [0, 2, 8, 0]);
      await swatch("Color/Ink", "RGB", [20, 30, 40]);
    });
    afterEach(() => {
      om?.dispose();
      s?.dispose();
      h?.dispose();
    });

    it("a chart's roles take document swatches and styles, with their colour model", async () => {
      const r = await h.objects.set(`${P}/chart/0`, "roles", {
        plotArea: { swatch: "Color/Paper" },
        legend: {
          paragraphStyle: "ParagraphStyle/$ID/NormalParagraphStyle",
          swatch: "Color/Ink",
        },
      });
      expect(r.applied).toBe(true);
      const roles = val(await h.objects.get(`${P}/chart/0`, "roles"));
      expect(roles).toEqual({
        plotArea: { swatch: "Color/Paper" },
        legend: {
          paragraphStyle: "ParagraphStyle/$ID/NormalParagraphStyle",
          swatch: "Color/Ink",
        },
      });
      const spec = s.state().engine!.chartSpecs!()[0]!;
      // The real model, read from the document (not "rgb" for a CMYK).
      expect(spec.roles?.plotArea?.swatch?.model).toBe("cmyk");
      expect(spec.roles?.legend?.swatch?.model).toBe("rgb");
      // A swatch the document lacks is refused, the chart unchanged.
      const bad = await h.objects.set(`${P}/chart/0`, "roles", {
        plotArea: { swatch: "Color/Nope" },
      });
      expect(bad.applied).toBe(false);
      expect(
        s.state().engine!.chartSpecs!()[0]!.roles?.plotArea?.swatch?.id,
      ).toBe("Color/Paper");
    });

    it("series take a document colour group; the workbook default reaches every chart and rides the save", async () => {
      const g = await host.document.mutate({
        op: "createColorGroup",
        args: {
          spec: {
            selfId: "ColorGroup/Brand",
            name: "Brand",
            members: ["Color/Brand Red", "Color/Ink"],
          },
        },
      } as never);
      expect(g.applied).toBe(true);
      expect(
        (
          await h.objects.set(WORKBOOK_ADDRESS, "chartStyle", {
            roles: { gridlines: { swatch: "Color/Ink" } },
            seriesColorGroup: "ColorGroup/Brand",
          })
        ).applied,
      ).toBe(true);
      s.authorChart("B1:C4", "A1:A4", "bar", "Second");
      const engine = s.state().engine!;
      for (const index of [0, 1]) {
        const geo = JSON.stringify(engine.getChartGeometry(index, 300, 200));
        expect(geo).toContain('"fillSwatchRef":"Color/Brand Red"');
        expect(geo).toContain('"fillSwatchRef":"Color/Ink"');
      }
      const wb = engine.chartStyle!();
      expect(wb.palette?.swatches.map((x) => x.model)).toEqual(["spot", "rgb"]);
      // Saved and loaded again, the default is still there.
      const bytes = engine.saveXlsx();
      engine.loadXlsx(bytes);
      expect(engine.chartStyle!()).toEqual(wb);
      expect(val(await h.objects.get(WORKBOOK_ADDRESS, "chartStyle"))).toEqual({
        roles: { gridlines: { swatch: "Color/Ink" } },
        seriesColorGroup: "ColorGroup/Brand",
      });
    });

    it("use as default, then reset: the chart follows the workbook", async () => {
      await h.objects.set(`${P}/chart/0`, "roles", {
        chartArea: { swatch: "Color/Paper" },
      });
      const r = await h.objects.batch([
        {
          op: "set",
          address: WORKBOOK_ADDRESS,
          path: "chartStyle",
          value: { roles: { chartArea: { swatch: "Color/Paper" } } },
        },
        { op: "set", address: `${P}/chart/0`, path: "roles", value: {} },
      ]);
      expect(r.applied).toBe(true);
      const engine = s.state().engine!;
      expect(engine.chartSpecs!()[0]!.roles).toEqual({});
      expect(JSON.stringify(engine.getChartGeometry(0, 300, 200))).toContain(
        "Color/Paper",
      );
    });

    it("editing a swatch recolours the placed chart: it names the swatch and is not drawn again", async () => {
      await h.objects.set(`${P}/chart/0`, "roles", {
        plotArea: { swatch: "Color/Ink" },
      });
      expect(await s.lowerChart(0)).toBe(true);
      await settle();
      const spreadsOf = (parts: Map<string, string>) =>
        [...parts.entries()]
          .filter(([k]) => k.startsWith("Spreads/"))
          .map(([, v]) => v)
          .join("");
      const before = spreadsOf(await exportedIdmlParts(h));
      expect(before).toContain('FillColor="Color/Ink"');
      const [shownBefore] = await host.document.swatchDisplay(["Color/Ink"]);
      const edited = await host.document.mutate({
        op: "editSwatch",
        args: {
          swatchId: "Color/Ink",
          spec: {
            selfId: "Color/Ink",
            name: "Ink",
            space: "RGB",
            value: [200, 10, 10],
            model: "Process",
          },
        },
      } as never);
      expect(edited.applied).toBe(true);
      await s.refreshPlacements();
      await settle();
      const after = spreadsOf(await exportedIdmlParts(h));
      // The page still names the swatch — the same elements, untouched —
      // and the swatch now shows its new colour.
      expect(after).toBe(before);
      const [shownAfter] = await host.document.swatchDisplay(["Color/Ink"]);
      expect(shownAfter!.rgbHex).not.toBe(shownBefore!.rgbHex);
    });
  },
);
