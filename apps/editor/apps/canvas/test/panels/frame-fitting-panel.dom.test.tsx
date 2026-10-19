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

// Frame Fitting (paged.frame-fitting): how a placed image sits in its
// frame (Fit segments, the 9-point Align content grid, Crop, Auto-fit,
// and the Fill frame proportionally action). The scene places an image
// in the rectangle (a link to a file that is not there; nothing renders).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { FrameFittingPanel } from "../../src/panels/frame-fitting-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  addr,
  allDisabled,
  batch,
  bool,
  bounds,
  boundsCell,
  imageScene,
  set,
  shown,
  state,
  text,
  type ImageScene,
} from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<ImageScene>;

const mount = () =>
  mountPanel(FrameFittingPanel, {
    id: "paged.frame-fitting",
    scene: imageScene,
  });

const FIELDS = [
  "frameFittingType",
  "frameFittingReferencePoint",
  "frameFittingCrops",
  "frameAutoFit",
];

const cells = (h: H) => [
  ...h
    .field("frameFittingReferencePoint")
    .querySelectorAll<HTMLButtonElement>('[role="radio"]'),
];
const fillButton = (h: H) =>
  h.root.querySelector<HTMLButtonElement>("[data-fill-proportionally]")!;

// IDML's AnchorPoint names, which FittingAlignment takes (engine ADR 196).
const ANCHORS = [
  "TopLeftAnchor",
  "TopCenterAnchor",
  "TopRightAnchor",
  "LeftCenterAnchor",
  "CenterAnchor",
  "RightCenterAnchor",
  "BottomLeftAnchor",
  "BottomCenterAnchor",
  "BottomRightAnchor",
];

describe("Frame Fitting panel: states", () => {
  test("nothing selected: every control disabled", async () => {
    covers("panel:paged.frame-fitting");
    const h = await mount();
    for (const path of FIELDS) {
      expect(state(h, path)).toBe("none");
      expect(allDisabled(h.field(path))).toBe(true);
    }
    expect(fillButton(h).disabled).toBe(true);
  });

  test("an image frame: fitting read from the model", async () => {
    covers("panel:paged.frame-fitting");
    const h = await mount();
    await h.select([h.scene.imageFrame]);
    for (const path of FIELDS) expect(state(h, path)).toBe("value");
    expect(boundsCell(h, "frameFittingCrops", "T").value).toBe("0");
    expect(shown(h, "frameAutoFit")).toBe("false");
    expect(cells(h)).toHaveLength(9);
    expect(fillButton(h).getAttribute("aria-pressed")).toBe("false");
  });

  test("two frames that disagree: the fit reads mixed", async () => {
    covers("panel:paged.frame-fitting");
    const h = await mount();
    await h.mutate(
      set(
        addr(h.scene.groupA),
        "frameFittingType",
        text("Proportionally"),
      ) as never,
    );
    await h.select([h.scene.imageFrame, h.scene.groupA]);
    expect(state(h, "frameFittingType")).toBe("mixed");
  });
});

describe("Frame Fitting panel: every control writes the frame", () => {
  for (const value of ["FillProportionally", "Proportionally", "None"]) {
    test(`Fit: the ${value} segment writes it`, async () => {
      covers("panel:paged.frame-fitting");
      const h = await mount();
      await h.select([h.scene.imageFrame]);
      const from = h.mark();
      await h.press("frameFittingType", value);
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.imageFrame), "frameFittingType", text(value)),
      ] as never);
      expect(await h.get(addr(h.scene.imageFrame), "frameFittingType")).toEqual(
        text(value),
      );
      expect(shown(h, "frameFittingType")).toBe(value);
    });
  }

  for (const index of [4, 8]) {
    test(`Align content: cell ${index} writes ${ANCHORS[index]} and reads checked`, async () => {
      covers("panel:paged.frame-fitting");
      const h = await mount();
      await h.select([h.scene.imageFrame]);
      const from = h.mark();
      await h.click(cells(h)[index]);
      expect(h.mutations(from)).toEqual([
        set(
          addr(h.scene.imageFrame),
          "frameFittingReferencePoint",
          text(ANCHORS[index]),
        ),
      ] as never);
      expect(
        await h.get(addr(h.scene.imageFrame), "frameFittingReferencePoint"),
      ).toEqual(text(ANCHORS[index]));
      expect(cells(h)[index].getAttribute("aria-checked")).toBe("true");
    });
  }

  test("Crop: typing into the right side writes all four", async () => {
    covers("panel:paged.frame-fitting");
    const h = await mount();
    await h.select([h.scene.imageFrame]);
    const from = h.mark();
    await h.typeInto(boundsCell(h, "frameFittingCrops", "R"), "12");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.imageFrame), "frameFittingCrops", bounds([0, 0, 0, 12])),
    ] as never);
    expect(await h.get(addr(h.scene.imageFrame), "frameFittingCrops")).toEqual(
      bounds([0, 0, 0, 12]),
    );
  });

  test("Auto-fit: the switch flips it", async () => {
    covers("panel:paged.frame-fitting");
    const h = await mount();
    await h.select([h.scene.imageFrame]);
    const sw = h
      .field("frameAutoFit")
      .querySelector<HTMLElement>('[role="switch"]')!;
    const from = h.mark();
    await h.click(sw);
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.imageFrame), "frameAutoFit", bool(true)),
    ] as never);
    expect(await h.get(addr(h.scene.imageFrame), "frameAutoFit")).toEqual(
      bool(true),
    );
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  test("Fill frame proportionally: writes the fitting type and reads pressed", async () => {
    covers("panel:paged.frame-fitting");
    const h = await mount();
    await h.select([h.scene.imageFrame]);
    const from = h.mark();
    await h.click(fillButton(h));
    expect(h.mutations(from)).toEqual([
      set(
        addr(h.scene.imageFrame),
        "frameFittingType",
        text("FillProportionally"),
      ),
    ] as never);
    expect(fillButton(h).getAttribute("aria-pressed")).toBe("true");
    expect(shown(h, "frameFittingType")).toBe("FillProportionally");
  });

  test("two frames: one batch, one undo restores both", async () => {
    covers("panel:paged.frame-fitting");
    const h = await mount();
    await h.select([h.scene.imageFrame, h.scene.groupA]);
    const before = await h.get(addr(h.scene.imageFrame), "frameFittingType");
    const from = h.mark();
    await h.press("frameFittingType", "Proportionally");
    expect(h.mutations(from)).toEqual([
      batch(
        set(
          addr(h.scene.imageFrame),
          "frameFittingType",
          text("Proportionally"),
        ),
        set(addr(h.scene.groupA), "frameFittingType", text("Proportionally")),
      ),
    ] as never);
    await h.act(() => h.client.undo());
    expect(await h.get(addr(h.scene.imageFrame), "frameFittingType")).toEqual(
      before,
    );
    expect(await h.get(addr(h.scene.groupA), "frameFittingType")).toEqual(
      before,
    );
  });
});

describe("Frame Fitting panel: findings", () => {
  // A text frame holds no graphic: the engine answers noSuchPath for
  // every fitting path. The panel shows them as "mixed" for the one frame
  // and keeps them live, so Fill frame proportionally sends a write the
  // engine refuses.
  test("PN-257: on a text frame the fitting controls read as not applicable and send nothing", async () => {
    covers("panel:paged.frame-fitting");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    expect(state(h, "frameFittingType")).not.toBe("mixed");
    const from = h.mark();
    await h.click(fillButton(h));
    expect(h.mutations(from)).toEqual([]);
  });
});
