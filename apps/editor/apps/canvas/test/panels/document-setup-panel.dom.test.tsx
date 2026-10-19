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

// Document Setup (paged.document-setup) and Margins and Columns
// (paged.margins-columns): schema-driven forms over the `doc` address and
// one page address (or every page at once). Each control: the exact `set`
// it sends, the model reading it back, the field showing it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  DocumentSetupPanel,
  MarginsColumnsPanel,
} from "../../src/panels/document-setup-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { conditionsIdml } from "./support/options";

afterEach(unmountAll);

const set = (address: string, path: string, value: unknown) => ({
  op: "set",
  args: { address, path, value },
});

/** The value a field shows: a switch's state, its input's text or its
 *  select's value. */
function shown(h: PanelHarness<unknown>, path: string): string | null {
  const f = h.field(path);
  const sw = f.querySelector('[role="switch"]');
  if (sw) return sw.getAttribute("aria-checked");
  const input = f.querySelector("input");
  if (input) return input.value;
  const select = f.querySelector("select");
  return select ? select.value : null;
}

const DOC_FIELDS = [
  "documentBleedTop",
  "documentBleedBottom",
  "documentBleedInsideOrLeft",
  "documentBleedOutsideOrRight",
  "documentSlugTop",
  "documentSlugBottom",
  "documentSlugInsideOrLeft",
  "documentSlugRightOrOutside",
  "defaultFillColor",
  "defaultStrokeColor",
  "defaultStrokeWeight",
  "cmykProfile",
  "rgbPolicy",
  "renderingIntent",
  "blackPointCompensation",
  "useStandardLabForSpots",
  "proofProfile",
  "proofIntent",
  "proofSimulatePaperWhite",
  "activeConditionSet",
];

describe("Document Setup: states", () => {
  const mount = (document?: "none" | "blank") =>
    mountPanel(DocumentSetupPanel, { id: "paged.document-setup", document });

  test("a blank document: every section and field, zero bleed and slug", async () => {
    covers("panel:paged.document-setup");
    const h = await mount("blank");
    for (const path of DOC_FIELDS) expect(h.hasField(path)).toBe(true);
    expect(
      [...h.root.querySelectorAll("[data-options-section]")].map((s) =>
        s.getAttribute("data-options-section"),
      ),
    ).toEqual([
      "Bleed",
      "Slug",
      "Defaults",
      "Color Management",
      "Proof Setup",
      "Conditions",
    ]);
    for (const path of DOC_FIELDS.slice(0, 8)) {
      expect(shown(h, path)).toBe("0 pt");
    }
    expect(shown(h, "renderingIntent")).toBe("RelativeColorimetric");
    expect(shown(h, "blackPointCompensation")).toBe("true");
    // Rows the doc schema adds that no section lays out: under More.
    expect(h.view.getByRole("button", { name: "More" })).toBeTruthy();
  });

  test("no document: the fields read nothing and write nothing", async () => {
    covers("panel:paged.document-setup");
    const h = await mount("none");
    const from = h.mark();
    for (const path of ["documentBleedTop", "defaultStrokeWeight"]) {
      expect(h.field(path).getAttribute("data-binding-state")).not.toBe(
        "value",
      );
      const input = h.field(path).querySelector("input")!;
      await h.user.type(input, "5{Enter}");
    }
    await h.settle();
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Document Setup: every control writes the document", () => {
  const mount = () =>
    mountPanel(DocumentSetupPanel, {
      id: "paged.document-setup",
      scene: richScene,
    });

  for (const path of [
    "documentBleedTop",
    "documentBleedOutsideOrRight",
    "documentSlugTop",
    "documentSlugBottom",
    "defaultStrokeWeight",
  ]) {
    test(`${path}: typing 9 sets it on the document`, async () => {
      covers("panel:paged.document-setup");
      const h = await mount();
      const from = h.mark();
      await h.typeInto(path, "9");
      expect(h.mutations(from)).toEqual([
        set("doc", path, { type: "length", value: 9 }),
      ] as never);
      expect(await h.get("doc", path)).toEqual({ type: "length", value: 9 });
      expect(shown(h, path)).toBe("9 pt");
    });
  }

  test("Defaults: picking Red as the default fill", async () => {
    covers("panel:paged.document-setup");
    const h = await mount();
    const from = h.mark();
    await h.choose("defaultFillColor", h.scene.red);
    // The doc's default colours are text paths (the swatch id), read and
    // written as text.
    expect(h.mutations(from)).toEqual([
      set("doc", "defaultFillColor", { type: "text", value: h.scene.red }),
    ] as never);
    expect(await h.get("doc", "defaultFillColor")).toEqual({
      type: "text",
      value: h.scene.red,
    });
    expect(shown(h, "defaultFillColor")).toBe(h.scene.red);
  });

  test("Color Management: the rendering intent", async () => {
    covers("panel:paged.document-setup");
    const h = await mount();
    const from = h.mark();
    await h.choose("renderingIntent", "Perceptual");
    expect(h.mutations(from)).toEqual([
      set("doc", "renderingIntent", { type: "text", value: "Perceptual" }),
    ] as never);
    expect(await h.get("doc", "renderingIntent")).toEqual({
      type: "text",
      value: "Perceptual",
    });
    expect(shown(h, "renderingIntent")).toBe("Perceptual");
  });

  for (const [path, before] of [
    ["blackPointCompensation", true],
    ["useStandardLabForSpots", false],
  ] as const) {
    test(`${path}: the switch turns it ${before ? "off" : "on"}`, async () => {
      covers("panel:paged.document-setup");
      const h = await mount();
      const from = h.mark();
      await h.click(h.field(path).querySelector('[role="switch"]')!);
      expect(h.mutations(from)).toEqual([
        set("doc", path, { type: "bool", value: !before }),
      ] as never);
      expect(await h.get("doc", path)).toEqual({
        type: "bool",
        value: !before,
      });
      expect(shown(h, path)).toBe(String(!before));
    });
  }

  test("Conditions: the active condition set, picked from the document's sets", async () => {
    covers("panel:paged.document-setup");
    const h = await mountPanel(DocumentSetupPanel, {
      id: "paged.document-setup",
      document: conditionsIdml(),
    });
    const options = [
      ...h.field("activeConditionSet").querySelectorAll("option"),
    ].map((o) => o.value);
    expect(options).toContain("ConditionSet/Review");
    const from = h.mark();
    await h.choose("activeConditionSet", "ConditionSet/Review");
    expect(h.mutations(from)).toEqual([
      set("doc", "activeConditionSet", {
        type: "text",
        value: "ConditionSet/Review",
      }),
    ] as never);
    expect(await h.get("doc", "activeConditionSet")).toEqual({
      type: "text",
      value: "ConditionSet/Review",
    });
  });

  test("one edit is one undo step", async () => {
    covers("panel:paged.document-setup");
    const h = await mount();
    await h.typeInto("documentBleedTop", "9");
    await h.act(() => h.client.undo());
    expect(await h.get("doc", "documentBleedTop")).toEqual({
      type: "length",
      value: 0,
    });
    expect(shown(h, "documentBleedTop")).toBe("0 pt");
  });
});

describe("Margins and Columns", () => {
  const mount = () =>
    mountPanel(MarginsColumnsPanel, {
      id: "paged.margins-columns",
      scene: richScene,
    });
  const page = (id: string) => `page:${id}`;
  const picker = (h: PanelHarness<unknown>) =>
    h.root.querySelector<HTMLSelectElement>("[data-page-select]")!;

  test("no document: no page to edit, so no fields", async () => {
    covers("panel:paged.margins-columns");
    const h = await mountPanel(MarginsColumnsPanel, {
      id: "paged.margins-columns",
      document: "none",
    });
    expect(
      h.root
        .querySelector("[data-margins-columns-panel]")!
        .getAttribute("data-page-targets"),
    ).toBe("0");
    expect(h.hasField("pageMarginTop")).toBe(false);
  });

  test("one page: the picker offers it alone, no All pages", async () => {
    covers("panel:paged.margins-columns");
    const h = await mountPanel(MarginsColumnsPanel, {
      id: "paged.margins-columns",
      document: "blank",
    });
    expect([...picker(h).options].map((o) => o.textContent)).toEqual([
      "Page 1",
    ]);
    expect(h.hasField("pageMarginTop")).toBe(true);
  });

  test("two pages: Page 1, Page 2 and All pages; the first page is the target", async () => {
    covers("panel:paged.margins-columns");
    const h = await mount();
    expect([...picker(h).options].map((o) => o.textContent)).toEqual([
      "Page 1",
      "Page 2",
      "All pages",
    ]);
    expect(picker(h).value).toBe(h.scene.pageId);
    expect(shown(h, "pageBounds")).toBe("0 pt");
    expect(shown(h, "appliedMaster")).toBe("um");
  });

  for (const [path, text, value] of [
    ["pageMarginTop", "18", 18],
    ["pageMarginBottom", "20", 20],
    ["pageMarginLeft", "24", 24],
    ["pageMarginRight", "30", 30],
    ["pageColumnGutter", "6", 6],
  ] as const) {
    test(`${path}: typing ${text} sets it on the page`, async () => {
      covers("panel:paged.margins-columns");
      const h = await mount();
      const from = h.mark();
      await h.typeInto(path, text);
      expect(h.mutations(from)).toEqual([
        set(page(h.scene.pageId), path, { type: "length", value }),
      ] as never);
      expect(await h.get(page(h.scene.pageId), path)).toEqual({
        type: "length",
        value,
      });
      expect(shown(h, path)).toBe(`${value} pt`);
    });
  }

  test("pageColumnCount: typing 3 gives the page three columns", async () => {
    covers("panel:paged.margins-columns");
    const h = await mount();
    const from = h.mark();
    await h.typeInto("pageColumnCount", "3");
    const sent = h.mutations(from) as unknown as Array<{
      args: { address: string; path: string; value: { value: number } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.address).toBe(page(h.scene.pageId));
    expect(sent[0].args.path).toBe("pageColumnCount");
    expect(sent[0].args.value.value).toBe(3);
    expect(shown(h, "pageColumnCount")).toBe("3");
  });

  test("Page 2 picked: the fields write the second page only", async () => {
    covers("panel:paged.margins-columns");
    const h = await mount();
    await h.choose(picker(h), h.scene.page2Id);
    const from = h.mark();
    await h.typeInto("pageMarginTop", "50");
    expect(h.mutations(from)).toEqual([
      set(page(h.scene.page2Id), "pageMarginTop", {
        type: "length",
        value: 50,
      }),
    ] as never);
    expect(await h.get(page(h.scene.page2Id), "pageMarginTop")).toEqual({
      type: "length",
      value: 50,
    });
  });

  test("All pages: one edit is one batch over every page, one undo restores both", async () => {
    covers("panel:paged.margins-columns");
    const h = await mount();
    const before = await h.get(page(h.scene.pageId), "pageMarginTop");
    await h.choose(picker(h), "__all__");
    expect(
      h.root
        .querySelector("[data-margins-columns-panel]")!
        .getAttribute("data-page-targets"),
    ).toBe("2");
    const from = h.mark();
    await h.typeInto("pageMarginTop", "40");
    expect(h.mutations(from)).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            set(page(h.scene.pageId), "pageMarginTop", {
              type: "length",
              value: 40,
            }),
            set(page(h.scene.page2Id), "pageMarginTop", {
              type: "length",
              value: 40,
            }),
          ],
        },
      },
    ] as never);
    await h.act(() => h.client.undo());
    for (const id of [h.scene.pageId, h.scene.page2Id]) {
      expect(await h.get(page(id), "pageMarginTop")).toEqual(before);
    }
  });

  test("Master: applying a second master to the page", async () => {
    covers("panel:paged.margins-columns");
    const h = await mount();
    await h.mutate({
      op: "createMaster",
      args: { master: "ub2", name: "B-Master", widthPt: 612, heightPt: 792 },
    } as never);
    const masters = (await h.client.collection("masterPages")) as Array<{
      selfId: string;
    }>;
    const second = masters.find((m) => m.selfId !== "um")!.selfId;
    const from = h.mark();
    await h.choose("appliedMaster", second);
    expect(h.mutations(from)).toEqual([
      set(page(h.scene.pageId), "appliedMaster", {
        type: "text",
        value: second,
      }),
    ] as never);
    expect(await h.get(page(h.scene.pageId), "appliedMaster")).toEqual({
      type: "text",
      value: second,
    });
  });

  // An unset margin: the page address reads null and the panel shows its
  // schema default (36 pt), while the document's pages collection, which
  // the page list and the document map read, says 0 pt for the same page.
  test.failing(
    "PN-203: the panel's margin and the pages collection agree for the same page",
    async () => {
      covers("panel:paged.margins-columns");
      const h = await mount();
      const pages = (await h.client.collection("pages")) as Array<{
        selfId: string;
        marginTopPt: number;
      }>;
      const first = pages.find((p) => p.selfId === h.scene.pageId)!;
      expect(shown(h, "pageMarginTop")).toBe(`${first.marginTopPt} pt`);
    },
  );

  // UX audit F-39: one unit (points) everywhere, and a typed unit is not
  // converted: "10mm" is read as 10 and written as 10 pt.
  test.failing(
    "PN-204 (UX F-39): a margin typed as 10mm is set as 28.35 pt",
    async () => {
      covers("panel:paged.margins-columns");
      const h = await mount();
      const from = h.mark();
      await h.typeInto("pageMarginTop", "10mm");
      const sent = h.mutations(from) as unknown as Array<{
        args: { value: { value: number } };
      }>;
      expect(sent).toHaveLength(1);
      expect(sent[0].args.value.value).toBeCloseTo(28.35, 1);
    },
  );
});
