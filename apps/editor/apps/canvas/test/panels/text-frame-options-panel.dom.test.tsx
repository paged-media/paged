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

// Text Frame (paged.text-frame-options): the text-frame preferences of
// the selected frames (columns, gutter, balance, inset, vertical
// justification, auto-size, first baseline) and the page-growth settings
// of the stories they show. Each control: the exact write, the model
// read back, the field showing it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { TextFrameOptionsPanel } from "../../src/panels/text-frame-options-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";
import {
  addr,
  allDisabled,
  batch,
  bool,
  bounds,
  boundsCell,
  len,
  set,
  shown,
  state,
  text,
} from "./support/frames";

afterEach(unmountAll);

const mount = () =>
  mountPanel(TextFrameOptionsPanel, {
    id: "paged.text-frame-options",
    scene: richScene,
  });

const FIELDS = [
  "textFrameColumnCount",
  "textFrameColumnGutter",
  "textFrameColumnBalance",
  "frameInsetSpacing",
  "textFrameVerticalJustification",
  "textFrameAutoSizing",
  "textFrameFirstBaseline",
];

describe("Text Frame panel: states", () => {
  test("nothing selected: every field there and disabled, no page growth", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    for (const path of FIELDS) {
      expect(state(h, path)).toBe("none");
      expect(allDisabled(h.field(path))).toBe(true);
    }
    expect(h.root.querySelector("[data-flow-grow]")).toBeNull();
  });

  test("a text frame: its settings, and the page growth of its story", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    for (const path of FIELDS) expect(state(h, path)).toBe("value");
    expect(shown(h, "textFrameColumnCount")).toBe("1");
    expect(shown(h, "textFrameColumnGutter")).toBe("12 pt");
    expect(shown(h, "textFrameVerticalJustification")).toBe("TopAlign");
    expect(shown(h, "textFrameAutoSizing")).toBe("Off");
    expect(shown(h, "textFrameFirstBaseline")).toBe("AscentOffset");
    expect(boundsCell(h, "frameInsetSpacing", "T").value).toBe("0");
    expect(
      h.root.querySelector("[data-flow-grow]")?.getAttribute("data-flow-grow"),
    ).toBe(`story:${h.scene.storyId}`);
  });

  test("two text frames: the page growth targets both stories", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame, h.scene.tableFrame]);
    expect(
      h.root
        .querySelector("[data-flow-grow]")
        ?.getAttribute("data-flow-grow")
        ?.split(" ")
        .sort(),
    ).toEqual(
      [`story:${h.scene.storyId}`, `story:${h.scene.tableStoryId}`].sort(),
    );
  });

  test("two text frames that disagree: that field reads mixed, the others agree", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.mutate(
      set(addr(h.scene.tableFrame), "textFrameColumnCount", len(3)) as never,
    );
    await h.select([h.scene.textFrame, h.scene.tableFrame]);
    expect(state(h, "textFrameColumnCount")).toBe("mixed");
    expect(state(h, "textFrameAutoSizing")).toBe("value");
  });
});

describe("Text Frame panel: every control writes the selected frame", () => {
  test("Columns: typing 2 writes the column count", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    const from = h.mark();
    await h.typeInto("textFrameColumnCount", "2");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.textFrame), "textFrameColumnCount", len(2)),
    ] as never);
    expect(
      await h.get(addr(h.scene.textFrame), "textFrameColumnCount"),
    ).toEqual(len(2));
    expect(shown(h, "textFrameColumnCount")).toBe("2");
  });

  test("Gutter: typing 18 writes it", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    const from = h.mark();
    await h.typeInto("textFrameColumnGutter", "18");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.textFrame), "textFrameColumnGutter", len(18)),
    ] as never);
    expect(shown(h, "textFrameColumnGutter")).toBe("18 pt");
  });

  test("Balance: the switch flips it", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    const sw = h
      .field("textFrameColumnBalance")
      .querySelector<HTMLElement>('[role="switch"]')!;
    const was = sw.getAttribute("aria-checked") === "true";
    const from = h.mark();
    await h.click(sw);
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.textFrame), "textFrameColumnBalance", bool(!was)),
    ] as never);
    expect(
      await h.get(addr(h.scene.textFrame), "textFrameColumnBalance"),
    ).toEqual(bool(!was));
    expect(sw.getAttribute("aria-checked")).toBe(String(!was));
  });

  test("Inset: typing into one side writes all four, the others kept", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    const from = h.mark();
    await h.typeInto(boundsCell(h, "frameInsetSpacing", "L"), "9");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.textFrame), "frameInsetSpacing", bounds([0, 9, 0, 0])),
    ] as never);
    expect(await h.get(addr(h.scene.textFrame), "frameInsetSpacing")).toEqual(
      bounds([0, 9, 0, 0]),
    );
  });

  for (const value of ["CenterAlign", "BottomAlign", "JustifyAlign"]) {
    test(`Vertical justification: the ${value} segment writes it`, async () => {
      covers("panel:paged.text-frame-options");
      const h = await mount();
      await h.select([h.scene.textFrame]);
      const from = h.mark();
      await h.press("textFrameVerticalJustification", value);
      expect(h.mutations(from)).toEqual([
        set(
          addr(h.scene.textFrame),
          "textFrameVerticalJustification",
          text(value),
        ),
      ] as never);
      expect(shown(h, "textFrameVerticalJustification")).toBe(value);
    });
  }

  for (const [path, value] of [
    ["textFrameAutoSizing", "HeightOnly"],
    ["textFrameAutoSizing", "HeightAndWidthProportionally"],
    ["textFrameFirstBaseline", "CapHeight"],
    ["textFrameFirstBaseline", "FixedHeight"],
  ] as const) {
    test(`${path}: choosing ${value} writes it`, async () => {
      covers("panel:paged.text-frame-options");
      const h = await mount();
      await h.select([h.scene.textFrame]);
      const from = h.mark();
      await h.choose(path, value);
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.textFrame), path, text(value)),
      ] as never);
      expect(await h.get(addr(h.scene.textFrame), path)).toEqual(text(value));
      expect(shown(h, path)).toBe(value);
    });
  }

  test("Page growth: the switch writes the story's flowGrow", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    const story = `story:${h.scene.storyId}`;
    const sw = h
      .field("flowGrow")
      .querySelector<HTMLElement>('[role="switch"]')!;
    const was = sw.getAttribute("aria-checked") === "true";
    const from = h.mark();
    await h.click(sw);
    expect(h.mutations(from)).toEqual([
      set(story, "flowGrow", bool(!was)),
    ] as never);
    expect(await h.get(story, "flowGrow")).toEqual(bool(!was));
  });

  test("Page growth: at most N pages", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    const story = `story:${h.scene.storyId}`;
    const from = h.mark();
    await h.typeInto("flowGrowMaxPages", "4");
    expect(h.mutations(from)).toEqual([
      set(story, "flowGrowMaxPages", len(4)),
    ] as never);
    expect(await h.get(story, "flowGrowMaxPages")).toEqual(len(4));
  });

  test("two text frames: one edit is one batch, one undo restores both", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.textFrame, h.scene.tableFrame]);
    const before = await Promise.all(
      [h.scene.textFrame, h.scene.tableFrame].map((id) =>
        h.get(addr(id), "textFrameColumnGutter"),
      ),
    );
    const from = h.mark();
    await h.typeInto("textFrameColumnGutter", "6");
    expect(h.mutations(from)).toEqual([
      batch(
        set(addr(h.scene.textFrame), "textFrameColumnGutter", len(6)),
        set(addr(h.scene.tableFrame), "textFrameColumnGutter", len(6)),
      ),
    ] as never);
    await h.act(() => h.client.undo());
    const after = await Promise.all(
      [h.scene.textFrame, h.scene.tableFrame].map((id) =>
        h.get(addr(id), "textFrameColumnGutter"),
      ),
    );
    expect(after).toEqual(before);
    expect(shown(h, "textFrameColumnGutter")).toBe("12 pt");
  });
});

describe("Text Frame panel: findings", () => {
  // A rectangle has no text-frame preferences: the engine answers
  // noSuchPath for every one. The panel shows each field as "mixed" (a
  // single object cannot disagree with itself) and leaves it editable;
  // typing sends a write the engine refuses ("TextFrameColumnCount is not
  // supported on Rectangle").
  test("PN-253: on a rectangle the text-frame fields read as not applicable and send nothing", async () => {
    covers("panel:paged.text-frame-options");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(state(h, "textFrameColumnCount")).not.toBe("mixed");
    const from = h.mark();
    // Not live: the input takes no typing, so nothing is sent.
    expect(
      h.field("textFrameColumnCount").querySelector("input")?.disabled,
    ).toBe(true);
    expect(h.mutations(from)).toEqual([]);
  });
});
