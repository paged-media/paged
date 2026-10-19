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

// Object Options (paged.object-options): the page-item paths no other
// panel lays out, as schema-driven fields over the element selection.
// Each control: the exact `set` it sends, the model reading it back, the
// field showing it. Several items: one batch, one undo step.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ObjectOptionsPanel } from "../../src/panels/object-options-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(ObjectOptionsPanel, {
    id: "paged.object-options",
    scene: richScene,
  });

const addr = (id: { kind: string; id: unknown }) => `${id.kind}:${id.id}`;

const set = (address: string, path: string, value: unknown) => ({
  op: "set",
  args: { address, path, value },
});

/** The value a field shows: its input's text, its select's value, or a
 *  switch's state. */
function shown(h: H, path: string): string | null {
  const f = h.field(path);
  const sw = f.querySelector('[role="switch"]');
  if (sw) return sw.getAttribute("aria-checked");
  const input = f.querySelector("input");
  if (input) return input.value;
  const select = f.querySelector("select");
  return select ? select.value : null;
}

const LAID_OUT = [
  "itemName",
  "itemLayer",
  "appliedObjectStyle",
  "frameCornerOptionTopLeft",
  "frameCornerRadiusTopLeft",
  "frameCornerOptionTopRight",
  "frameCornerRadiusTopRight",
  "frameCornerOptionBottomLeft",
  "frameCornerRadiusBottomLeft",
  "frameCornerOptionBottomRight",
  "frameCornerRadiusBottomRight",
  "frameStrokeStartArrowhead",
  "frameStrokeEndArrowhead",
  "frameStrokeDashArray",
  "frameGradientFillAngle",
  "frameGradientFillLength",
  "frameGradientFeather",
  "frameGradientStrokeAngle",
  "frameGradientStrokeLength",
  "frameTransform",
  "frameFlipV",
  "imageUri",
  "imageContentTransform",
  "framePath",
  "pluginMetadata",
];

describe("Object Options: states", () => {
  test("every laid-out path has its field, in its section", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    for (const path of LAID_OUT) expect(h.hasField(path)).toBe(true);
    const sections = [...h.root.querySelectorAll("[data-options-section]")].map(
      (s) => s.getAttribute("data-options-section"),
    );
    expect(sections).toEqual([
      "Item",
      "Corner Options",
      "Stroke Ends and Dashes",
      "Gradient",
      "Transform",
      "Image",
      "Advanced",
    ]);
    // The appearance stacks (paged.draw's object kind) sit in a section
    // that starts closed.
    expect(h.view.getByRole("button", { name: "Appearance" })).toBeTruthy();
  });

  test("nothing selected: every field is disabled and reads no value", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    for (const path of LAID_OUT) {
      expect(h.field(path).getAttribute("data-binding-state")).toBe("none");
      for (const c of h
        .field(path)
        .querySelectorAll<HTMLInputElement>("input, select, button")) {
        expect(c.disabled).toBe(true);
      }
    }
  });

  test("a rectangle: the fields read its values from the model", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.select([h.scene.rect]);
    for (const path of [
      "itemName",
      "itemLayer",
      "appliedObjectStyle",
      "frameCornerOptionTopLeft",
      "frameGradientFillAngle",
      "frameFlipV",
    ]) {
      expect(h.field(path).getAttribute("data-binding-state")).toBe("value");
    }
    expect(shown(h, "frameGradientFillAngle")).toBe("0 °");
    expect(shown(h, "frameFlipV")).toBe("false");
  });

  test("two items that disagree: the field reads mixed", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.mutate({
      op: "set",
      args: {
        address: addr(h.scene.rect),
        path: "itemName",
        value: { type: "text", value: "Left" },
      },
    } as never);
    await h.select([h.scene.rect, h.scene.groupA]);
    expect(h.field("itemName").getAttribute("data-binding-state")).toBe(
      "mixed",
    );
  });
});

describe("Object Options: every control writes the model", () => {
  test("Name: typing Hero sets itemName", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto("itemName", "Hero");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "itemName", { type: "text", value: "Hero" }),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "itemName")).toEqual({
      type: "text",
      value: "Hero",
    });
    expect(shown(h, "itemName")).toBe("Hero");
  });

  test("Layer: picking Artwork moves the item to that layer", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.choose("itemLayer", h.scene.layer);
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "itemLayer", {
        type: "text",
        value: h.scene.layer,
      }),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "itemLayer")).toEqual({
      type: "text",
      value: h.scene.layer,
    });
    expect(shown(h, "itemLayer")).toBe(h.scene.layer);
  });

  test("Object style: picking Box applies it", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.choose("appliedObjectStyle", h.scene.objectStyle);
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "appliedObjectStyle", {
        type: "text",
        value: h.scene.objectStyle,
      }),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "appliedObjectStyle")).toEqual({
      type: "text",
      value: h.scene.objectStyle,
    });
  });

  test("Corner: a rounded top-left corner of 6 pt", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.select([h.scene.rect]);
    let from = h.mark();
    await h.choose("frameCornerOptionTopLeft", "RoundedCorner");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameCornerOptionTopLeft", {
        type: "text",
        value: "RoundedCorner",
      }),
    ] as never);
    from = h.mark();
    await h.typeInto("frameCornerRadiusTopLeft", "6");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameCornerRadiusTopLeft", {
        type: "length",
        value: 6,
      }),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameCornerOptionTopLeft")).toEqual(
      { type: "text", value: "RoundedCorner" },
    );
    expect(await h.get(addr(h.scene.rect), "frameCornerRadiusTopLeft")).toEqual(
      { type: "length", value: 6 },
    );
    expect(shown(h, "frameCornerRadiusTopLeft")).toBe("6 pt");
  });

  test("Gradient: the fill angle typed as 45 degrees", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto("frameGradientFillAngle", "45");
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { address: string; path: string; value: { value: number } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.address).toBe(addr(h.scene.rect));
    expect(sent[0].args.path).toBe("frameGradientFillAngle");
    expect(sent[0].args.value.value).toBe(45);
    expect(shown(h, "frameGradientFillAngle")).toBe("45 °");
  });

  test("Flip V: the switch flips the item (its transform turns over)", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.click(h.field("frameFlipV").querySelector('[role="switch"]')!);
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameFlipV", { type: "bool", value: true }),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameTransform")).toEqual({
      type: "transform",
      value: [1, 0, 0, -1, 0, 0],
    });
  });

  test("two items: one name edit is one batch over both, one undo restores both", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA]);
    const from = h.mark();
    await h.typeInto("itemName", "Pair");
    expect(h.mutations(from)).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            set(addr(h.scene.rect), "itemName", {
              type: "text",
              value: "Pair",
            }),
            set(addr(h.scene.groupA), "itemName", {
              type: "text",
              value: "Pair",
            }),
          ],
        },
      },
    ] as never);
    await h.act(() => h.client.undo());
    for (const id of [h.scene.rect, h.scene.groupA]) {
      expect(await h.get(addr(id), "itemName")).toEqual({
        type: "text",
        value: "",
      });
    }
  });

  test("a disabled field sends nothing", async () => {
    covers("panel:paged.object-options");
    const h = await mount();
    const from = h.mark();
    const input = h.field("itemName").querySelector("input")!;
    await h.user.type(input, "X{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Object Options: findings", () => {
  // The engine answers noSuchPath for the arrowheads on a rectangle; the
  // fields show the mixed face, as the Stroke panel's join and miter do
  // on an oval (PN-3): one object cannot disagree with itself.
  test.failing(
    "PN-200: a rectangle's arrowhead fields read as not applicable, not as mixed",
    async () => {
      covers("panel:paged.object-options");
      const h = await mount();
      await h.select([h.scene.rect]);
      for (const path of [
        "frameStrokeStartArrowhead",
        "frameStrokeEndArrowhead",
      ]) {
        expect(h.field(path).getAttribute("data-binding-state")).not.toBe(
          "mixed",
        );
      }
    },
  );

  // The write lands (the transform turns to [1 0 0 -1 0 0]) but
  // frameFlipV reads back false, so the switch snaps back to off.
  test.failing(
    "PN-202: after Flip V is turned on, the switch reads on",
    async () => {
      covers("panel:paged.object-options");
      const h = await mount();
      await h.select([h.scene.rect]);
      await h.click(h.field("frameFlipV").querySelector('[role="switch"]')!);
      expect(shown(h, "frameFlipV")).toBe("true");
    },
  );

  // UX audit F-22: internal identifiers shown to users. The Stroke panel
  // names the same arrowheads ("Simple", "Triangle"); here the options
  // are the engine's enum strings.
  test.failing(
    "PN-201 (UX F-22): corner and arrowhead options are named in words, not enum ids",
    async () => {
      covers("panel:paged.object-options");
      const h = await mount();
      await h.select([h.scene.rect]);
      const labels = [
        ...h.field("frameCornerOptionTopLeft").querySelectorAll("option"),
        ...h.field("frameStrokeStartArrowhead").querySelectorAll("option"),
      ].map((o) => o.textContent ?? "");
      expect(labels.filter((l) => /[a-z](Corner|ArrowHead)$/.test(l))).toEqual(
        [],
      );
    },
  );
});
