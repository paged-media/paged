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

// Object / Transform (paged.object-transform): the bespoke X / Y / W / H
// panel with the reference-point grid, opacity and Rotate & scale. X / Y
// are the selection's footprint and move it through the nudge's own
// translation; W / H write the inner box (frameBounds) keeping the chosen
// reference point fixed; the rest are object-model fields. Each control
// is asserted as the exact mutation, the model read back, and the panel
// showing it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { activeStrings } from "@paged-media/strings";
import {
  CatalogRegistryProvider,
  CompositionRenderer,
} from "@paged-media/shell";

import { appCatalogRegistry } from "../../src/panels/catalog-registry";
import { ObjectTransformPanel } from "../../src/panels/object-transform-panel";
import { objectTransformComposition } from "../../src/panels/object-transform.composition";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  addr,
  allDisabled,
  batch,
  bool,
  bounds,
  len,
  set,
  state,
} from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(ObjectTransformPanel, {
    id: "paged.object-transform",
    scene: richScene,
  });

const byLabel = (h: PanelHarness<unknown>, name: string) =>
  h.root.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
const anchor = (h: H) =>
  h.root
    .querySelector("[data-reference-point-anchor]")!
    .getAttribute("data-reference-point-anchor");
const gridCells = (h: H) => [
  ...h.root.querySelectorAll<HTMLButtonElement>(
    '[role="radiogroup"][aria-label="Reference point"] [role="radio"]',
  ),
];
const rotation = (h: H) =>
  h.root.querySelector<HTMLElement>('[data-smart-dial="Rotation"]')!;

/** Type into the rotation dial (click its value, type, Enter). */
async function typeRotation(h: H, value: string) {
  await h.click(rotation(h).querySelector("button")!);
  const input = rotation(h).querySelector("input")!;
  await h.user.clear(input);
  await h.user.type(input, `${value}{Enter}`);
  await h.settle();
}

describe("Object/Transform panel: states", () => {
  test("nothing selected: every control disabled, the values dashed", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    for (const name of [
      "x",
      "y",
      "width",
      "height",
      "opacity",
      "scale x",
      "scale y",
    ]) {
      expect(byLabel(h, name).disabled).toBe(true);
      expect(byLabel(h, name).value).toBe("—");
    }
    expect(gridCells(h).every((c) => c.disabled)).toBe(true);
    expect(allDisabled(h.field("frameFlipH"))).toBe(true);
  });

  test("no document: the same", async () => {
    covers("panel:paged.object-transform");
    const h = await mountPanel(ObjectTransformPanel, {
      id: "paged.object-transform",
      document: "none",
    });
    expect(byLabel(h, "x").disabled).toBe(true);
  });

  test("a rectangle: where it is and how big, from the model", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(byLabel(h, "x").value).toBe("72 pt");
    expect(byLabel(h, "y").value).toBe("400 pt");
    expect(byLabel(h, "width").value).toBe("128 pt");
    expect(byLabel(h, "height").value).toBe("100 pt");
    expect(byLabel(h, "scale x").value).toBe("100 %");
    expect(byLabel(h, "scale y").value).toBe("100 %");
    expect(rotation(h).textContent).toContain("0");
    expect(anchor(h)).toBe("0");
  });

  test("two frames of different sizes: W, H, rotation and scale read mixed", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.oval]);
    expect(state(h, "frameBounds")).toBe("mixed");
    expect(byLabel(h, "width").value).toBe("—");
    expect(byLabel(h, "height").value).toBe("—");
  });

  test("a group: the group's own transform field appears, on the group", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.group]);
    const section = h.root.querySelector("[data-group-transform]");
    expect(section?.getAttribute("data-group-transform")).toBe(
      addr(h.scene.group),
    );
    await h.select([h.scene.rect]);
    expect(h.root.querySelector("[data-group-transform]")).toBeNull();
  });

  test("Rotate & scale folds away and back", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const toggle = h.view.getByRole("button", { name: "Rotate & scale" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await h.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(h.root.querySelector('[data-smart-dial="Rotation"]')).toBeNull();
    await h.click(toggle);
    expect(h.root.querySelector('[data-smart-dial="Rotation"]')).not.toBeNull();
  });

  // Flip V left the seams when it was wired (PN-251).
  test("the seam is disabled and sends nothing: lock aspect", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const lock = h.root.querySelector<HTMLButtonElement>("[data-lock-aspect]")!;
    expect(lock.disabled).toBe(true);
    const from = h.mark();
    await h.click(lock);
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Object/Transform panel: every control writes the selection", () => {
  test("X: typing 100 moves the frame by the difference, and it reads 100", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto(byLabel(h, "x"), "100");
    expect(h.mutations(from)).toHaveLength(1);
    const props = await h.props(h.scene.rect);
    const b = (props.frameBounds as { value: number[] }).value;
    const t = (props.frameTransform as { value: number[] | null }).value;
    // The footprint moved right by 28 pt, whether the engine moved the
    // inner box or the item transform.
    expect(b[1] + (t?.[4] ?? 0)).toBe(100);
    expect(b[0] + (t?.[5] ?? 0)).toBe(400);
    expect(byLabel(h, "x").value).toBe("100 pt");
  });

  test("Y: typing 420 moves the frame down by 20", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto(byLabel(h, "y"), "420");
    expect(h.mutations(from)).toHaveLength(1);
    expect(byLabel(h, "y").value).toBe("420 pt");
    expect(byLabel(h, "x").value).toBe("72 pt");
  });

  test("W: typing 200 grows the inner box from the top-left reference point", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto(byLabel(h, "width"), "200");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameBounds", bounds([400, 72, 500, 272])),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameBounds")).toEqual(
      bounds([400, 72, 500, 272]),
    );
    expect(byLabel(h, "width").value).toBe("200 pt");
  });

  test("H: typing 50 shrinks it from the top", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto(byLabel(h, "height"), "50");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameBounds", bounds([400, 72, 450, 200])),
    ] as never);
    expect(byLabel(h, "height").value).toBe("50 pt");
  });

  test("the reference point: the centre cell keeps the centre fixed when W changes", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const cells = gridCells(h);
    expect(cells).toHaveLength(9);
    await h.click(cells[4]);
    expect(anchor(h)).toBe("4");
    expect(cells[4].getAttribute("aria-checked")).toBe("true");
    // The grid is panel state: choosing a cell sends nothing.
    const from = h.mark();
    await h.typeInto(byLabel(h, "width"), "200");
    // Centre x = 72 + 64 = 136; a 200 pt box around it starts at 36.
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameBounds", bounds([400, 36, 500, 236])),
    ] as never);
  });

  test("the bottom-right cell keeps the bottom edge fixed when H changes", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(gridCells(h)[8]);
    const from = h.mark();
    await h.typeInto(byLabel(h, "height"), "40");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameBounds", bounds([460, 72, 500, 200])),
    ] as never);
  });

  test("Opacity: typing 40 writes frameOpacity", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto(byLabel(h, "opacity"), "40");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameOpacity", len(40)),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameOpacity")).toEqual(len(40));
    expect(byLabel(h, "opacity").value).toBe("40 %");
  });

  test("Rotation: typing 30 into the dial writes frameRotationAngle", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await typeRotation(h, "30");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameRotationAngle", len(30)),
    ] as never);
    const read = (await h.get(addr(h.scene.rect), "frameRotationAngle")) as {
      value: number;
    };
    expect(read.value).toBeCloseTo(30, 4);
    expect(rotation(h).textContent).toContain("+30");
  });

  test("Scale X / Y: typing a percent writes the multiplier", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    let from = h.mark();
    await h.typeInto(byLabel(h, "scale x"), "50");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameScaleX", len(0.5)),
    ] as never);
    from = h.mark();
    await h.typeInto(byLabel(h, "scale y"), "200");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameScaleY", len(2)),
    ] as never);
    const sx = (await h.get(addr(h.scene.rect), "frameScaleX")) as {
      value: number;
    };
    const sy = (await h.get(addr(h.scene.rect), "frameScaleY")) as {
      value: number;
    };
    expect(sx.value).toBeCloseTo(0.5, 6);
    expect(sy.value).toBeCloseTo(2, 6);
    expect(byLabel(h, "scale x").value).toBe("50 %");
    expect(byLabel(h, "scale y").value).toBe("200 %");
  });

  test("Flip H: the button writes frameFlipH and reads on", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    const flip = h.root.querySelector<HTMLButtonElement>("[data-flip-h]")!;
    expect(flip.getAttribute("data-on")).toBe("false");
    const from = h.mark();
    await h.click(flip);
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameFlipH", bool(true)),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameFlipH")).toEqual(bool(true));
    expect(flip.getAttribute("data-on")).toBe("true");
  });

  test("two frames: opacity is one batch over both, and one undo restores both", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA]);
    const before = await h.get(addr(h.scene.rect), "frameOpacity");
    const from = h.mark();
    await h.typeInto(byLabel(h, "opacity"), "30");
    expect(h.mutations(from)).toEqual([
      batch(
        set(addr(h.scene.rect), "frameOpacity", len(30)),
        set(addr(h.scene.groupA), "frameOpacity", len(30)),
      ),
    ] as never);
    await h.act(() => h.client.undo());
    expect(await h.get(addr(h.scene.rect), "frameOpacity")).toEqual(before);
    expect(await h.get(addr(h.scene.groupA), "frameOpacity")).toEqual(before);
  });

  test("a disabled control sends nothing", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    const from = h.mark();
    await h.user.type(byLabel(h, "width"), "300{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Object/Transform panel: findings", () => {
  // frameOpacity reads as an unset length (null) on a frame nobody has
  // made transparent. The panel unwraps null as 0 and shows "0 %"; the
  // Effects panel reads the same frame as the schema default, "100 %".
  test("PN-250: an untouched frame's opacity reads 100 %, as the Effects panel shows it", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(await h.get(addr(h.scene.rect), "frameOpacity")).toEqual(len(null));
    expect(byLabel(h, "opacity").value).toBe("100 %");
  });

  // Flip V was a seam "the editor can set it but cannot read it back",
  // but the engine reads frameFlipV (a bool on every frame, engine ADR
  // 192): the seam outlived its gap. It is wired now.
  test("PN-251: Flip V is live, because the engine reads frameFlipV back", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(await h.get(addr(h.scene.rect), "frameFlipV")).toEqual(bool(false));
    const flip = h.root.querySelector<HTMLButtonElement>("[data-flip-v]")!;
    expect(flip.disabled).toBe(false);
    expect(flip.getAttribute("data-on")).toBe("false");
    const from = h.mark();
    await h.click(flip);
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameFlipV", bool(true)),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameFlipV")).toEqual(bool(true));
    expect(flip.getAttribute("data-on")).toBe("true");
  });

  // UX audit F-38 (fixed): geometry read differently in two places. This
  // panel shows X / Y / W / H; the Object section the Properties panel and
  // the control strip render for the same frame showed Top / Left / Bottom
  // / Right, with no reference point. Both read X / Y / W / H now.
  test("PN-252 (UX F-38): the Object section shows the frame as X / Y / W / H too", async () => {
    covers("panel:paged.object-transform");
    function Both() {
      return (
        <>
          <ObjectTransformPanel />
          <CatalogRegistryProvider registry={appCatalogRegistry()}>
            <div data-object-section="">
              <CompositionRenderer
                composition={objectTransformComposition(activeStrings())}
              />
            </div>
          </CatalogRegistryProvider>
        </>
      );
    }
    const h = await mountPanel(Both, {
      id: "paged.object-transform",
      scene: richScene,
    });
    await h.select([h.scene.rect]);
    const section = h.root.querySelector("[data-object-section]")!;
    expect(byLabel(h, "width").value).toBe("128 pt");
    const width = section.querySelector<HTMLInputElement>(
      'input[aria-label="width"]',
    );
    expect(width).not.toBeNull();
    expect(width!.value).toBe("128 pt");
    expect(section.querySelector('input[aria-label="top"]')).toBeNull();
    expect(
      section.querySelector("[data-reference-point-anchor]"),
    ).not.toBeNull();
  });
});

// Editor ADR 310 — the Shape section: the live-shape parameters of the
// one selected item (engine ADR 1047).
describe("Object/Transform panel: the Shape section", () => {
  const shapeOf = (h: H) => h.root.querySelector("[data-section='Shape']");
  const select = (h: H, name: string) =>
    h.root.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;

  /** A live pentagon, as the Polygon tool inserts it. */
  async function livePentagon(h: H): Promise<{ kind: string; id: string }> {
    const pts = Array.from({ length: 5 }, (_, i) => {
      const t = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const p = [200 + 50 * Math.cos(t), 200 + 50 * Math.sin(t)];
      return { anchor: p, left: p, right: p };
    });
    const reply = await h.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "insertPath",
            args: {
              pageId: h.scene.pageId,
              anchors: pts,
              open: false,
              smooth: false,
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "polygon", id: "$created" },
              path: "frameShapeSides",
              value: len(5),
            },
          },
        ],
      },
    } as never);
    return (reply as { payload: { createdId: { kind: string; id: string } } })
      .payload.createdId;
  }

  test("nothing selected, a group or two items: no Shape section", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    expect(shapeOf(h)).toBeNull();
    await h.select([h.scene.group]);
    expect(shapeOf(h)).toBeNull();
    await h.select([h.scene.rect, h.scene.oval]);
    expect(shapeOf(h)).toBeNull();
  });

  test("an oval: the pie angles read 0 and 360; typing the end cuts a pie, Invert pie swaps them in one step", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.oval]);
    expect(shapeOf(h)?.getAttribute("data-shape-kind")).toBe("oval");
    expect(byLabel(h, "Pie start").value).toBe("0 °");
    expect(byLabel(h, "Pie end").value).toBe("360 °");
    const from = h.mark();
    await h.typeInto(byLabel(h, "Pie end"), "90");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.oval), "frameShapePieEnd", len(90)),
    ] as never);
    expect(await h.get(addr(h.scene.oval), "frameShapePieEnd")).toEqual(
      len(90),
    );
    expect(byLabel(h, "Pie end").value).toBe("90 °");
    const inv = h.mark();
    await h.click(h.root.querySelector("[data-invert-pie]")!);
    expect(h.mutations(inv)).toEqual([
      batch(
        {
          op: "setElementProperty",
          args: {
            elementId: h.scene.oval,
            path: "frameShapePieStart",
            value: len(90),
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId: h.scene.oval,
            path: "frameShapePieEnd",
            value: len(360),
          },
        },
      ),
    ] as never);
    expect(byLabel(h, "Pie start").value).toBe("90 °");
    expect(byLabel(h, "Pie end").value).toBe("360 °");
  });

  test("a live polygon: sides and star inset read and write; a plain path shows no Shape section", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    const poly = await livePentagon(h);
    await h.select([poly as never]);
    expect(shapeOf(h)?.getAttribute("data-shape-kind")).toBe("polygon");
    expect(byLabel(h, "Sides").value).toBe("5");
    const from = h.mark();
    await h.typeInto(byLabel(h, "Sides"), "8");
    expect(h.mutations(from)).toEqual([
      set(addr(poly), "frameShapeSides", len(8)),
    ] as never);
    expect(await h.get(addr(poly), "frameShapeSides")).toEqual(len(8));
    await h.typeInto(byLabel(h, "Star inset"), "30");
    expect(await h.get(addr(poly), "frameShapeStarInset")).toEqual(len(30));
    // A star's sides are its points.
    expect(byLabel(h, "Points").value).toBe("8");
    // An edited path is no live polygon: the section goes away.
    await h.mutate({
      op: "setElementProperty",
      args: { elementId: poly, path: "frameShapeSides", value: len(null) },
    } as never);
    await h.settle();
    expect(shapeOf(h)).toBeNull();
  });

  test("a rectangle: the linked corners take a type and a radius in one batch; unlinked, one corner", async () => {
    covers("panel:paged.object-transform");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(shapeOf(h)?.getAttribute("data-shape-kind")).toBe("rectangle");
    expect(select(h, "Top-left corner").value).toBe("None");
    const from = h.mark();
    await h.choose(select(h, "Top-left corner"), "BeveledCorner");
    const suffixes = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"];
    expect(h.mutations(from)).toEqual([
      batch(
        ...suffixes.map((s) => ({
          op: "setElementProperty",
          args: {
            elementId: h.scene.rect,
            path: `frameCornerOption${s}`,
            value: { type: "text", value: "BeveledCorner" },
          },
        })),
      ),
    ] as never);
    expect(select(h, "Bottom-left corner").value).toBe("BeveledCorner");
    // Unlink, then a radius on one corner.
    await h.click(h.root.querySelector("[data-link-corners]")!);
    const one = h.mark();
    await h.typeInto(byLabel(h, "Bottom-right corner radius"), "20");
    expect(h.mutations(one)).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: h.scene.rect,
          path: "frameCornerRadiusBottomRight",
          value: len(20),
        },
      },
    ] as never);
    expect(
      await h.get(addr(h.scene.rect), "frameCornerRadiusBottomRight"),
    ).toEqual(len(20));
    expect(
      await h.get(addr(h.scene.rect), "frameCornerRadiusTopLeft"),
    ).not.toEqual(len(20));
  });
});
