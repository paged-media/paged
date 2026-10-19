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

// Anchored Object (paged.anchored): the position of a frame anchored into
// a text story. It reads the lone selected element's properties and says
// plainly when the selection is not an anchored object; the custom
// position controls are disabled until the mode is Custom. Each control:
// the exact `set` it sends, the model reading it back, the panel showing it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { AnchoredPanel } from "../../src/panels/concept/anchored-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { anchoredScene, type AnchoredScene } from "./support/options";

afterEach(unmountAll);

type H = PanelHarness<AnchoredScene>;

const mount = () =>
  mountPanel(AnchoredPanel, { id: "paged.anchored", scene: anchoredScene });

const addr = (id: { kind: string; id: unknown }) => `${id.kind}:${id.id}`;

const status = (h: PanelHarness<unknown>) =>
  h.root.querySelector("[data-anchored-status]")!;
const select = (h: H, id: string) =>
  h.root.querySelector<HTMLSelectElement>(`[data-anchored-select="${id}"]`)!;
const toggle = (h: H, id: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-anchored-toggle="${id}"]`)!;
const offset = (h: H, id: string) =>
  h.root.querySelector<HTMLInputElement>(`[data-anchored-num="${id}"] input`)!;

async function anchored(): Promise<H> {
  const h = await mount();
  await h.select([h.scene.anchored]);
  return h;
}

const set = (h: H, path: string, value: unknown) => ({
  op: "set",
  args: { address: addr(h.scene.anchored), path, value },
});

describe("Anchored Object: states", () => {
  test("nothing selected: asks for a single object", async () => {
    covers("panel:paged.anchored");
    const h = await mount();
    expect(status(h).getAttribute("data-anchored-status")).toBe("none");
    expect(status(h).textContent).toBe("Select a single object.");
    expect(
      h.root.querySelector("[data-anchored-empty]")!.textContent,
    ).toContain("Select an object anchored into a text story");
  });

  test("two objects: still asks for a single one", async () => {
    covers("panel:paged.anchored");
    const h = await mountPanel(AnchoredPanel, {
      id: "paged.anchored",
      scene: richScene,
    });
    await h.select([h.scene.rect, h.scene.oval]);
    expect(status(h).getAttribute("data-anchored-status")).toBe("none");
  });

  test("a frame on the page: says it is not anchored, offers no controls", async () => {
    covers("panel:paged.anchored");
    const h = await mountPanel(AnchoredPanel, {
      id: "paged.anchored",
      scene: richScene,
    });
    await h.select([h.scene.rect]);
    expect(status(h).getAttribute("data-anchored-status")).toBe("not-anchored");
    expect(status(h).textContent).toBe("Rectangle is not anchored");
    expect(h.root.querySelector("[data-anchored-select]")).toBe(null);
  });

  test("an anchored frame: its position controls; custom ones wait for Custom", async () => {
    covers("panel:paged.anchored");
    const h = await anchored();
    expect(status(h).getAttribute("data-anchored-status")).toBe("anchored");
    expect(status(h).textContent).toBe("Anchored Rectangle");
    expect(select(h, "position").disabled).toBe(false);
    expect(toggle(h, "spine-relative").disabled).toBe(false);
    expect(h.root.querySelector("[data-anchored-custom-hint]")).not.toBe(null);
    expect(offset(h, "x-offset").disabled).toBe(true);
    for (const id of [
      "anchor-point",
      "h-reference",
      "v-reference",
      "h-align",
      "v-align",
    ]) {
      expect(select(h, id).disabled).toBe(true);
    }
    const from = h.mark();
    await h.user.type(offset(h, "x-offset"), "9{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Anchored Object: every control writes the anchored frame", () => {
  test("Mode: Custom enables the custom position", async () => {
    covers("panel:paged.anchored");
    const h = await anchored();
    const from = h.mark();
    await h.choose(select(h, "position"), "Anchored");
    expect(h.mutations(from)).toEqual([
      set(h, "anchoredPosition", { type: "text", value: "Anchored" }),
    ] as never);
    expect(await h.get(addr(h.scene.anchored), "anchoredPosition")).toEqual({
      type: "text",
      value: "Anchored",
    });
    expect(select(h, "position").value).toBe("Anchored");
    expect(offset(h, "x-offset").disabled).toBe(false);
    expect(h.root.querySelector("[data-anchored-custom-hint]")).toBe(null);
  });

  for (const [id, path] of [
    ["spine-relative", "anchoredSpineRelative"],
    ["lock-position", "anchoredLockPosition"],
  ] as const) {
    test(`${id}: the switch turns it on`, async () => {
      covers("panel:paged.anchored");
      const h = await anchored();
      const from = h.mark();
      await h.click(toggle(h, id));
      expect(h.mutations(from)).toEqual([
        set(h, path, { type: "bool", value: true }),
      ] as never);
      expect(await h.get(addr(h.scene.anchored), path)).toEqual({
        type: "bool",
        value: true,
      });
      expect(toggle(h, id).getAttribute("aria-checked")).toBe("true");
    });
  }

  for (const [id, path, value] of [
    ["x-offset", "anchoredXOffset", 12],
    ["y-offset", "anchoredYOffset", -6],
  ] as const) {
    test(`${id}: typing ${value} in Custom mode`, async () => {
      covers("panel:paged.anchored");
      const h = await anchored();
      await h.choose(select(h, "position"), "Anchored");
      const from = h.mark();
      await h.typeInto(offset(h, id), String(value));
      expect(h.mutations(from)).toEqual([
        set(h, path, { type: "length", value }),
      ] as never);
      expect(await h.get(addr(h.scene.anchored), path)).toEqual({
        type: "length",
        value,
      });
    });
  }

  for (const [id, path, value] of [
    ["h-reference", "anchoredHorizontalReference", "PageMargin"],
    ["v-reference", "anchoredVerticalReference", "LineBaseline"],
    ["h-align", "anchoredHorizontalAlignment", "RightAlign"],
    ["v-align", "anchoredVerticalAlignment", "BottomAlign"],
  ] as const) {
    test(`${id}: ${value} in Custom mode`, async () => {
      covers("panel:paged.anchored");
      const h = await anchored();
      await h.choose(select(h, "position"), "Anchored");
      const from = h.mark();
      await h.choose(select(h, id), value);
      expect(h.mutations(from)).toEqual([
        set(h, path, { type: "text", value }),
      ] as never);
      expect(await h.get(addr(h.scene.anchored), path)).toEqual({
        type: "text",
        value,
      });
      expect(select(h, id).value).toBe(value);
    });
  }

  // The panel's anchor-point options are spelled TopLeftAnchor …
  // BottomRightAnchor; the engine's schema enum is TopLeftPoint …
  // BottomRightPoint. Every choice is refused as invalidValue before it
  // reaches the wire, and the field shows the refusal.
  test.failing(
    "PN-212: choosing the Center anchor point writes it (the engine's CenterPoint)",
    async () => {
      covers("panel:paged.anchored");
      const h = await anchored();
      await h.choose(select(h, "position"), "Anchored");
      const center = [...select(h, "anchor-point").options].find(
        (o) => o.textContent === "Center",
      )!;
      const from = h.mark();
      await h.choose(select(h, "anchor-point"), center.value);
      expect(h.mutations(from)).toHaveLength(1);
      expect(await h.get(addr(h.scene.anchored), "anchorPoint")).toEqual({
        type: "text",
        value: "CenterPoint",
      });
    },
  );
});
