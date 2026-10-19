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

// Conditions (paged.conditions): the document's conditions with a
// visibility eye per row (the typed core command setConditionVisible),
// seam toolbar buttons, and the Conditional text field over the text
// selection (`storyRange` `appliedConditions`).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ConditionsPanel } from "../../src/panels/conditions-panel";
import { mountPanel, unmountAll } from "./harness";
import {
  rows,
  seamButtons,
  structureIdml,
  STRUCTURE,
} from "./support/structure";

afterEach(unmountAll);

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(ConditionsPanel, { id: "paged.conditions", document });

const toggle = (root: Element, id: string) =>
  root.querySelector<HTMLButtonElement>(`[data-condition-toggle="${id}"]`)!;

describe("Conditions panel: states", () => {
  test("no document: the empty state, the seams disabled", async () => {
    covers("panel:paged.conditions");
    const h = await mount("none");
    expect(h.root.querySelector("[data-empty-conditions]")).not.toBeNull();
    expect(seamButtons(h.root).map((b) => b.disabled)).toEqual([true, true]);
  });

  test("a document without conditions: the empty state", async () => {
    covers("panel:paged.conditions");
    const h = await mount("blank");
    expect(h.root.querySelector("[data-empty-conditions]")?.textContent).toBe(
      "No conditions in this document.",
    );
  });

  test("lists every condition with its indicator and visibility", async () => {
    covers("panel:paged.conditions");
    const h = await mount();
    expect(rows(h.root).map((r) => [r.key, r.primary, r.secondary])).toEqual([
      [STRUCTURE.conditions.draft, "Draft", "UseHighlight"],
      [STRUCTURE.conditions.final, "Final", "UseUnderline"],
    ]);
    expect(toggle(h.root, STRUCTURE.conditions.draft).title).toBe(
      "Hide condition",
    );
    expect(toggle(h.root, STRUCTURE.conditions.final).title).toBe(
      "Show condition",
    );
  });
});

describe("Conditions panel: controls", () => {
  test("the eye hides a visible condition: setConditionVisible false, and the row follows", async () => {
    covers("panel:paged.conditions");
    const h = await mount();
    const from = h.mark();
    await h.click(toggle(h.root, STRUCTURE.conditions.draft));
    expect(h.mutations(from)).toEqual([
      {
        op: "setConditionVisible",
        args: { condition: STRUCTURE.conditions.draft, visible: false },
      },
    ] as never);
    const model = (await h.client.collection("conditions")) as Array<{
      selfId: string;
      visible: boolean;
    }>;
    expect(
      model.find((c) => c.selfId === STRUCTURE.conditions.draft)?.visible,
    ).toBe(false);
    expect(
      toggle(h.root, STRUCTURE.conditions.draft).getAttribute(
        "data-condition-visible",
      ),
    ).toBe("false");
    expect(toggle(h.root, STRUCTURE.conditions.draft).title).toBe(
      "Show condition",
    );
  });

  test("the eye shows a hidden condition, and one undo hides it again", async () => {
    covers("panel:paged.conditions");
    const h = await mount();
    const from = h.mark();
    await h.click(toggle(h.root, STRUCTURE.conditions.final));
    expect(h.mutations(from)).toEqual([
      {
        op: "setConditionVisible",
        args: { condition: STRUCTURE.conditions.final, visible: true },
      },
    ] as never);
    expect(
      toggle(h.root, STRUCTURE.conditions.final).getAttribute(
        "data-condition-visible",
      ),
    ).toBe("true");
    await h.act(() => h.client.undo());
    expect(
      toggle(h.root, STRUCTURE.conditions.final).getAttribute(
        "data-condition-visible",
      ),
    ).toBe("false");
  });

  test("the seam buttons send nothing", async () => {
    covers("panel:paged.conditions");
    const h = await mount();
    const from = h.mark();
    for (const b of seamButtons(h.root)) {
      expect(b.disabled).toBe(true);
      await h.click(b);
    }
    expect(h.mutations(from)).toEqual([]);
  });

  test("Conditional text: disabled with no text selected", async () => {
    covers("panel:paged.conditions");
    const h = await mount();
    expect(
      h.field("appliedConditions").getAttribute("data-binding-state"),
    ).toBe("none");
    expect(h.field("appliedConditions").querySelector("select")!.disabled).toBe(
      true,
    );
  });

  test("Conditional text: choosing a condition applies it to the selected range", async () => {
    covers("panel:paged.conditions");
    const h = await mount();
    await h.selectText(STRUCTURE.story, 0, 5);
    const select = h.field("appliedConditions").querySelector("select")!;
    expect(select.disabled).toBe(false);
    expect([...select.options].map((o) => o.text)).toEqual([
      "—",
      "[None]",
      "Draft",
      "Final",
    ]);
    const from = h.mark();
    await h.choose("appliedConditions", STRUCTURE.conditions.draft);
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address: `storyRange:${STRUCTURE.story}@0..5`,
          path: "appliedConditions",
          value: { type: "text", value: STRUCTURE.conditions.draft },
        },
      },
    ] as never);
    // The engine applied it: the run is split at the range's end.
    const content = (await h.client.send({
      kind: "requestStoryContent",
      payload: { storyId: STRUCTURE.story },
    } as never)) as {
      payload: {
        content: { paragraphs: Array<{ runs: Array<{ text: string }> }> };
      };
    };
    expect(
      content.payload.content.paragraphs[0].runs.map((r) => r.text),
    ).toEqual(["Struc", "ture text"]);
  });
});

describe("Conditions panel: findings", () => {
  // The engine answers noSuchPath for storyRange.appliedConditions: the
  // field writes, but can never read, so it says "mixed" for a range that
  // carries no condition and still says "mixed" after Draft was applied.
  test.failing(
    "PN-100: Conditional text reads back the condition it just applied",
    async () => {
      covers("panel:paged.conditions");
      const h = await mount();
      await h.selectText(STRUCTURE.story, 0, 5);
      await h.choose("appliedConditions", STRUCTURE.conditions.draft);
      expect(
        h.field("appliedConditions").getAttribute("data-binding-state"),
      ).toBe("value");
      expect(h.field("appliedConditions").querySelector("select")!.value).toBe(
        STRUCTURE.conditions.draft,
      );
    },
  );
});
