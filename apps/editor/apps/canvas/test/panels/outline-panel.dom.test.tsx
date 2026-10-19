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

// Outline (paged.outline): the document's heading anchors (from the
// resolver's table, which the shell's chrome puts into the document
// context: `routeShellEvents` stands in for it) and TOC entries; a click
// jumps the camera to the heading's page.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { OutlinePanel } from "../../src/panels/outline-panel";
import { fitCamera, layoutPages } from "../../src/ui/layout";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  cameraLandsOn,
  routeShellEvents,
  structureIdml,
  STRUCTURE,
  withViewport,
} from "./support/structure";

afterEach(unmountAll);

/** Mount, route the resolver, and make it run (any applied edit does). */
async function mount(bytes: Uint8Array): Promise<PanelHarness<undefined>> {
  const h = await mountPanel(OutlinePanel, {
    id: "paged.outline",
    document: bytes,
  });
  routeShellEvents(h);
  await h.mutate({
    op: "insertText",
    args: { storyId: STRUCTURE.story, offset: 0, text: "" },
  } as never);
  return h;
}

const entries = (root: Element) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].map((b) => ({
    text: b.querySelector("span")?.textContent ?? "",
    title: b.title,
    indent: b.style.paddingLeft,
  }));

describe("Outline panel: states", () => {
  test("no document: says it is unavailable", async () => {
    covers("panel:paged.outline");
    const h = await mountPanel(OutlinePanel, {
      id: "paged.outline",
      document: "none",
    });
    expect(h.root.textContent).toBe(
      "Outline unavailable. Load a document with heading anchors to populate.",
    );
  });

  test("a document without headings: none detected", async () => {
    covers("panel:paged.outline");
    const h = await mount(structureIdml());
    expect(h.root.textContent).toContain(
      "No heading anchors or TOC entries detected.",
    );
  });

  test("headings: one row each with its page, level 2 indented under level 1", async () => {
    covers("panel:paged.outline");
    const h = await mount(structureIdml({ headings: true }));
    expect(entries(h.root)).toEqual([
      { text: "Chapter One", title: "Chapter One (page 1)", indent: "8px" },
      { text: "Section A", title: "Section A (page 1)", indent: "22px" },
    ]);
    expect(h.root.querySelector("header")?.textContent).toBe("Outline2");
  });

  test("follows the model: a heading's text edited is the row's text", async () => {
    covers("panel:paged.outline");
    const h = await mount(structureIdml({ headings: true }));
    await h.mutate({
      op: "insertText",
      args: { storyId: STRUCTURE.story, offset: 0, text: "First " },
    } as never);
    expect(entries(h.root)[0].text).toBe("First Chapter One");
  });
});

describe("Outline panel: controls", () => {
  test("a click on a heading jumps the camera to its page", async () => {
    covers("panel:paged.outline");
    const h = await mount(structureIdml({ headings: true }));
    await withViewport(h, [800, 600]);
    const from = h.mark();
    await h.click(h.root.querySelectorAll("button")[0]);
    await cameraLandsOn(
      h,
      fitCamera(800, 600, layoutPages(h.handle!.pageSizesPt)[0]),
    );
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Outline panel: findings", () => {
  // Entries are sorted by page, then by LEVEL: every level-1 heading on a
  // page comes before every level-2 one, so a page with two chapters
  // reads Alpha, Beta, Alpha one, Beta one.
  test.failing("PN-109: headings on one page keep document order", async () => {
    covers("panel:paged.outline");
    const h = await mount(
      structureIdml({
        outline: [
          [1, "Alpha"],
          [2, "Alpha one"],
          [1, "Beta"],
          [2, "Beta one"],
        ],
      }),
    );
    expect(entries(h.root).map((e) => e.text)).toEqual([
      "Alpha",
      "Alpha one",
      "Beta",
      "Beta one",
    ]);
  });
});
