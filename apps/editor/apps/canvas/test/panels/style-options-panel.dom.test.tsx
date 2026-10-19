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

// Style Options (paged.style-options): the paragraph, character, object,
// cell and table style DEFINITIONS as schema-driven forms over the style's
// address (`style:<family>/<self id>`). Every field is a set on that
// address (one edit, one undo step); the family buttons and the style
// picker choose the target. The style panels open it through
// "Style Options…" (asserted in their own files).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  StyleOptionsPanel,
  setStyleOptionsTarget,
} from "../../src/panels/style-options-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { optionLabels, rowsByName } from "./support/styles";

// The target is the panel's module state (the style panels set it).
beforeEach(() => setStyleOptionsTarget("paragraph", null));
afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(StyleOptionsPanel, {
    id: "paged.style-options",
    scene: richScene,
  });

const panel = (h: H) => h.root.querySelector("[data-style-options-panel]")!;
const target = (h: H) => panel(h).getAttribute("data-style-target");
const family = async (h: H, name: string) =>
  h.click(
    h.root.querySelector(`[data-cockpit-action="style-family-${name}"]`)!,
  );
const styleSelect = (h: H) =>
  h.root.querySelector<HTMLSelectElement>("[data-style-options-select]")!;

const set = (address: string, path: string, value: unknown) => ({
  op: "set",
  args: { address, path, value },
});

describe("Style Options panel: states", () => {
  test("paragraph family: the first editable style (not the root) with its name and parent", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    expect(panel(h).getAttribute("data-style-family")).toBe("paragraph");
    expect(target(h)).toBe(`style:paragraph/${h.scene.paragraphStyle}`);
    expect(styleSelect(h).value).toBe(h.scene.paragraphStyle);
    expect(optionLabels(styleSelect(h))).toEqual([
      "[No paragraph style]",
      "Heading",
    ]);
    expect(h.field("name").querySelector("input")!.value).toBe("Heading");
    expect(h.root.querySelector("[data-style-based-on]")?.textContent).toBe(
      "[No style]",
    );
  });

  for (const [name, key] of [
    ["character", "characterStyle"],
    ["object", "objectStyle"],
    ["cell", "cellStyle"],
    ["table", "tableStyle"],
  ] as const) {
    test(`the ${name} family button retargets to that family's style`, async () => {
      covers("panel:paged.style-options");
      const h = await mount();
      await family(h, name);
      expect(panel(h).getAttribute("data-style-family")).toBe(name);
      expect(target(h)).toBe(`style:${name}/${h.scene[key]}`);
      expect(h.hasField("name")).toBe(true);
    });
  }

  test("a family the document has no styles of says so and offers no fields", async () => {
    covers("panel:paged.style-options");
    const h = await mountPanel(StyleOptionsPanel, {
      id: "paged.style-options",
      document: "blank",
    });
    await family(h as never, "object");
    expect(
      h.root.querySelector("[data-style-options-empty]")?.textContent,
    ).toBe("This document has no object styles.");
    expect(h.hasField("name")).toBe(false);
  });

  test("no document: loading-free, no target, nothing sent but reads", async () => {
    covers("panel:paged.style-options");
    const h = await mountPanel(StyleOptionsPanel, {
      id: "paged.style-options",
      document: "none",
    });
    expect(target(h as never)).toBe("");
    expect(h.mutations()).toEqual([]);
  });
});

describe("Style Options panel: controls", () => {
  test("a length (Space before 6 pt) is one set on the style, read back", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    const address = target(h)!;
    const from = h.mark();
    await h.typeInto("paragraphSpaceBefore", "6");
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { address: string; path: string; value: { value: number } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toMatchObject({
      address,
      path: "paragraphSpaceBefore",
    });
    expect(sent[0].args.value.value).toBe(6);
    expect(await h.get(address, "paragraphSpaceBefore")).toMatchObject({
      value: 6,
    });
  });

  test("an enum (Alignment: CenterAlign) is one set", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    const address = target(h)!;
    const from = h.mark();
    await h.choose("paragraphJustification", "CenterAlign");
    const sent = h.mutations(from) as unknown as Array<{
      args: { path: string; value: { value: unknown } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("paragraphJustification");
    expect(sent[0].args.value.value).toBe("CenterAlign");
    expect(await h.get(address, "paragraphJustification")).toMatchObject({
      value: "CenterAlign",
    });
  });

  test("a switch (Hyphenate off) is one set of false", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    const address = target(h)!;
    const sw = h
      .field("paragraphHyphenation")
      .querySelector('[role="switch"]')!;
    expect(sw.getAttribute("data-on")).toBe("true");
    const from = h.mark();
    await h.click(sw);
    const sent = h.mutations(from) as unknown as Array<{
      args: { path: string; value: { value: unknown } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("paragraphHyphenation");
    expect(sent[0].args.value.value).toBe(false);
    expect(await h.get(address, "paragraphHyphenation")).toMatchObject({
      value: false,
    });
    expect(
      h
        .field("paragraphHyphenation")
        .querySelector('[role="switch"]')
        ?.getAttribute("data-on"),
    ).toBe("false");
  });

  test("a ref (Next style) is picked from the paragraph styles", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    const from = h.mark();
    await h.choose("paragraphStyleNextStyle", h.scene.paragraphStyle);
    const sent = h.mutations(from) as unknown as Array<{
      args: { path: string; value: { value: unknown } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("paragraphStyleNextStyle");
    expect(sent[0].args.value.value).toBe(h.scene.paragraphStyle);
  });

  test("character family: Size 14 and the fill colour write the character style", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    await family(h, "character");
    const address = target(h)!;
    const from = h.mark();
    await h.typeInto("characterFontSize", "14");
    await h.choose("characterFillColor", h.scene.red);
    const sent = h.mutations(from) as unknown as Array<{
      args: { address: string; path: string; value: { value: unknown } };
    }>;
    expect(
      sent.map((m) => [m.args.address, m.args.path, m.args.value.value]),
    ).toEqual([
      [address, "characterFontSize", 14],
      [address, "characterFillColor", h.scene.red],
    ]);
    expect(await h.get(address, "characterFillColor")).toEqual({
      type: "colorRef",
      value: h.scene.red,
    });
  });

  test("the style picker retargets every field to the picked style", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    await h.choose(styleSelect(h), "ParagraphStyle/$ID/[No paragraph style]");
    expect(target(h)).toBe(
      "style:paragraph/ParagraphStyle/$ID/[No paragraph style]",
    );
    expect(
      h.root
        .querySelector("[data-schema-sections]")
        ?.getAttribute("data-target"),
    ).toBe(target(h));
  });

  test("one undo takes a field edit back", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    const address = target(h)!;
    const before = await h.get(address, "paragraphSpaceAfter");
    await h.typeInto("paragraphSpaceAfter", "9");
    await h.act(() => h.client.undo());
    expect(await h.get(address, "paragraphSpaceAfter")).toEqual(before);
  });
});

describe("Style Options panel: findings", () => {
  // Finding PN-168 (fixed): the Name field's Enter renames the style with
  // core's set(name) (the SDK served the path itself and wrote nothing).
  test("PN-168: renaming a style in its Name field renames it", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    const address = target(h)!;
    const from = h.mark();
    await h.typeInto("name", "Title");
    expect(h.mutations(from)).toEqual([
      set(address, "name", { type: "text", value: "Title" }),
    ] as never);
    expect((await rowsByName(h, "paragraphStyles")).get("Title")).toBe(
      h.scene.paragraphStyle,
    );
    expect(optionLabels(styleSelect(h))).toContain("Title");
  });

  // UX audit F-22 (internal identifiers shown to users): enum fields list
  // the engine's member names ("LeftAlign", "NextColumn").
  test.failing(
    "PN-161 (UX F-22): enum options read as words, not engine member names",
    async () => {
      covers("panel:paged.style-options");
      const h = await mount();
      const labels = optionLabels(
        h.field("paragraphJustification").querySelector("select")!,
      );
      expect(labels).not.toContain("LeftAlign");
    },
  );

  // The family row is a tablist of real tabs (the panel kit's Tab): exactly
  // one says it is selected.
  test("PN-162 (UX F-50): the family tablist's buttons are tabs with a selected one", async () => {
    covers("panel:paged.style-options");
    const h = await mount();
    const tabs = [...h.root.querySelectorAll('[role="tablist"] > *')];
    expect(tabs.every((t) => t.getAttribute("role") === "tab")).toBe(true);
    expect(
      tabs.filter((t) => t.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
  });
});
