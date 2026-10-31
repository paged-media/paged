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

// The Animations pane (slide ADR 714), RENDERED (happy-dom) against the
// real engine with PowerPoint's `motion` deck open: the builds slide lists
// its four effects as PowerPoint wrote them; adding an effect to a selected
// shape, changing its start and removing it are each one edit of the
// slide's timing in its page label; the Animation Painter copies a shape's
// effects to the next shape selected.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";

import { ANIMATIONS_PANEL_ID } from "../../src/anim/pane";
import { pageShapes } from "../../src/anim/shapes";
import { parseState } from "../../src/slides-model";
import { drive, mount, openDeck, settle, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck("motion");
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

const timingOf = async (pageId: string) => {
  const pages = await d.host.document.collection<{
    selfId: string;
    pluginMetadata?: { key: string; value: string }[];
  }>("pages");
  return parseState(pages.find((p) => p.selfId === pageId)?.pluginMetadata)
    .timing;
};

const rows = (root: HTMLElement) =>
  [...root.querySelectorAll("[data-animation-row]")].map(
    (r) => r.textContent ?? "",
  );

describe("the Animations pane (slide ADR 714) [plugin-slide.animations]", () => {
  it("lists the builds PowerPoint wrote, in play order, with their clicks", async () => {
    covers("panel:media.paged.slide.panel.animations");
    const pages = await d.pageIds();
    d.setActivePage(pages[4]);
    const view = mount(d.panel(ANIMATIONS_PANEL_ID));
    await waitFor(() => expect(rows(view.container).length).toBe(4), {
      timeout: 10_000,
    });
    const r = rows(view.container);
    expect(r[0]).toContain("Appear");
    expect(r[1]).toContain("Fade");
    expect(r[3]).toContain("Appear");
    // Click 1 starts the first (and the two with and after it), click 2 the
    // last.
    const clicks = [
      ...view.container.querySelectorAll("[data-animation-click]"),
    ].map((c) => c.getAttribute("data-animation-click"));
    expect(clicks).toEqual(["1", "1", "1", "2"]);
  });

  it("adds an effect to the selected shape, changes its start and removes it, each one undo step", async () => {
    const pages = await d.pageIds();
    d.setActivePage(pages[0]);
    const shapes = (await pageShapes(d.host)).get(pages[0])!;
    const title = shapes.shapes[0].items[0].id as ElementId;
    await d.host.selection.set([title]);
    const view = mount(d.panel(ANIMATIONS_PANEL_ID));
    await waitFor(
      () =>
        expect(
          view.container.querySelectorAll("[data-animation-preset]").length,
        ).toBeGreaterThan(40),
      { timeout: 10_000 },
    );
    await settle();
    const fly = view.container.querySelector(
      '[data-animation-preset="entr:2"]',
    ) as HTMLButtonElement;
    expect(fly.textContent).toBe("Fly In");
    await drive(() => fireEvent.click(fly));
    await waitFor(() => expect(rows(view.container).length).toBe(1));
    expect((await timingOf(pages[0]))?.nodes.length).toBe(1);

    await drive(() =>
      fireEvent.click(view.container.querySelector("[data-animation-row]")!),
    );
    const start = view.container.querySelector(
      "[data-animation-start]",
    ) as HTMLSelectElement;
    expect(start.value).toBe("click");
    await drive(() => fireEvent.change(start, { target: { value: "with" } }));
    await waitFor(() =>
      expect(
        (
          view.container.querySelector(
            "[data-animation-start]",
          ) as HTMLSelectElement
        ).value,
      ).toBe("with"),
    );
    await drive(() =>
      fireEvent.click(view.container.querySelector("[data-animation-remove]")!),
    );
    await waitFor(() => expect(rows(view.container).length).toBe(0));
    // No effect left: an empty timing, which export writes as none.
    expect((await timingOf(pages[0]))?.nodes).toEqual([]);
  });

  it("the Animation Painter gives the next shape selected the effects", async () => {
    covers("command:media.paged.slide.command.animationPainter");
    const pages = await d.pageIds();
    d.setActivePage(pages[4]);
    const shapes = (await pageShapes(d.host)).get(pages[4])!;
    const animated = shapes.shapes.find((s) => s.key?.endsWith("#5"))!;
    const plain = shapes.shapes[0];
    await d.host.selection.set([animated.items[0].id]);
    const view = mount(d.panel(ANIMATIONS_PANEL_ID));
    await waitFor(() => expect(rows(view.container).length).toBe(4), {
      timeout: 10_000,
    });
    await drive(() =>
      fireEvent.click(
        view.container.querySelector("[data-animations-painter]")!,
      ),
    );
    await drive(() => d.host.selection.set([plain.items[0].id]));
    await waitFor(() => expect(rows(view.container).length).toBe(5), {
      timeout: 10_000,
    });
  });
});
