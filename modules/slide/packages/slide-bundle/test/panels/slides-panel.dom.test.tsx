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

// The Slides panel (the sorter), RENDERED (happy-dom) against the real
// engine with a deck open: what it lists, and what each of its buttons does
// to the DOCUMENT (never to a mock), each one undo step.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { SLIDES_PANEL_ID } from "../../src/activate";
import { SLIDE_KEY, parseState } from "../../src/slides-model";
import { drive, mount, openDeck, settle, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck();
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

const rows = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-slide]")].map(
    (el) => el.dataset.slide!,
  );

/** The panel, mounted and showing the deck. */
async function shown() {
  const view = mount(d.panel(SLIDES_PANEL_ID));
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-slides-panel="ready"]'),
    ).not.toBeNull(),
  );
  await settle();
  return view;
}

const button = (row: HTMLElement, title: string) =>
  row.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;

describe("the Slides panel", () => {
  it("is in the panel rail once a deck is open, and lists its slides in document order", async () => {
    covers("panel:media.paged.slide.panel.slides");
    expect(d.panel(SLIDES_PANEL_ID).rail).toBe(true);
    const view = await shown();
    expect(rows(view.container)).toEqual(await d.pageIds());
    expect(rows(view.container).length).toBe(d.slides.length);
    // Numbered from 1, the active slide marked.
    const first = view.container.querySelector<HTMLElement>("[data-slide]")!;
    expect(first.textContent).toContain("1");
    expect(first.dataset.active).toBe("true");
  });

  it("a thumbnail takes the canvas to its slide", async () => {
    covers("panel:media.paged.slide.panel.slides");
    const view = await shown();
    const ids = await d.pageIds();
    const third = view.container.querySelector<HTMLElement>(
      `[data-slide="${ids[2]}"]`,
    )!;
    await drive(() => fireEvent.click(button(third, "Go to slide 3")));
    expect(d.wentTo).toEqual([ids[2]!]);
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLElement>(`[data-slide="${ids[2]}"]`)!
          .dataset.active,
      ).toBe("true"),
    );
  });

  it("Duplicate inserts a copy after the slide, one undo step", async () => {
    covers("panel:media.paged.slide.panel.slides");
    const view = await shown();
    const before = await d.pageIds();
    const first = view.container.querySelector<HTMLElement>(
      `[data-slide="${before[0]}"]`,
    )!;
    await drive(() => fireEvent.click(button(first, "Duplicate slide")));
    const after = await d.pageIds();
    expect(after.length).toBe(before.length + 1);
    // The copy sits right after the original; the rest keep their order.
    expect(after[0]).toBe(before[0]);
    expect(after.slice(2)).toEqual(before.slice(1));
    await waitFor(() => expect(rows(view.container)).toEqual(after));
    await drive(() => d.host.document.undo());
    expect(await d.pageIds()).toEqual(before);
    await waitFor(() => expect(rows(view.container)).toEqual(before));
  });

  it("Hide marks the slide hidden in its page label, and the button says Unhide; undo shows it again", async () => {
    covers("panel:media.paged.slide.panel.slides");
    const view = await shown();
    const [id] = await d.pageIds();
    const row = () =>
      view.container.querySelector<HTMLElement>(`[data-slide="${id}"]`)!;
    await drive(() => fireEvent.click(button(row(), "Hide from slideshow")));
    const state = async () => {
      const page = (
        await d.h.host.document.collection<{
          selfId: string;
          pluginMetadata?: { key: string; value: string }[];
        }>("pages")
      ).find((p) => p.selfId === id)!;
      return parseState(page.pluginMetadata ?? []);
    };
    expect((await state()).hidden).toBe(true);
    await waitFor(() =>
      expect(button(row(), "Show in slideshow").textContent).toBe("Unhide"),
    );
    expect(
      button(row(), "Show in slideshow").getAttribute("aria-pressed"),
    ).toBe("true");
    await drive(() => d.host.document.undo());
    expect((await state()).hidden).toBeFalsy();
    expect(SLIDE_KEY).toContain("media.paged.slide");
  });

  it("Delete removes the slide, one undo step", async () => {
    covers("panel:media.paged.slide.panel.slides");
    const view = await shown();
    const before = await d.pageIds();
    const second = view.container.querySelector<HTMLElement>(
      `[data-slide="${before[1]}"]`,
    )!;
    await drive(() => fireEvent.click(button(second, "Delete slide")));
    expect(await d.pageIds()).toEqual(before.filter((p) => p !== before[1]));
    await drive(() => d.host.document.undo());
    expect(await d.pageIds()).toEqual(before);
  });

  it("New slide adds a slide of the chosen layout after the active one, and goes to it", async () => {
    covers("panel:media.paged.slide.panel.slides");
    const view = await shown();
    const before = await d.pageIds();
    const picker = await waitFor(() => {
      const el = view.container.querySelector<HTMLSelectElement>(
        "[data-new-slide] select",
      );
      expect(el).not.toBeNull();
      return el!;
    });
    expect(picker.options.length).toBeGreaterThan(0);
    const newButton = view.container.querySelector<HTMLButtonElement>(
      "[data-new-slide] button",
    )!;
    await drive(() => fireEvent.click(newButton));
    await waitFor(async () =>
      expect((await d.pageIds()).length).toBe(before.length + 1),
    );
    const after = await d.pageIds();
    const added = after.find((p) => !before.includes(p))!;
    // Right after the active (first) slide, and the canvas is taken there.
    expect(after.indexOf(added)).toBe(1);
    await waitFor(() => expect(d.wentTo.at(-1)).toBe(added));
  });
});
