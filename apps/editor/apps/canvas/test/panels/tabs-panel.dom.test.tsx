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

// Tabs (paged.tabs): the tab-stop editor of the paragraph at the text
// caret. Every edit commits the WHOLE stop list as one
// `setElementProperty(paragraphTabStops)` on the caret's story range (the
// only wire shape there is), so each control is asserted as the exact
// list it sends, the model's list read back, and the row it shows.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { TabsPanel } from "../../src/panels/concept/tabs-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

interface Stop {
  position: number;
  alignment: string;
  alignmentCharacter: string | null;
  leader: string | null;
}

const stop = (position: number, more: Partial<Stop> = {}): Stop => ({
  position,
  alignment: "LeftAlign",
  alignmentCharacter: null,
  leader: null,
  ...more,
});

const mount = () =>
  mountPanel(TabsPanel, { id: "paged.tabs", scene: richScene });

/** The caret the tests edit from, and the write it produces. */
const CARET = 2;
const write = (h: H, stops: Stop[]) => ({
  op: "setElementProperty",
  args: {
    elementId: {
      kind: "storyRange",
      id: { story_id: h.scene.storyId, start: CARET, end: CARET },
    },
    path: "paragraphTabStops",
    value: { type: "tabStops", value: stops },
  },
});

/** The paragraph's stops as the model holds them. */
const modelStops = async (h: H) =>
  (
    (await h.get(
      `storyRange:${h.scene.storyId}@0..5`,
      "paragraphTabStops",
    )) as {
      value: Stop[];
    }
  ).value;

const add = (h: H) =>
  h.click(h.root.querySelector<HTMLElement>("[data-tab-add]")!);

async function editing(): Promise<H> {
  const h = await mount();
  await h.caret(h.scene.storyId, CARET);
  return h;
}

describe("Tabs: states", () => {
  test("no caret: says so, and nothing can be added", async () => {
    covers("panel:paged.tabs");
    const h = await mount();
    expect(h.root.querySelector("[data-tabs-empty]")!.textContent).toBe(
      "Place a text caret to edit tab stops.",
    );
    const addBtn = h.view.getByRole("button", { name: "Add tab stop" });
    expect((addBtn as HTMLButtonElement).disabled).toBe(true);
    const from = h.mark();
    await h.click(addBtn);
    expect(h.mutations(from)).toEqual([]);
  });

  test("a caret in a paragraph without stops: an empty ruler, Add offered", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    expect(h.root.querySelector("[data-tabs-empty]")!.textContent).toBe(
      "No tab stops. Add one to begin.",
    );
    expect(h.root.querySelectorAll("[data-tab-marker]")).toHaveLength(0);
    expect(
      (
        h.view.getByRole("button", {
          name: "Add tab stop",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test("a paragraph that has stops: one row and one ruler marker each", async () => {
    covers("panel:paged.tabs");
    const h = await mount();
    await h.mutate(
      write(h, [stop(36), stop(144, { alignment: "RightAlign" })]) as never,
    );
    await h.caret(h.scene.storyId, CARET);
    expect(h.root.querySelectorAll("[data-tab-stop]")).toHaveLength(2);
    expect(h.root.querySelectorAll("[data-tab-marker]")).toHaveLength(2);
    expect(
      (
        h.view.getByRole("combobox", {
          name: "stop 1 alignment",
        }) as HTMLSelectElement
      ).value,
    ).toBe("RightAlign");
    expect(
      (
        h.view.getByRole("textbox", {
          name: "stop 1 position",
        }) as HTMLInputElement
      ).value,
    ).toBe("144 pt");
  });
});

describe("Tabs: every control commits the whole list", () => {
  test("Add tab stop: a left stop at 36 pt, then the next 36 pt on", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    let from = h.mark();
    await add(h);
    expect(h.mutations(from)).toEqual([write(h, [stop(36)])] as never);
    expect(await modelStops(h)).toEqual([stop(36)]);
    from = h.mark();
    await add(h);
    expect(h.mutations(from)).toEqual([
      write(h, [stop(36), stop(72)]),
    ] as never);
    expect(h.root.querySelectorAll("[data-tab-marker]")).toHaveLength(2);
  });

  test("Alignment: Center", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    await add(h);
    const from = h.mark();
    await h.choose(
      h.view.getByRole("combobox", { name: "stop 0 alignment" }),
      "CenterAlign",
    );
    expect(h.mutations(from)).toEqual([
      write(h, [stop(36, { alignment: "CenterAlign" })]),
    ] as never);
    expect(await modelStops(h)).toEqual([
      stop(36, { alignment: "CenterAlign" }),
    ]);
  });

  test("Position: typing 50 moves the stop", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    await add(h);
    const from = h.mark();
    await h.typeInto(
      h.view.getByRole("textbox", { name: "stop 0 position" }),
      "50",
    );
    expect(h.mutations(from)).toEqual([write(h, [stop(50)])] as never);
    expect(await modelStops(h)).toEqual([stop(50)]);
  });

  test("Leader: a dot leader", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    await add(h);
    const from = h.mark();
    const leader = h.view.getByRole("textbox", { name: "stop 0 leader" });
    await h.user.type(leader, ".{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([
      write(h, [stop(36, { leader: "." })]),
    ] as never);
    expect(await modelStops(h)).toEqual([stop(36, { leader: "." })]);
  });

  test("Decimal alignment: the align-on character appears and writes", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    await add(h);
    expect(
      h.view.queryByRole("textbox", { name: "stop 0 align character" }),
    ).toBe(null);
    await h.choose(
      h.view.getByRole("combobox", { name: "stop 0 alignment" }),
      "CharacterAlign",
    );
    const char = h.view.getByRole("textbox", {
      name: "stop 0 align character",
    }) as HTMLInputElement;
    expect(char.value).toBe(".");
    const from = h.mark();
    await h.user.clear(char);
    await h.user.type(char, ",{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([
      write(h, [
        stop(36, { alignment: "CharacterAlign", alignmentCharacter: "," }),
      ]),
    ] as never);
  });

  test("Move down / up: the two stops swap in the list", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    await add(h);
    await add(h);
    const up = h.view.getByRole("button", {
      name: "move stop 0 up",
    }) as HTMLButtonElement;
    const down = h.view.getByRole("button", {
      name: "move stop 1 down",
    }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(true);
    const from = h.mark();
    await h.click(h.view.getByRole("button", { name: "move stop 0 down" }));
    expect(h.mutations(from)).toEqual([
      write(h, [stop(72), stop(36)]),
    ] as never);
    expect(await modelStops(h)).toEqual([stop(72), stop(36)]);
  });

  test("Delete stop: the list without it", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    await add(h);
    await add(h);
    const from = h.mark();
    await h.click(h.view.getByRole("button", { name: "delete stop 0" }));
    expect(h.mutations(from)).toEqual([write(h, [stop(72)])] as never);
    expect(await modelStops(h)).toEqual([stop(72)]);
    expect(h.root.querySelectorAll("[data-tab-stop]")).toHaveLength(1);
  });

  test("undo: the editor re-seeds from the model", async () => {
    covers("panel:paged.tabs");
    const h = await editing();
    await add(h);
    await add(h);
    await h.act(() => h.client.undo());
    expect(await modelStops(h)).toEqual([stop(36)]);
    expect(h.root.querySelectorAll("[data-tab-stop]")).toHaveLength(1);
  });
});
