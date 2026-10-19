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

// Pages (paged.pages, the navigator): one tile per page (the thumbnail
// once the page has one), a click jumps the camera to the page, and Add
// page appends one. The page grid follows the document handle, which
// the shell's chrome rebuilds after a page-structure change
// (`routeShellEvents` stands in for it here).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { NavigatorPanel } from "../../src/panels/navigator-panel";
import { fitCamera, layoutPages } from "../../src/ui/layout";
import { mountPanel, unmountAll } from "./harness";
import {
  cameraLandsOn,
  routeShellEvents,
  structureIdml,
  STRUCTURE,
  withViewport,
} from "./support/structure";

afterEach(unmountAll);

const mount = async (
  document: "none" | "blank" | Uint8Array = structureIdml(),
) => {
  const h = await mountPanel(NavigatorPanel, { id: "paged.pages", document });
  routeShellEvents(h);
  return h;
};

const tiles = (root: Element) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
    b.title.startsWith("Jump to page"),
  );
const addPage = (root: Element) =>
  root.querySelector<HTMLButtonElement>('[aria-label="Add page"]')!;

describe("Pages panel (navigator): states", () => {
  test("no document: says so, offers nothing", async () => {
    covers("panel:paged.pages");
    const h = await mount("none");
    expect(h.root.textContent).toBe("No document loaded.");
    expect(h.root.querySelectorAll("button")).toHaveLength(0);
  });

  test("a document: one tile per page, named and numbered, no thumbnail yet", async () => {
    covers("panel:paged.pages");
    const h = await mount();
    expect(tiles(h.root).map((t) => t.title)).toEqual([
      `Jump to page 1 (${STRUCTURE.page1})`,
      `Jump to page 2 (${STRUCTURE.page2})`,
    ]);
    expect(h.root.textContent).toContain("0/2");
    expect(addPage(h.root).disabled).toBe(false);
  });
});

describe("Pages panel (navigator): controls", () => {
  test("Add page appends after the last page, and the grid follows", async () => {
    covers("panel:paged.pages");
    const h = await mount();
    const from = h.mark();
    await h.click(addPage(h.root));
    expect(h.mutations(from)).toEqual([
      {
        op: "insertPage",
        args: { afterPageId: STRUCTURE.page2, masterId: null },
      },
    ] as never);
    const pages = (await h.client.collection("pages")) as Array<{
      selfId: string;
    }>;
    expect(pages).toHaveLength(3);
    expect(tiles(h.root)).toHaveLength(3);
    expect(tiles(h.root)[2].title).toBe(`Jump to page 3 (${pages[2].selfId})`);
  });

  test("a tile click moves the camera onto that page", async () => {
    covers("panel:paged.pages");
    const h = await mount();
    await withViewport(h, [800, 600]);
    const from = h.mark();
    await h.click(tiles(h.root)[1]);
    const rect = layoutPages(h.handle!.pageSizesPt)[1];
    await cameraLandsOn(h, fitCamera(800, 600, rect));
    // Navigation is the camera's business: nothing is sent.
    expect(h.mutations(from)).toEqual([]);
  });

  test("before the canvas has a size, a tile click leaves the camera alone", async () => {
    covers("panel:paged.pages");
    const h = await mount();
    const before = h.paged.camera.camera;
    await h.click(tiles(h.root)[1]);
    expect(h.paged.camera.camera).toEqual(before);
  });
});
