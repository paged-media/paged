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

// Bullets & Numbering (paged.bullets-numbering): the list fields of the
// paragraph at the caret (object-model fields on the caret's story range;
// the continue mode on the selection binding) and the document's named
// numbering lists (create, rename, continuity, assign, delete). Each
// control: the exact message sent, the model reading it back, the panel
// showing it. Level and position are honest seams.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { BulletsPanel } from "../../src/panels/concept/bullets-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { listScene, type ListScene } from "./support/options";

afterEach(unmountAll);

type H = PanelHarness<ListScene>;

const CARET = 2;

const mount = () =>
  mountPanel(BulletsPanel, {
    id: "paged.bullets-numbering",
    scene: listScene,
  });

async function editing(): Promise<H> {
  const h = await mount();
  await h.caret(h.scene.storyId, CARET);
  return h;
}

const range = (h: H) => `storyRange:${h.scene.storyId}@${CARET}..${CARET}`;
const set = (h: H, path: string, value: unknown) => ({
  op: "set",
  args: { address: range(h), path, value },
});

const field = (h: H, id: string) =>
  h.root.querySelector<HTMLInputElement & HTMLSelectElement>(
    `[data-bullets-field="${id}"]`,
  )!;

/** Type into an uncontrolled text field and leave it (Enter blurs). */
async function typeText(h: H, el: HTMLInputElement, text: string) {
  await h.user.clear(el);
  await h.user.type(el, `${text}{Enter}`);
  await h.settle();
}

describe("Bullets & Numbering: states", () => {
  test("no caret: every paragraph field is disabled and sends nothing", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await mount();
    for (const v of ["NoList", "BulletList", "NumberedList"]) {
      expect(
        h
          .field("paragraphListType")
          .querySelector<HTMLButtonElement>(`[data-option-value="${v}"]`)!
          .disabled,
      ).toBe(true);
    }
    for (const id of [
      "numbering-format",
      "numbering-expression",
      "numbering-mode",
      "bullet-character",
      "bullets-text-after",
    ]) {
      expect(field(h, id).disabled).toBe(true);
    }
    expect(
      h.root.querySelector<HTMLButtonElement>("[data-list-def-assign]")!
        .disabled,
    ).toBe(true);
    const from = h.mark();
    await h.press("paragraphListType", "BulletList");
    expect(h.mutations(from)).toEqual([]);
  });

  test("a caret: the paragraph's list fields come alive; the list type reads None", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await editing();
    expect(
      h
        .field("paragraphListType")
        .querySelector('[data-active="true"]')!
        .getAttribute("data-option-value"),
    ).toBe("NoList");
    expect(field(h, "numbering-format").disabled).toBe(false);
    expect(
      h.root.querySelector<HTMLButtonElement>("[data-list-def-assign]")!
        .disabled,
    ).toBe(false);
  });

  test("the seams (level, position, alignment, indent, tab) are disabled", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await editing();
    for (const el of h.root.querySelectorAll<HTMLSelectElement>(
      "select[data-seam]",
    )) {
      expect(el.disabled).toBe(true);
    }
    expect(
      h.root.querySelector("[data-applied-readback-seam]")!.textContent,
    ).toContain("cannot read it back");
  });
});

describe("Bullets & Numbering: paragraph fields write the paragraph", () => {
  for (const [label, value] of [
    ["Bullet", "BulletList"],
    ["Number", "NumberedList"],
  ] as const) {
    test(`List type: ${label}`, async () => {
      covers("panel:paged.bullets-numbering");
      const h = await editing();
      const from = h.mark();
      await h.press("paragraphListType", value);
      expect(h.mutations(from)).toEqual([
        set(h, "paragraphListType", { type: "text", value }),
      ] as never);
      expect(await h.get(range(h), "paragraphListType")).toEqual({
        type: "text",
        value,
      });
      expect(
        h
          .field("paragraphListType")
          .querySelector('[data-active="true"]')!
          .getAttribute("data-option-value"),
      ).toBe(value);
    });
  }

  test("Numbering style: I, II, III", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await editing();
    const from = h.mark();
    await h.choose(field(h, "numbering-format"), "I, II, III, IV...");
    expect(h.mutations(from)).toEqual([
      set(h, "paragraphNumberingFormat", {
        type: "text",
        value: "I, II, III, IV...",
      }),
    ] as never);
    expect(await h.get(range(h), "paragraphNumberingFormat")).toEqual({
      type: "text",
      value: "I, II, III, IV...",
    });
  });

  test("Number expression, bullet character and text after: each its own write", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await editing();
    for (const [id, path, text] of [
      ["numbering-expression", "paragraphNumberingExpression", "^#.^t"],
      ["bullet-character", "paragraphBulletCharacter", "*"],
      ["bullets-text-after", "paragraphBulletsTextAfter", "^t"],
    ] as const) {
      const from = h.mark();
      await typeText(h, field(h, id), text);
      expect(h.mutations(from)).toEqual([
        set(h, path, { type: "text", value: text }),
      ] as never);
      expect(await h.get(range(h), path)).toEqual({
        type: "text",
        value: text,
      });
    }
  });

  test("Start at: typing 5", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await editing();
    const from = h.mark();
    await h.typeInto("paragraphNumberingStartAt", "5");
    expect(h.mutations(from)).toEqual([
      set(h, "paragraphNumberingStartAt", { type: "length", value: 5 }),
    ] as never);
    expect(await h.get(range(h), "paragraphNumberingStartAt")).toEqual({
      type: "length",
      value: 5,
    });
  });

  test("Mode: continue from the previous number (the three-state bool)", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await editing();
    const from = h.mark();
    await h.choose(field(h, "numbering-mode"), "continue");
    expect(h.mutations(from)).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: {
            kind: "storyRange",
            id: { story_id: h.scene.storyId, start: CARET, end: CARET },
          },
          path: "paragraphNumberingContinue",
          value: { type: "bool", value: true },
        },
      },
    ] as never);
    expect(field(h, "numbering-mode").value).toBe("continue");
  });

  test("Character styles of the number and of the bullet", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await editing();
    const style = "CharacterStyle/$ID/[No character style]";
    for (const path of [
      "paragraphNumberingCharacterStyle",
      "paragraphBulletsCharacterStyle",
    ]) {
      const from = h.mark();
      await h.choose(path, style);
      expect(h.mutations(from)).toEqual([
        set(h, path, { type: "text", value: style }),
      ] as never);
    }
  });
});

describe("Bullets & Numbering: list definitions", () => {
  const edit = (h: H, spec: Record<string, unknown>) => ({
    op: "editNumberingList",
    args: {
      listId: h.scene.list,
      spec: {
        selfId: h.scene.list,
        name: "Steps",
        continueAcrossStories: false,
        continueAcrossDocuments: false,
        ...spec,
      },
    },
  });
  const lists = async (h: H) =>
    (await h.client.collection("numberingLists")) as Array<{
      selfId: string;
      name: string;
      continueAcrossStories: boolean;
    }>;

  test("the document's list, by name", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await mount();
    expect(
      h.root.querySelector(
        `[data-list-def="${h.scene.list}"] [data-list-def-name]`,
      )!.textContent,
    ).toBe("Steps");
  });

  test("New list creates one", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await mount();
    const from = h.mark();
    await h.click(h.view.getByRole("button", { name: "New list" }));
    expect(h.mutations(from)).toEqual([
      {
        op: "createNumberingList",
        args: {
          spec: {
            selfId: null,
            name: "New list",
            continueAcrossStories: false,
            continueAcrossDocuments: false,
          },
        },
      },
    ] as never);
    expect((await lists(h)).map((l) => l.name)).toEqual(["Steps", "New list"]);
    expect(h.root.querySelectorAll("[data-list-def]")).toHaveLength(2);
  });

  test("Rename: double-click the name, type, Enter", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await mount();
    await h.user.dblClick(h.root.querySelector("[data-list-def-name]")!);
    const input = h.view.getByRole("textbox", {
      name: "list name",
    }) as HTMLInputElement;
    const from = h.mark();
    await typeText(h, input, "Chapters");
    expect(h.mutations(from)).toEqual([edit(h, { name: "Chapters" })] as never);
    expect((await lists(h))[0].name).toBe("Chapters");
    expect(h.root.querySelector("[data-list-def-name]")!.textContent).toBe(
      "Chapters",
    );
  });

  test("Continuity: the switch continues numbers across stories", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await mount();
    const sw = h.root.querySelector("[data-list-def-continuity]")!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    const from = h.mark();
    await h.click(sw);
    expect(h.mutations(from)).toEqual([
      edit(h, { continueAcrossStories: true }),
    ] as never);
    expect((await lists(h))[0].continueAcrossStories).toBe(true);
    expect(
      h.root
        .querySelector("[data-list-def-continuity]")!
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("Assign: the list goes on the caret's paragraph", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await editing();
    const from = h.mark();
    await h.click(h.root.querySelector("[data-list-def-assign]")!);
    expect(h.mutations(from)).toEqual([
      set(h, "paragraphAppliedNumberingList", {
        type: "text",
        value: h.scene.list,
      }),
    ] as never);
  });

  test("Delete removes the list", async () => {
    covers("panel:paged.bullets-numbering");
    const h = await mount();
    const from = h.mark();
    await h.click(
      h.view.getByRole("button", { name: "Delete list definition" }),
    );
    expect(h.mutations(from)).toEqual([
      { op: "deleteNumberingList", args: { listId: h.scene.list } },
    ] as never);
    expect(await lists(h)).toEqual([]);
    expect(h.root.querySelector("[data-empty-list-definitions]")).not.toBe(
      null,
    );
  });
});
