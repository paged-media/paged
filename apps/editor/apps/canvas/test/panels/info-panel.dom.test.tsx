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

// Info (paged.info): the cursor, the selection, the colour under the
// cursor and the document meta. Read-only, so its tests are the states
// and the model it follows; it has no controls.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { CANVAS_POINTER } from "@paged-media/shell";
import { setDocumentUnit } from "@paged-media/ui";
import { createBindingProviderRegistry } from "@paged-media/plugin-sdk";

import { InfoPanel } from "../../src/panels/info-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { shapesScene } from "./fixtures";

afterEach(() => {
  unmountAll();
  setDocumentUnit("pt");
});

const mount = (document?: "none" | "blank") =>
  mountPanel(InfoPanel, { id: "paged.info", document });

/** Row label → the value it shows. */
function rows(h: PanelHarness<unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of h.root.querySelectorAll("[data-info-row]")) {
    out[row.getAttribute("data-info-row")!] =
      row.querySelector("[data-info-value]")?.textContent ?? "";
  }
  return out;
}

describe("Info panel", () => {
  test("no document: zero pages and dashes, never a stale document", async () => {
    covers("panel:paged.info");
    const h = await mount("none");
    expect(rows(h)).toEqual({
      "Cursor X": "—",
      "Cursor Y": "—",
      "Cursor page": "—",
      Document: "—",
      Pages: "0",
      "Active page": "—",
      Units: "—",
      "Color mode": "—",
      Dirty: "no",
    });
  });

  test("a blank document: one page, clean", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    expect(rows(h)).toMatchObject({ Pages: "1", Units: "Points", Dirty: "no" });
    expect(h.sent("requestDocumentMeta").length).toBeGreaterThan(0);
  });

  test("follows the model: a page inserted reads two pages", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    expect(rows(h).Pages).toBe("2");
  });

  test("the active page reads as its position, not its IDML id", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    const first = h.handle!.pageIds[0];
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: first, masterId: null },
    } as never);
    const pages = (await h.client.collection("pages")) as Array<{
      selfId: string;
    }>;
    await h.act(() => h.client.setActivePage(pages[1].selfId));
    // The active page is host state: nothing re-reads it until the next
    // model change, which is what the Pages panel's navigation sends.
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: first, masterId: null },
    } as never);
    expect(rows(h)["Active page"]).toBe("Page 3");
  });

  test("an edit reads dirty; a save reads clean until the next edit", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    expect(rows(h).Dirty).toBe("yes");
    await h.act(() => h.client.markSaved());
    expect(rows(h).Dirty).toBe("no");
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    expect(rows(h).Dirty).toBe("yes");
  });

  test("the cursor reads page-relative, in the document's ruler units", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    const pageId = h.handle!.pageIds[0]!;
    await h.act(() =>
      h.scope.get(CANVAS_POINTER).set({
        pageId,
        pagePoint: [72, 144],
        docPoint: [72, 144],
      }),
    );
    expect(rows(h)).toMatchObject({
      "Cursor X": "72 pt",
      "Cursor Y": "144 pt",
      "Cursor page": "Page 1",
    });
    await h.act(() => setDocumentUnit("in"));
    expect(rows(h)).toMatchObject({ "Cursor X": "1 in", "Cursor Y": "2 in" });
    // Off the canvas: dashes, never the last position.
    await h.act(() => h.scope.get(CANVAS_POINTER).set(null));
    expect(rows(h)["Cursor X"]).toBe("—");
  });

  test("the selection reads its X/Y/W/H and angle; several read their box", async () => {
    covers("panel:paged.info");
    const h = await mountPanel(InfoPanel, {
      id: "paged.info",
      scene: shapesScene,
    });
    expect(
      h.root.querySelector('[data-info-note="no-selection"]'),
    ).not.toBeNull();
    // rect: [top, left, bottom, right] = [400, 72, 500, 200]
    await h.select([h.scene.rect]);
    expect(rows(h)).toMatchObject({
      "Selection X": "72 pt",
      "Selection Y": "400 pt",
      "Selection W": "128 pt",
      "Selection H": "100 pt",
      "Selection angle": "0°",
    });
    // + the oval [400, 300, 500, 400]: one box 72..400 × 400..500.
    await h.select([h.scene.rect, h.scene.oval]);
    expect(rows(h)).toMatchObject({
      "Selection X": "72 pt",
      "Selection W": "328 pt",
      "Selection H": "100 pt",
      "Selection items": "2",
    });
    await h.select([h.scene.rect]);
    await h.mutate({
      op: "setElementProperty",
      args: {
        elementId: h.scene.rect,
        path: "frameRotationAngle",
        value: { type: "length", value: 30 },
      },
    } as never);
    await h.select([h.scene.rect]);
    expect(rows(h)["Selection angle"]).toBe("30°");
    expect(rows(h)["Selection W"]).toBe("128 pt");
  });

  test("the colour section says what it cannot read, and never invents CMYK", async () => {
    covers("panel:paged.info");
    const h = await mount("blank");
    expect(h.root.querySelector('[data-info-note="outside"]')).not.toBeNull();
    // The test DOM has no image decoder: the sample is reported
    // unavailable rather than guessed.
    await h.act(() =>
      h.scope.get(CANVAS_POINTER).set({
        pageId: h.handle!.pageIds[0]!,
        pagePoint: [10, 10],
        docPoint: [10, 10],
      }),
    );
    await h.settle();
    expect(
      h.root.querySelector('[data-info-note="unavailable"]'),
    ).not.toBeNull();
    expect(rows(h).CMYK).toBeUndefined();
  });
});

describe("Info panel over an edit context with readouts (extensions ADR 3XX)", () => {
  test("the context's rows lead the panel, and leave with the context", async () => {
    covers("panel:paged.info");
    const registry = createBindingProviderRegistry();
    let value = "200 0 0";
    const handle = registry.register({
      plugin: "test.raster",
      contextType: "rasterImage",
      provider: {
        provides: { readouts: ["info"] },
        readReadouts: () => ({
          kind: "readouts",
          sections: [
            {
              id: "image",
              title: "Image",
              rows: [
                { id: "Image X", label: "X", value: "12 px" },
                { id: "Image RGB", label: "RGB", value, swatch: "#c80000" },
              ],
            },
          ],
        }),
      },
    });
    registry.setContextActive("test.raster", "rasterImage", null, true);
    const h = await mountPanel(InfoPanel, {
      id: "paged.info",
      document: "blank",
      bindingProviders: registry,
    });
    await h.settle();
    const section = h.root.querySelector(
      '[data-info-section="provided:image"]',
    );
    expect(section?.querySelector("h3")?.textContent).toBe("Image");
    expect(rows(h)).toMatchObject({
      "Image X": "12 px",
      "Image RGB": "200 0 0",
    });
    expect(
      section
        ?.querySelector("[data-info-swatch]")
        ?.getAttribute("data-info-swatch"),
    ).toBe("#c80000");
    // The provider's rows move when it invalidates.
    value = "0 0 200";
    await h.act(() => registry.notifyChanged("test.raster", "rasterImage"));
    await h.settle();
    expect(rows(h)["Image RGB"]).toBe("0 0 200");
    // Leaving the context takes the rows away; the host's own stay.
    await h.act(() =>
      registry.setContextActive("test.raster", "rasterImage", null, false),
    );
    await h.settle();
    expect(
      h.root.querySelector('[data-info-section="provided:image"]'),
    ).toBeNull();
    expect(rows(h)["Cursor X"]).toBe("—");
    handle.dispose();
  });
});
