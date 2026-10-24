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

// Navigator (paged.navigator, the zoom proxy): the page the view is on,
// the red view rectangle where the view is, a drag on the thumbnail pans,
// and the slider / field / buttons zoom about the view's centre. The
// camera is the shell's (`h.paged.camera`), so what the panel writes is
// what the canvas would draw.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  centreOn,
  NAVIGATOR_THUMB_PX,
  pageInView,
  viewRectOnPage,
  ZoomNavigatorPanel,
} from "../../src/panels/zoom-navigator-panel";
import { fitCamera, layoutPages } from "../../src/ui/layout";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  routeShellEvents,
  structureIdml,
  STRUCTURE,
  withViewport,
} from "./support/structure";

afterEach(unmountAll);

const VIEW: [number, number] = [800, 600];

const mount = async (
  document: "none" | "blank" | Uint8Array = structureIdml(),
) => {
  const h = await mountPanel(ZoomNavigatorPanel, {
    id: "paged.navigator",
    document,
  });
  routeShellEvents(h);
  return h;
};

/** Fit page `i` in the 800 × 600 view, as the canvas opens it. */
async function fitPage(h: PanelHarness<unknown>, i: number) {
  await withViewport(h, VIEW);
  const rects = layoutPages(h.handle!.pageSizesPt);
  await h.act(() =>
    h.paged.camera.setCamera(fitCamera(VIEW[0], VIEW[1], rects[i]!)),
  );
  return rects;
}

const q = (h: PanelHarness<unknown>, sel: string) =>
  h.root.querySelector<HTMLElement>(sel)!;

describe("Navigator: the geometry", () => {
  test("the page in view is the one under the centre, else the nearest", () => {
    const rects = layoutPages([
      [612, 792],
      [612, 792],
    ]);
    const cam = fitCamera(800, 600, rects[1]!);
    expect(pageInView(rects, cam, [800, 600])).toBe(1);
    // Centre far to the right of both: the nearest is still found.
    expect(pageInView(rects, { scale: 1, tx: -5000, ty: 0 }, [800, 600])).toBe(
      0,
    );
    expect(pageInView([], cam, [800, 600])).toBe(-1);
  });

  test("the view rectangle and centring are each other's inverse", () => {
    const page = { x: 0, y: 816, w: 612, h: 792 };
    const cam = centreOn(
      page,
      [306, 396],
      { scale: 2, tx: 0, ty: 0 },
      [800, 600],
    );
    const v = viewRectOnPage(page, cam, [800, 600]);
    expect(v.w).toBe(400);
    expect(v.h).toBe(300);
    expect(v.x + v.w / 2).toBeCloseTo(306);
    expect(v.y + v.h / 2).toBeCloseTo(396);
  });
});

describe("Navigator: the panel", () => {
  test("no document: says so", async () => {
    covers("panel:paged.navigator");
    const h = await mount("none");
    expect(h.root.textContent).toBe("No document loaded.");
  });

  test("shows the page in view and where the view is on it", async () => {
    covers("panel:paged.navigator");
    const h = await mount();
    await fitPage(h, 1);
    const nav = q(h, "[data-navigator]");
    expect(nav.dataset.navigatorPage).toBe(STRUCTURE.page2);
    const view = q(h, "[data-navigator-view]");
    const thumb = q(h, "[data-navigator-thumb]");
    // A fitted page sits inside the view: the rectangle encloses the
    // thumbnail (it starts left of and above it).
    expect(parseFloat(view.style.left)).toBeLessThan(0);
    expect(parseFloat(view.style.top)).toBeLessThan(0);
    expect(parseFloat(thumb.style.width)).toBe(NAVIGATOR_THUMB_PX);
    expect(q(h, "[data-navigator-percent]").getAttribute("value")).toBe(
      `${Math.round(h.paged.camera.camera.scale * 100)}%`,
    );
  });

  test("a press and drag on the thumbnail pans the view to the pointer", async () => {
    covers("panel:paged.navigator");
    const h = await mount();
    const rects = await fitPage(h, 0);
    const before = h.paged.camera.camera;
    const thumb = q(h, "[data-navigator-thumb]");
    const k = NAVIGATOR_THUMB_PX / rects[0]!.w;
    // The test DOM lays nothing out: the thumbnail's box is at 0, 0.
    await h.act(() =>
      fireEvent.pointerDown(thumb, { pointerId: 1, clientX: 50, clientY: 40 }),
    );
    const centre = (c: typeof before) => [
      (VIEW[0] / 2 - c.tx) / c.scale,
      (VIEW[1] / 2 - c.ty) / c.scale,
    ];
    let c = centre(h.paged.camera.camera);
    expect(c[0]).toBeCloseTo(50 / k);
    expect(c[1]).toBeCloseTo(40 / k);
    await h.act(() =>
      fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 120, clientY: 90 }),
    );
    c = centre(h.paged.camera.camera);
    expect(c[0]).toBeCloseTo(120 / k);
    expect(c[1]).toBeCloseTo(90 / k);
    await h.act(() => fireEvent.pointerUp(thumb, { pointerId: 1 }));
    // A move after the release no longer pans; the zoom never changed.
    await h.act(() =>
      fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 10, clientY: 10 }),
    );
    expect(centre(h.paged.camera.camera)[0]).toBeCloseTo(120 / k);
    expect(h.paged.camera.camera.scale).toBe(before.scale);
  });

  test("zoom in / out step ×1.5 about the view's centre; the field sets a percent", async () => {
    covers("panel:paged.navigator");
    const h = await mount();
    await fitPage(h, 0);
    const s0 = h.paged.camera.camera.scale;
    const centre = () => {
      const c = h.paged.camera.camera;
      return [(VIEW[0] / 2 - c.tx) / c.scale, (VIEW[1] / 2 - c.ty) / c.scale];
    };
    const c0 = centre();
    await h.click(q(h, '[data-navigator-zoom="in"]'));
    expect(h.paged.camera.camera.scale).toBeCloseTo(s0 * 1.5);
    expect(centre()[0]).toBeCloseTo(c0[0]!);
    await h.click(q(h, '[data-navigator-zoom="out"]'));
    expect(h.paged.camera.camera.scale).toBeCloseTo(s0);
    await h.typeInto(q(h, "[data-navigator-percent]"), "200");
    expect(h.paged.camera.camera.scale).toBeCloseTo(2);
    expect(centre()[1]).toBeCloseTo(c0[1]!);
  });

  test("the slider zooms on a log scale inside the zoom range", async () => {
    covers("panel:paged.navigator");
    const h = await mount();
    await fitPage(h, 0);
    const slider = q(h, "[data-navigator-slider]") as HTMLInputElement;
    await h.act(() => fireEvent.change(slider, { target: { value: "1000" } }));
    expect(h.paged.camera.camera.scale).toBeCloseTo(40);
    await h.act(() => fireEvent.change(slider, { target: { value: "0" } }));
    expect(h.paged.camera.camera.scale).toBeCloseTo(0.05);
    await h.act(() => fireEvent.change(slider, { target: { value: "500" } }));
    expect(h.paged.camera.camera.scale).toBeCloseTo(Math.sqrt(0.05 * 40));
  });
});
