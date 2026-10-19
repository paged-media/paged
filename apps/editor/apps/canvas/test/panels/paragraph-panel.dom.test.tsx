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

// Paragraph (paged.paragraph): content-scope fields over the paragraph(s)
// the caret or range is in (the engine rounds a write to whole
// paragraphs), plus the bespoke rule above / below rows. Each control is
// asserted as the exact `set`, the model reading it back at the caret and
// the field showing it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ParagraphPanel } from "../../src/panels/paragraph-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(ParagraphPanel, { id: "paged.paragraph", scene: richScene });

/** The caret's own address (offset 2, inside "Hello"). */
const at = (h: H, offset = 2) =>
  `storyRange:${h.scene.storyId}@${offset}..${offset}`;

type Sent = Array<{
  op: string;
  args: {
    address: string;
    path: string;
    value: { type: string; value: unknown };
  };
}>;

const FIELDS = [
  "paragraphJustification",
  "paragraphLeftIndent",
  "paragraphRightIndent",
  "paragraphFirstLineIndent",
  "paragraphLastLineIndent",
  "paragraphSpaceBefore",
  "paragraphSpaceAfter",
  "paragraphDropCapCharacters",
  "paragraphDropCapLines",
  "paragraphHyphenation",
  "paragraphBalanceRaggedLines",
  "paragraphAutoLeading",
  "paragraphSingleWordJustification",
];

const state = (h: H, path: string) =>
  h.field(path).getAttribute("data-binding-state");
const input = (h: H, path: string) =>
  h.field(path).querySelector("input")!.value;

/** Put the caret in the first paragraph and write through `act`. */
async function write(h: H, act: () => Promise<void>): Promise<Sent> {
  await h.caret(h.scene.storyId, 2);
  const from = h.mark();
  await act();
  return h.mutations(from) as unknown as Sent;
}

/** One `set` of `path` on the caret's story. */
function expectOneSet(h: H, sent: Sent, path: string, value: unknown) {
  expect(sent).toHaveLength(1);
  expect(sent[0].op).toBe("set");
  expect(sent[0].args.path).toBe(path);
  expect(
    sent[0].args.address.startsWith(`storyRange:${h.scene.storyId}@`),
  ).toBe(true);
  expect(sent[0].args.value.value).toEqual(value);
}

describe("Paragraph panel: states", () => {
  test("no text: every field disabled, the seams too", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    for (const path of FIELDS) expect(state(h, path)).toBe("none");
    expect(
      h.view.getByRole("switch", { name: "Align to baseline grid" }),
    ).toHaveProperty("disabled", true);
    for (const id of ["rule-above", "rule-below"]) {
      const pill = h.root.querySelector<HTMLButtonElement>(
        `[data-toggle-switch="${id}"]`,
      );
      expect(pill?.disabled).toBe(true);
    }
  });

  test("a caret: the paragraph's values", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    for (const path of FIELDS) expect(state(h, path)).toBe("value");
    expect(input(h, "paragraphSpaceBefore")).toBe("0 pt");
    expect(input(h, "paragraphAutoLeading")).toBe("120 %");
    expect(
      h.field("paragraphBalanceRaggedLines").querySelector("select")!.value,
    ).toBe("NoBalancing");
  });

  test("a range over two paragraphs that disagree reads mixed", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    // "Second paragraph" starts at 12.
    await h.mutate({
      op: "set",
      args: {
        address: at(h, 14),
        path: "paragraphSpaceBefore",
        value: { type: "length", value: 12 },
      },
    } as never);
    await h.selectText(h.scene.storyId, 0, 20);
    expect(state(h, "paragraphSpaceBefore")).toBe("mixed");
    expect(state(h, "paragraphSpaceAfter")).toBe("value");
  });

  test("Align to baseline grid stays an honest seam with text selected", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    const seam = h.view.getByRole("switch", { name: "Align to baseline grid" });
    expect(seam).toHaveProperty("disabled", true);
    const from = h.mark();
    await h.click(seam);
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Paragraph panel: every control writes the paragraph", () => {
  test("Align: each segment writes its justification and becomes the active one", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    const options = [
      ...h
        .field("paragraphJustification")
        .querySelectorAll("[data-option-value]"),
    ].map((b) => b.getAttribute("data-option-value")!);
    expect(options).toEqual([
      "LeftAlign",
      "CenterAlign",
      "RightAlign",
      "LeftJustified",
    ]);
    for (const option of options.slice(1)) {
      const from = h.mark();
      await h.press("paragraphJustification", option);
      expectOneSet(
        h,
        h.mutations(from) as unknown as Sent,
        "paragraphJustification",
        option,
      );
      expect(
        ((await h.get(at(h), "paragraphJustification")) as { value: unknown })
          .value,
      ).toBe(option);
      expect(
        h
          .field("paragraphJustification")
          .querySelector('[data-active="true"]')
          ?.getAttribute("data-option-value"),
      ).toBe(option);
    }
  });

  for (const [path, typed, value] of [
    ["paragraphLeftIndent", "10", 10],
    ["paragraphRightIndent", "8", 8],
    ["paragraphFirstLineIndent", "12", 12],
    ["paragraphLastLineIndent", "4", 4],
    ["paragraphSpaceBefore", "6", 6],
    ["paragraphSpaceAfter", "9", 9],
    ["paragraphDropCapCharacters", "1", 1],
    ["paragraphDropCapLines", "3", 3],
    ["paragraphAutoLeading", "140", 140],
  ] as const) {
    test(`${path}: typing ${typed} sets it on the paragraph`, async () => {
      covers("panel:paged.paragraph");
      const h = await mount();
      const sent = await write(h, () => h.typeInto(path, typed));
      expectOneSet(h, sent, path, value);
      expect(((await h.get(at(h), path)) as { value: unknown }).value).toBe(
        value,
      );
      expect(input(h, path)).toContain(typed);
    });
  }

  for (const [path, option] of [
    ["paragraphBalanceRaggedLines", "FullyBalanced"],
    ["paragraphSingleWordJustification", "LeftAlign"],
  ] as const) {
    test(`${path}: choosing ${option} sets it`, async () => {
      covers("panel:paged.paragraph");
      const h = await mount();
      const sent = await write(h, () => h.choose(path, option));
      expectOneSet(h, sent, path, option);
      expect(((await h.get(at(h), path)) as { value: unknown }).value).toBe(
        option,
      );
      expect(h.field(path).querySelector("select")!.value).toBe(option);
    });
  }

  test("Hyphenate: the switch flips it", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    const before = (
      (await h.get(at(h), "paragraphHyphenation")) as { value: boolean }
    ).value;
    const sw = h
      .field("paragraphHyphenation")
      .querySelector<HTMLElement>('[role="switch"]')!;
    const from = h.mark();
    await h.click(sw);
    expectOneSet(
      h,
      h.mutations(from) as unknown as Sent,
      "paragraphHyphenation",
      !before,
    );
    expect(
      ((await h.get(at(h), "paragraphHyphenation")) as { value: boolean })
        .value,
    ).toBe(!before);
  });

  test("Keep options opens its fields, and Keep with next writes", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    expect(h.hasField("paragraphKeepWithNext")).toBe(false);
    await h.click(h.view.getByRole("button", { name: "Keep options" }));
    expect(h.hasField("paragraphKeepWithNext")).toBe(true);
    const from = h.mark();
    await h.typeInto("paragraphKeepWithNext", "2");
    expectOneSet(
      h,
      h.mutations(from) as unknown as Sent,
      "paragraphKeepWithNext",
      2,
    );
    expect(
      ((await h.get(at(h), "paragraphKeepWithNext")) as { value: unknown })
        .value,
    ).toBe(2);
  });

  test("Span columns opens its fields, and the layout select writes", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    await h.click(h.view.getByRole("button", { name: "Span columns" }));
    const from = h.mark();
    await h.choose("paragraphSpanColumnType", "SpanColumns");
    expectOneSet(
      h,
      h.mutations(from) as unknown as Sent,
      "paragraphSpanColumnType",
      "SpanColumns",
    );
    expect(
      ((await h.get(at(h), "paragraphSpanColumnType")) as { value: unknown })
        .value,
    ).toBe("SpanColumns");
  });

  test("Rule above: the pill writes a default rule, its weight patches it, off clears it", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    const pill = () =>
      h.root.querySelector<HTMLButtonElement>(
        '[data-toggle-switch="rule-above"]',
      )!;
    let from = h.mark();
    await h.click(pill());
    let sent = h.mutations(from) as unknown as Sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("paragraphRuleAbove");
    expect(sent[0].args.value.value).toMatchObject({ on: true });
    expect(
      h.root.querySelector('[data-rule-fields="rule-above"]'),
    ).not.toBeNull();

    from = h.mark();
    await h.typeInto(
      h.view.getByRole("textbox", { name: "rule-above weight" }),
      "3",
    );
    sent = h.mutations(from) as unknown as Sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.value.value).toMatchObject({ on: true, weight: 3 });

    from = h.mark();
    await h.click(pill());
    sent = h.mutations(from) as unknown as Sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("paragraphRuleAbove");
    expect(sent[0].args.value.value ?? null).toBeNull();
    expect(h.root.querySelector('[data-rule-fields="rule-above"]')).toBeNull();
  });

  test("one edit is one undo step", async () => {
    covers("panel:paged.paragraph");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    const before = await h.get(at(h), "paragraphSpaceAfter");
    await h.typeInto("paragraphSpaceAfter", "18");
    await h.act(() => h.client.undo());
    expect(await h.get(at(h), "paragraphSpaceAfter")).toEqual(before);
  });
});

describe("Paragraph panel: findings", () => {
  // The engine reads "no rule" as a spec whose every field is null, and the
  // pill turns that on as {...spec, on: true}: a rule with no weight and no
  // offset, while the row shows 1 pt. The panel's own comment says a pill
  // over no rule writes the default rule (1 pt, offset 0).
  test.failing(
    "PN-25: turning Rule above on over no rule writes the default 1 pt rule",
    async () => {
      covers("panel:paged.paragraph");
      const h = await mount();
      await h.caret(h.scene.storyId, 2);
      const from = h.mark();
      await h.click(
        h.root.querySelector<HTMLButtonElement>(
          '[data-toggle-switch="rule-above"]',
        )!,
      );
      const sent = h.mutations(from) as unknown as Sent;
      expect(sent[0].args.value.value).toMatchObject({
        on: true,
        weight: 1,
        offset: 0,
      });
    },
  );
});
