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

// Sheet ADR 524 — the Workbook panel's Chart style section (happy-dom):
// role rows list the document's swatches (with their display colour),
// paragraph and character styles and colour groups; a pick writes ids
// through the object model; the workbook default shows where a chart does
// not override; "Use as default" and "Reset to default" are one batch.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type { BundleHost, ObjectOp } from "@paged-media/plugin-api";

import type { ChartSpec, ChartStyle, SheetEngine } from "../src/engine";
import { ChartStyleSection } from "../src/panels/chart-style-section";
import type { WorkbookSession } from "../src/session";

const P = "plugin:media.paged.sheet";

const sw = (id: string, rgb: string) => ({
  id,
  model: "cmyk" as const,
  fallbackRgb: rgb,
});

function harness(opts: { chartRoles?: ChartSpec["roles"] } = {}) {
  const writes: { kind: "set" | "batch"; ops: ObjectOp[] }[] = [];
  const style: ChartStyle = {
    roles: { plotArea: { swatch: sw("Color/Paper", "#F0EEE6") } },
    palette: null,
  };
  const spec: ChartSpec = {
    index: 0,
    hostSheet: 0,
    kind: "column",
    title: "Sales",
    legend: true,
    series: [],
    roles: opts.chartRoles ?? {},
    seriesPalette: null,
  };
  const engine = {
    chartSpecs: () => [spec],
    chartStyle: () => style,
  } as unknown as SheetEngine;
  const session = {
    state: () => ({ engine }),
    documentStyleRevision: () => 0,
    documentStyleChoices: async () => ({
      paragraphStyles: [{ id: "ParagraphStyle/Caption", name: "Caption" }],
      swatches: [
        { id: "Color/Paper", name: "Paper", rgbHex: "#f0eee6" },
        { id: "Color/Brand", name: "Brand", rgbHex: "#c00020" },
      ],
    }),
    documentSwatchRef: async (id: string) => sw(id, "#000000"),
  } as unknown as WorkbookSession;
  const host = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    document: {
      collection: async (name: string) =>
        name === "characterStyles"
          ? [{ selfId: "CharacterStyle/Em", name: "Em" }]
          : name === "colorGroups"
            ? [
                {
                  selfId: "ColorGroup/Brand",
                  name: "Brand",
                  members: ["Color/Brand"],
                },
              ]
            : [],
    },
    objects: {
      set: async (address: string, path: string, value: unknown) => {
        writes.push({
          kind: "set",
          ops: [{ op: "set", address, path, value } as ObjectOp],
        });
        return { applied: true, undoSteps: 1 };
      },
      batch: async (ops: ObjectOp[]) => {
        writes.push({ kind: "batch", ops: [...ops] });
        return { applied: true, undoSteps: 1 };
      },
    },
  } as unknown as BundleHost;
  const styles = { body: {}, input: {}, button: {}, row: {}, note: {} };
  const { container } = render(
    createElement(ChartStyleSection, { host, session, styles, view: 1 }),
  );
  return { container, writes };
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const q = (c: HTMLElement, sel: string) => {
  const el = c.querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el as HTMLElement;
};

afterEach(() => cleanup());

describe("chart style section [sheet.chart.style-roles]", () => {
  it("lists every role and the document's choices", async () => {
    const { container } = harness();
    await flush();
    const roles = [
      ...container.querySelectorAll("[data-chart-style-role]"),
    ].map((e) => e.getAttribute("data-chart-style-role"));
    expect(roles).toEqual([
      "chartArea",
      "plotArea",
      "axisLine",
      "gridlines",
      "text",
      "title",
      "axisTitle",
      "tickLabels",
      "legend",
      "dataLabels",
    ]);
    // Colour roles have no style selects; text roles have both.
    expect(
      container.querySelector(
        '[data-chart-style-select="plotArea.paragraphStyle"]',
      ),
    ).toBeNull();
    const para = q(
      container,
      '[data-chart-style-select="legend.paragraphStyle"]',
    );
    expect(
      [...para.querySelectorAll("option")].map((o) => o.textContent),
    ).toContain("Caption");
    const chr = q(
      container,
      '[data-chart-style-select="legend.characterStyle"]',
    );
    expect(
      [...chr.querySelectorAll("option")].map((o) => o.textContent),
    ).toContain("Em");
    const group = q(container, "[data-chart-style-group]");
    expect(
      [...group.querySelectorAll("option")].map((o) => o.textContent),
    ).toContain("Brand");
    // The swatch picker shows each swatch with its display colour.
    fireEvent.click(q(container, '[data-chart-style-swatch="chartArea"]'));
    const opts = [
      ...container.querySelectorAll(
        '[data-chart-style-swatches="chartArea"] [data-swatch]',
      ),
    ] as HTMLElement[];
    expect(opts.map((o) => o.getAttribute("data-swatch"))).toEqual([
      "",
      "Color/Paper",
      "Color/Brand",
    ]);
    expect(opts[2]!.getAttribute("title")).toBe("#c00020");
  });

  it("the workbook default: a swatch pick writes the workbook chartStyle", async () => {
    const { container, writes } = harness();
    await flush();
    fireEvent.click(q(container, '[data-chart-style-swatch="gridlines"]'));
    fireEvent.click(
      q(
        container,
        '[data-chart-style-swatches="gridlines"] [data-swatch="Color/Brand"]',
      ),
    );
    await flush();
    expect(writes).toEqual([
      {
        kind: "set",
        ops: [
          {
            op: "set",
            address: `${P}/workbook/main`,
            path: "chartStyle",
            value: {
              roles: {
                plotArea: { swatch: "Color/Paper" },
                gridlines: { swatch: "Color/Brand" },
              },
              seriesColorGroup: null,
            },
          },
        ],
      },
    ]);
    expect(q(container, "[data-chart-style-msg]").textContent).toBe(
      "Chart style updated.",
    );
  });

  it("a chart: overrides write its roles, the default shows where it has none", async () => {
    const { container, writes } = harness({
      chartRoles: { title: { paragraphStyle: "ParagraphStyle/Caption" } },
    });
    await flush();
    fireEvent.change(q(container, "[data-chart-style-target]"), {
      target: { value: "0" },
    });
    await flush();
    // The plot area follows the workbook default (Paper).
    expect(
      q(container, '[data-chart-style-swatch="plotArea"]').textContent,
    ).toContain("Default: Paper");
    fireEvent.change(
      q(container, '[data-chart-style-select="legend.characterStyle"]'),
      { target: { value: "CharacterStyle/Em" } },
    );
    fireEvent.change(q(container, "[data-chart-style-group]"), {
      target: { value: "ColorGroup/Brand" },
    });
    await flush();
    expect(writes.map((w) => w.ops[0])).toEqual([
      {
        op: "set",
        address: `${P}/chart/0`,
        path: "roles",
        value: {
          title: { paragraphStyle: "ParagraphStyle/Caption" },
          legend: { characterStyle: "CharacterStyle/Em" },
        },
      },
      {
        op: "set",
        address: `${P}/chart/0`,
        path: "seriesColorGroup",
        value: "ColorGroup/Brand",
      },
    ]);
  });

  it("use as default and reset are one batch each", async () => {
    const { container, writes } = harness({
      chartRoles: { chartArea: { swatch: sw("Color/Brand", "#C00020") } },
    });
    await flush();
    fireEvent.change(q(container, "[data-chart-style-target]"), {
      target: { value: "0" },
    });
    await flush();
    fireEvent.click(q(container, "[data-chart-style-use-default]"));
    fireEvent.click(q(container, "[data-chart-style-reset]"));
    await flush();
    expect(writes.map((w) => w.kind)).toEqual(["batch", "batch"]);
    expect(writes[0]!.ops).toEqual([
      {
        op: "set",
        address: `${P}/workbook/main`,
        path: "chartStyle",
        value: {
          roles: { chartArea: { swatch: "Color/Brand" } },
          seriesColorGroup: null,
        },
      },
      { op: "set", address: `${P}/chart/0`, path: "roles", value: {} },
      {
        op: "set",
        address: `${P}/chart/0`,
        path: "seriesColorGroup",
        value: null,
      },
    ]);
    expect(writes[1]!.ops.map((o) => (o as { path: string }).path)).toEqual([
      "roles",
      "seriesColorGroup",
    ]);
  });
});
