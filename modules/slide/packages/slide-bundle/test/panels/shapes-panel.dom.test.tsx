/*
 * This file is part of paged (https://paged.media).
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

// The Shapes panel (Insert ▸ Shapes, slide ADR 717), RENDERED (happy-dom)
// against the real engine with a deck open: every preset by category, and
// a click puts a live preset on the active slide, selected, one undo step.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";

import { LABEL_KEY } from "../../src/object-model";
import { SHAPES_PANEL_ID } from "../../src/shapes";
import { drive, mount, openDeck, settle, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck("connectors");
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

async function shown() {
  const view = mount(d.panel(SHAPES_PANEL_ID));
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-shape]").length).toBe(187),
  );
  await settle();
  return view;
}

/** The slide labels on the first page of the shapes made in the editor
 *  (shape keys `new:…`): one per element a new preset became. */
const presetsOnFirstPage = async () => {
  const pages = await d.host.document.collection<{ selfId: string }>("pages");
  const found: { id: ElementId; label: string }[] = [];
  const walk = (nodes: readonly SceneTreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      const label = n.pluginMetadata?.find((m) => m.key === LABEL_KEY)?.value;
      if (n.id && label?.includes('"shape":"new:'))
        found.push({ id: n.id, label });
      walk(n.children);
    }
  };
  walk(await d.host.document.tree());
  if (found.length === 0) return [];
  const key = (e: ElementId) => JSON.stringify(e);
  const geometry = await d.host.document.elementGeometry(
    found.map((f) => f.id),
  );
  const page = new Map(geometry.map((g) => [key(g.id), g.pageId]));
  return found
    .filter((f) => page.get(key(f.id)) === pages[0]!.selfId)
    .map((f) => f.label);
};

describe("the Shapes panel", () => {
  it("shows all 187 presets under PowerPoint's categories", async () => {
    covers("panel:media.paged.slide.panel.shapes");
    const view = await shown();
    const cats = [
      ...view.container.querySelectorAll<HTMLElement>("[data-shapes-category]"),
    ].map((s) => s.dataset.shapesCategory);
    expect(cats).toEqual([
      "lines",
      "rectangles",
      "basicShapes",
      "blockArrows",
      "equation",
      "flowchart",
      "starsAndBanners",
      "callouts",
      "actionButtons",
    ]);
    const rr = view.container.querySelector<HTMLElement>(
      '[data-shape="roundRect"]',
    )!;
    expect(
      rr.closest<HTMLElement>("[data-shapes-category]")!.dataset.shapesCategory,
    ).toBe("rectangles");
    expect(rr.querySelector("path")!.getAttribute("d")).toMatch(/^M/);
  });

  it("a click inserts the preset on the active slide as a live preset, one undo step", async () => {
    covers("panel:media.paged.slide.panel.shapes");
    const view = await shown();
    const before = (await presetsOnFirstPage()).length;
    const heart = view.container.querySelector<HTMLButtonElement>(
      '[data-shape="heart"]',
    )!;
    await drive(() => fireEvent.click(heart));
    await waitFor(async () =>
      expect((await presetsOnFirstPage()).length).toBe(before + 1),
    );
    // The preset itself is the engine's (engine ADR 1096); the label keeps
    // only the shape key.
    const labels = await presetsOnFirstPage();
    expect(labels.every((l) => !l.includes('"prst"'))).toBe(true);
    // It is selected.
    expect(d.host.selection.get().length).toBe(1);
    await d.host.document.undo();
    expect((await presetsOnFirstPage()).length).toBe(before);
  });
});
