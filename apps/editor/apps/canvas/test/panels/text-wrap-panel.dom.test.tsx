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

// Text Wrap (paged.text-wrap): the wrap mode, offsets, contour type and
// the two switches of the selected frames. "Wrap to" is a seam (no
// PropertyPath on the wire).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { TextWrapPanel } from "../../src/panels/text-wrap-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  addr,
  allDisabled,
  batch,
  bool,
  bounds,
  boundsCell,
  set,
  shown,
  state,
  text,
} from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(TextWrapPanel, { id: "paged.text-wrap", scene: richScene });

const FIELDS = [
  "frameTextWrapMode",
  "frameTextWrapOffsets",
  "frameTextWrapContourType",
  "frameTextWrapContourIncludeInside",
  "textWrapInvert",
];

const wrapTo = (h: H) =>
  h.root.querySelector<HTMLSelectElement>('select[data-seam="true"]')!;

describe("Text Wrap panel: states", () => {
  test("nothing selected: every field disabled", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    for (const path of FIELDS) {
      expect(state(h, path)).toBe("none");
      expect(allDisabled(h.field(path))).toBe(true);
    }
  });

  test("a text frame: the wrap settings read from the model", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    for (const path of FIELDS) expect(state(h, path)).toBe("value");
    expect(boundsCell(h, "frameTextWrapOffsets", "T").value).toBe("0");
  });

  test("a frame wrapped and one not: the mode reads mixed", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    await h.mutate(
      set(addr(h.scene.groupA), "frameTextWrapMode", text("Contour")) as never,
    );
    await h.select([h.scene.rect, h.scene.groupA]);
    expect(state(h, "frameTextWrapMode")).toBe("mixed");
  });

  test("Wrap to is a seam: disabled, and sends nothing", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(wrapTo(h).disabled).toBe(true);
  });
});

describe("Text Wrap panel: every control writes the selected frame", () => {
  for (const value of [
    "BoundingBoxTextWrap",
    "Contour",
    "JumpObjectTextWrap",
    "None",
  ]) {
    test(`Wrap: the ${value} segment writes it and becomes the active one`, async () => {
      covers("panel:paged.text-wrap");
      const h = await mount();
      await h.select([h.scene.rect]);
      const from = h.mark();
      await h.press("frameTextWrapMode", value);
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.rect), "frameTextWrapMode", text(value)),
      ] as never);
      expect(await h.get(addr(h.scene.rect), "frameTextWrapMode")).toEqual(
        text(value),
      );
      expect(shown(h, "frameTextWrapMode")).toBe(value);
    });
  }

  test("Offset: typing into the top side writes all four, the rest kept", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto(boundsCell(h, "frameTextWrapOffsets", "T"), "6");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameTextWrapOffsets", bounds([6, 0, 0, 0])),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameTextWrapOffsets")).toEqual(
      bounds([6, 0, 0, 0]),
    );
  });

  for (const value of ["DetectEdges", "GraphicFrame", "SameAsClipping"]) {
    test(`Contour: choosing ${value} writes it`, async () => {
      covers("panel:paged.text-wrap");
      const h = await mount();
      await h.select([h.scene.rect]);
      const from = h.mark();
      await h.choose("frameTextWrapContourType", value);
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.rect), "frameTextWrapContourType", text(value)),
      ] as never);
      expect(
        await h.get(addr(h.scene.rect), "frameTextWrapContourType"),
      ).toEqual(text(value));
      expect(shown(h, "frameTextWrapContourType")).toBe(value);
    });
  }

  for (const [path, id] of [
    ["frameTextWrapContourIncludeInside", "rect"],
    ["textWrapInvert", "textFrame"],
  ] as const) {
    test(`${path}: the switch flips it`, async () => {
      covers("panel:paged.text-wrap");
      const h = await mount();
      const target = h.scene[id];
      await h.select([target]);
      const sw = h.field(path).querySelector<HTMLElement>('[role="switch"]')!;
      const was = sw.getAttribute("aria-checked") === "true";
      const from = h.mark();
      await h.click(sw);
      expect(h.mutations(from)).toEqual([
        set(addr(target), path, bool(!was)),
      ] as never);
      expect(await h.get(addr(target), path)).toEqual(bool(!was));
      expect(sw.getAttribute("aria-checked")).toBe(String(!was));
    });
  }

  test("two frames: the mode is one batch, one undo restores both", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA]);
    const before = await h.get(addr(h.scene.rect), "frameTextWrapMode");
    const from = h.mark();
    await h.press("frameTextWrapMode", "BoundingBoxTextWrap");
    expect(h.mutations(from)).toEqual([
      batch(
        set(
          addr(h.scene.rect),
          "frameTextWrapMode",
          text("BoundingBoxTextWrap"),
        ),
        set(
          addr(h.scene.groupA),
          "frameTextWrapMode",
          text("BoundingBoxTextWrap"),
        ),
      ),
    ] as never);
    await h.act(() => h.client.undo());
    expect(await h.get(addr(h.scene.rect), "frameTextWrapMode")).toEqual(
      before,
    );
    expect(await h.get(addr(h.scene.groupA), "frameTextWrapMode")).toEqual(
      before,
    );
  });
});

describe("Text Wrap panel: findings", () => {
  // PN-254 (fixed, R1): the engine answered noSuchPath for
  // textWrapInvert on a rectangle (it read it on a text frame only) and
  // the panel showed a single rectangle's Invert as "mixed". A
  // rectangle's wrap inverts as any item's does, so it reads its value.
  test("PN-254: a rectangle's Invert reads its value, not mixed", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(state(h, "textWrapInvert")).not.toBe("mixed");
  });

  // PN-255 (fixed, R1): InDesign wraps text around any page item. The
  // engine wrote an oval's wrap and read none of it (noSuchPath for every
  // frameTextWrap* read), so a selected oval showed the panel as "mixed".
  test("PN-255: an oval can be given a text wrap, as any page item", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    await h.select([h.scene.oval]);
    expect(state(h, "frameTextWrapMode")).toBe("value");
    expect(await h.get(addr(h.scene.oval), "frameTextWrapMode")).toEqual(
      text(""),
    );
  });

  // UX audit F-22 (internal identifiers shown to users): the Contour list
  // carries the schema's raw members "BoundingBox" and "UserModifiedPath"
  // as labels.
  test("PN-256 (UX F-22): every Contour option has a human label", async () => {
    covers("panel:paged.text-wrap");
    const h = await mount();
    await h.select([h.scene.rect]);
    const labels = [
      ...h.field("frameTextWrapContourType").querySelectorAll("option"),
    ].map((o) => o.textContent ?? "");
    expect(labels.filter((l) => /^[A-Z][a-z]+[A-Z]/.test(l))).toEqual([]);
  });
});
