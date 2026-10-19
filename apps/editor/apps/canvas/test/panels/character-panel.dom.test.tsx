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

// Character (paged.character): content-scope fields over the text the
// caret or the range is in. Each control is asserted as the exact `set`
// on the story range, the model reading it back and the field showing it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { CharacterPanel } from "../../src/panels/character-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(CharacterPanel, { id: "paged.character", scene: richScene });

/** "Hello" (0..5), the first word of the first paragraph. */
const range = (h: H, start = 0, end = 5) =>
  `storyRange:${h.scene.storyId}@${start}..${end}`;

const set = (address: string, path: string, value: unknown) => ({
  op: "set",
  args: { address, path, value },
});

const FIELDS = [
  "characterFontFamily",
  "characterFontStyle",
  "characterFontSize",
  "characterLeading",
  "characterTracking",
  "characterKerningMethod",
  "characterBaselineShift",
  "characterHorizontalScale",
  "characterVerticalScale",
  "characterSkew",
  "characterCase",
  "characterPosition",
  "characterUnderline",
  "characterStrikethru",
  "characterLigatures",
  "characterNoBreak",
  "characterLanguage",
  "characterFillColor",
  "characterOtfFeatures",
];

const state = (h: H, path: string) =>
  h.field(path).getAttribute("data-binding-state");
const input = (h: H, path: string) =>
  h.field(path).querySelector("input")!.value;

/** Select "Hello" and write one field through `act`, returning the sent
 *  mutations. */
async function write(h: H, act: () => Promise<void>) {
  await h.selectText(h.scene.storyId, 0, 5);
  const from = h.mark();
  await act();
  return h.mutations(from);
}

describe("Character panel: states", () => {
  test("no text selected: every field is there and disabled", async () => {
    covers("panel:paged.character");
    const h = await mount();
    for (const path of FIELDS) {
      expect(state(h, path)).toBe("none");
      for (const c of h
        .field(path)
        .querySelectorAll<HTMLButtonElement>("input, select, button")) {
        expect(c.disabled).toBe(true);
      }
    }
  });

  test("a frame selected, no caret: the text fields stay disabled", async () => {
    covers("panel:paged.character");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    expect(state(h, "characterFontSize")).toBe("none");
  });

  test("a caret: the fields read the text at the caret", async () => {
    covers("panel:paged.character");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    for (const path of FIELDS) expect(state(h, path)).toBe("value");
    expect(input(h, "characterFontSize")).toBe("12 pt");
    expect(input(h, "characterTracking")).toBe("0");
    expect(input(h, "characterHorizontalScale")).toBe("100 %");
    expect(input(h, "characterVerticalScale")).toBe("100 %");
    expect(input(h, "characterSkew")).toBe("0 °");
    expect(
      h.field("characterKerningMethod").querySelector("select")!.value,
    ).toBe("Metrics");
  });

  test("a range whose runs disagree reads mixed for that field only", async () => {
    covers("panel:paged.character");
    const h = await mount();
    await h.mutate(
      set(range(h, 6, 11), "characterFontSize", {
        type: "length",
        value: 24,
      }) as never,
    );
    await h.selectText(h.scene.storyId, 0, 11);
    expect(state(h, "characterFontSize")).toBe("mixed");
    expect(input(h, "characterFontSize")).toBe("—");
    expect(state(h, "characterTracking")).toBe("value");
  });

  test("leaving the text disables the fields again", async () => {
    covers("panel:paged.character");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    await h.leaveText();
    expect(state(h, "characterFontSize")).toBe("none");
  });
});

describe("Character panel: every control writes the selected text", () => {
  for (const [path, typed, value, shown] of [
    ["characterFontSize", "18", { type: "length", value: 18 }, "18 pt"],
    ["characterLeading", "20", { type: "length", value: 20 }, "20 pt"],
    // Numbers ride the wire as `length` values (Value has no number).
    ["characterTracking", "50", { type: "length", value: 50 }, "50"],
    ["characterBaselineShift", "3", { type: "length", value: 3 }, "3 pt"],
    ["characterHorizontalScale", "80", { type: "length", value: 80 }, "80 %"],
    ["characterVerticalScale", "90", { type: "length", value: 90 }, "90 %"],
    ["characterSkew", "10", { type: "length", value: 10 }, "10 °"],
  ] as const) {
    test(`${path}: typing ${typed} sets it on the range`, async () => {
      covers("panel:paged.character");
      const h = await mount();
      const sent = await write(h, () => h.typeInto(path, typed));
      expect(sent).toEqual([set(range(h), path, value)] as never);
      expect(await h.get(range(h), path)).toEqual(value);
      expect(input(h, path)).toBe(shown);
    });
  }

  for (const [path, option] of [
    ["characterKerningMethod", "Optical"],
    ["characterFontStyle", "Bold"],
    ["characterLanguage", "$ID/German"],
  ] as const) {
    test(`${path}: choosing ${option} sets it on the range`, async () => {
      covers("panel:paged.character");
      const h = await mount();
      const sent = (await write(h, () =>
        h.choose(path, option),
      )) as unknown as Array<{
        op: string;
        args: { address: string; path: string; value: { value: unknown } };
      }>;
      expect(sent).toHaveLength(1);
      expect(sent[0].args.address).toBe(range(h));
      expect(sent[0].args.path).toBe(path);
      expect(sent[0].args.value.value).toBe(option);
      expect(((await h.get(range(h), path)) as { value: unknown }).value).toBe(
        option,
      );
      expect(h.field(path).querySelector("select")!.value).toBe(option);
    });
  }

  for (const [path, option] of [
    ["characterCase", "AllCaps"],
    ["characterCase", "SmallCaps"],
    ["characterPosition", "Superscript"],
    ["characterPosition", "Subscript"],
  ] as const) {
    test(`${path}: the ${option} segment sets it and becomes the active one`, async () => {
      covers("panel:paged.character");
      const h = await mount();
      const sent = await write(h, () => h.press(path, option));
      expect(sent).toEqual([
        set(range(h), path, { type: "text", value: option }),
      ] as never);
      expect(await h.get(range(h), path)).toEqual({
        type: "text",
        value: option,
      });
      expect(
        h
          .field(path)
          .querySelector('[data-active="true"]')
          ?.getAttribute("data-option-value"),
      ).toBe(option);
    });
  }

  for (const path of [
    "characterUnderline",
    "characterStrikethru",
    "characterLigatures",
    "characterNoBreak",
  ] as const) {
    test(`${path}: the switch flips it on the range`, async () => {
      covers("panel:paged.character");
      const h = await mount();
      await h.selectText(h.scene.storyId, 0, 5);
      const before = (await h.get(range(h), path)) as { value: boolean };
      const sw = h.field(path).querySelector<HTMLElement>('[role="switch"]')!;
      const from = h.mark();
      await h.click(sw);
      expect(h.mutations(from)).toEqual([
        set(range(h), path, { type: "bool", value: !before.value }),
      ] as never);
      expect(await h.get(range(h), path)).toEqual({
        type: "bool",
        value: !before.value,
      });
      expect(sw.getAttribute("aria-checked")).toBe(String(!before.value));
    });
  }

  test("Family: the list is the document's fonts, and choosing one sets it", async () => {
    covers("panel:paged.character");
    const h = await mount();
    // A family enters the fonts collection when some text uses it.
    await h.mutate(
      set(range(h, 6, 11), "characterFontFamily", {
        type: "text",
        value: "Courier",
      }) as never,
    );
    await h.selectText(h.scene.storyId, 0, 5);
    const select = h.root.querySelector<HTMLSelectElement>(
      "[data-character-family] select",
    )!;
    expect([...select.options].map((o) => o.value)).toContain("Courier");
    const from = h.mark();
    await h.choose(select, "Courier");
    expect(h.mutations(from)).toEqual([
      set(range(h), "characterFontFamily", { type: "text", value: "Courier" }),
    ] as never);
    expect(await h.get(range(h), "characterFontFamily")).toEqual({
      type: "text",
      value: "Courier",
    });
    expect(select.value).toBe("Courier");
  });

  test("OpenType chips toggle their tag in the feature string, in chip order", async () => {
    covers("panel:paged.character");
    const h = await mount();
    await h.selectText(h.scene.storyId, 0, 5);
    const chip = (label: string) =>
      h.root.querySelector<HTMLButtonElement>(
        `[data-opentype-chip="${label}"]`,
      )!;
    let from = h.mark();
    await h.click(chip("Frac"));
    expect(h.mutations(from)).toEqual([
      set(range(h), "characterOtfFeatures", { type: "text", value: "frac" }),
    ] as never);
    expect(chip("Frac").getAttribute("aria-pressed")).toBe("true");
    from = h.mark();
    await h.click(chip("Liga"));
    expect(h.mutations(from)).toEqual([
      set(range(h), "characterOtfFeatures", {
        type: "text",
        value: "liga frac",
      }),
    ] as never);
    from = h.mark();
    await h.click(chip("Frac"));
    expect(h.mutations(from)).toEqual([
      set(range(h), "characterOtfFeatures", { type: "text", value: "liga" }),
    ] as never);
    expect(await h.get(range(h), "characterOtfFeatures")).toEqual({
      type: "text",
      value: "liga",
    });
  });

  test("one edit is one undo step: undo restores the range", async () => {
    covers("panel:paged.character");
    const h = await mount();
    await h.selectText(h.scene.storyId, 0, 5);
    const before = await h.get(range(h), "characterFontSize");
    await h.typeInto("characterFontSize", "30");
    await h.act(() => h.client.undo());
    expect(await h.get(range(h), "characterFontSize")).toEqual(before);
    expect(input(h, "characterFontSize")).toBe("12 pt");
  });
});

describe("Character panel: findings", () => {
  // UX audit F-37: with a caret in new text, the family select is empty.
  // The engine answers "" for the family, style and language of text that
  // only the default style formats; the panel shows a blank or a dash.
  test.failing(
    "PN-20 (UX F-37): a caret in new text shows the family that applies, not a dash",
    async () => {
      covers("panel:paged.character");
      const h = await mount();
      await h.caret(h.scene.storyId, 2);
      const family = h.root.querySelector<HTMLSelectElement>(
        "[data-character-family] select",
      )!;
      expect(family.value).not.toBe("__mixed__");
      expect(family.value).not.toBe("");
    },
  );

  // The engine reads auto leading as an unset length (null); the field
  // shows "0 pt", which is a leading that would set every line on top of
  // the last. InDesign shows Auto (and the computed value).
  test.failing("PN-21: auto leading reads as Auto, not 0 pt", async () => {
    covers("panel:paged.character");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    expect(await h.get(range(h, 2, 2), "characterLeading")).toEqual({
      type: "length",
      value: null,
    });
    expect(input(h, "characterLeading")).not.toBe("0 pt");
  });
});
