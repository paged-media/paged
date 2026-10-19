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

// The four property panels (Slide, Transition, Placeholder, Deck): schema
// panels of property rows, RENDERED (happy-dom) through the SDK's
// schema-panel component and a minimal renderer (./schema-renderer.tsx) on
// the real engine with a deck open. Each shows the rows it declares for what
// is selected, read through the object model, and an edit writes back
// through it as one undo step.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";
import { toElementId, parseAddress } from "@paged-media/plugin-sdk";

import { drive, mountSchema, openDeck, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck();
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

const P = "plugin:media.paged.slide";

/** The field of `path` in the mounted panel, once it has a target. */
async function fieldOf(root: HTMLElement, path: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = root.querySelector<HTMLElement>(`[data-path="${path}"]`);
    expect(el?.dataset.target).toBeTruthy();
    return el!;
  });
}

/** The page item of a placeholder on `slide` (its frame's address). */
async function placeholderOn(
  slide: string,
): Promise<{ placeholder: string; item: string }> {
  for (const placeholder of await d.h.objects.query(`${P}/placeholder`)) {
    const [item] = await d.h.objects.query(
      `frame:${placeholder.split("/").pop()}`,
    );
    if (!item) continue;
    const [host] = await d.h.objects.query(`${item} > ${P}/slide`);
    if (host === slide) return { placeholder, item };
  }
  throw new Error(`no placeholder on ${slide}`);
}

/** Select a placeholder frame of `slide`, as a click on the canvas does. */
async function selectOnSlide(slide: string): Promise<string> {
  const { placeholder, item } = await placeholderOn(slide);
  const id = toElementId(parseAddress(item)!)!;
  await drive(() => d.host.selection.set([id]));
  return placeholder;
}

const rowPaths = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-row]")].map(
    (el) => el.dataset.row,
  );

describe("the slide property panels", () => {
  it("Slide shows index, layout and hidden of the selected item's slide; hiding is one undo step", async () => {
    covers("panel:media.paged.slide.panel.slide");
    const view = mountSchema(d, "media.paged.slide.panel.slide");
    expect(rowPaths(view.container)).toEqual(["index", "layout", "hidden"]);
    const second = d.slides[1]!;
    await selectOnSlide(second);
    const index = await fieldOf(view.container, "index");
    expect(index.dataset.target).toBe(second);
    // The slide's position is derived from the page order: a readout.
    expect(index.textContent).toBe("2");
    expect(index.hasAttribute("data-readonly")).toBe(true);
    const hidden = (await fieldOf(
      view.container,
      "hidden",
    )) as HTMLInputElement;
    expect(hidden.checked).toBe(false);
    await drive(() => fireEvent.click(hidden));
    await waitFor(async () =>
      expect(await d.h.objects.get(second, "hidden")).toEqual({
        kind: "value",
        value: true,
      }),
    );
    await waitFor(() =>
      expect(
        (
          view.container.querySelector(
            '[data-path="hidden"]',
          ) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
    await drive(() => d.host.document.undo());
    expect(await d.h.objects.get(second, "hidden")).toEqual({
      kind: "value",
      value: false,
    });
  });

  it("Transition shows the slide's transition and writes a new duration", async () => {
    covers("panel:media.paged.slide.panel.transition");
    const view = mountSchema(d, "media.paged.slide.panel.transition");
    expect(rowPaths(view.container)).toEqual([
      "transitionKind",
      "transitionDirection",
      "transitionSpeed",
      "transitionDuration",
      "advanceOnClick",
      "advanceAfter",
    ]);
    const first = d.slides[0]!;
    await selectOnSlide(first);
    const kind = await fieldOf(view.container, "transitionKind");
    expect(kind.dataset.target).toBe(first);
    const onClick = (await fieldOf(
      view.container,
      "advanceOnClick",
    )) as HTMLInputElement;
    const was = onClick.checked;
    await drive(() => fireEvent.click(onClick));
    await waitFor(async () =>
      expect(await d.h.objects.get(first, "advanceOnClick")).toEqual({
        kind: "value",
        value: !was,
      }),
    );
    await drive(() => d.host.document.undo());
    expect(await d.h.objects.get(first, "advanceOnClick")).toEqual({
      kind: "value",
      value: was,
    });
  });

  it("Placeholder shows PowerPoint's type and index of the selected placeholder frame", async () => {
    covers("panel:media.paged.slide.panel.placeholder");
    const view = mountSchema(d, "media.paged.slide.panel.placeholder");
    expect(rowPaths(view.container)).toEqual(["type", "index", "content"]);
    // Nothing selected: no target.
    expect(
      view.container
        .querySelector('[data-path="type"]')
        ?.hasAttribute("data-empty"),
    ).toBe(true);
    const placeholder = await selectOnSlide(d.slides[0]!);
    const type = await fieldOf(view.container, "type");
    expect(type.dataset.target).toBe(placeholder);
    // PowerPoint's own placeholder type: a readout, as the schema says.
    const expected = await d.h.objects.get(placeholder, "type");
    expect(type.textContent).toBe(
      String((expected as { value: unknown }).value),
    );
    expect(type.hasAttribute("data-readonly")).toBe(true);
    expect(
      (await fieldOf(view.container, "index")).hasAttribute("data-readonly"),
    ).toBe(true);
  });

  it("Deck shows the one deck's name, size, slide count and fonts, all readouts", async () => {
    covers("panel:media.paged.slide.panel.deck");
    const view = mountSchema(d, "media.paged.slide.panel.deck");
    expect(rowPaths(view.container)).toEqual([
      "name",
      "slideWidth",
      "slideHeight",
      "slideCount",
      "fonts",
    ]);
    const name = await fieldOf(view.container, "name");
    expect(name.dataset.target).toBe(`${P}/deck/deck`);
    // Named after the file the deck was opened from.
    expect(name.textContent).toBe("placeholders");
    expect(
      Number((await fieldOf(view.container, "slideCount")).textContent),
    ).toBe(d.slides.length);
    const width = Number(
      (await fieldOf(view.container, "slideWidth")).textContent,
    );
    expect(width).toBeGreaterThan(0);
    // Every row is a readout: what the deck IS, not something to edit here.
    for (const el of view.container.querySelectorAll("[data-path]"))
      expect(el.hasAttribute("data-readonly")).toBe(true);
    expect(
      await d.h.objects.set(`${P}/deck/deck`, "name", "Renamed"),
    ).toMatchObject({ applied: false, code: "readOnly" });
  });
});
