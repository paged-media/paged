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

// The Custom Shows panel (slide ADR 720), RENDERED (happy-dom) against the
// real engine with a deck open: a new show is listed, takes slides in the
// order they are added, is written into the deck's label (one undo step
// each), and is deleted again.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { CustomShows } from "../../src/custom-shows";
import { CUSTOM_SHOWS_PANEL } from "../../src/output/commands";
import { drive, mount, openDeck, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck();
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

describe("the Custom Shows panel", () => {
  it("makes a show, gives it slides in order, and deletes it", async () => {
    covers("panel:media.paged.slide.panel.customShows");
    const ids = await d.pageIds();
    const shows = new CustomShows(d.host);
    const view = mount(d.panel(CUSTOM_SHOWS_PANEL));
    const q = (sel: string) => view.container.querySelector<HTMLElement>(sel);
    await waitFor(() =>
      expect(q('[data-custom-shows="ready"]')).not.toBeNull(),
    );
    expect(view.container.textContent).toContain("No custom shows");

    await drive(() => fireEvent.click(q("[data-custom-show-new]")!));
    await waitFor(async () => expect((await shows.list()).length).toBe(1));
    const [made] = await shows.list();
    await waitFor(() =>
      expect(q(`[data-custom-show="${made!.name}"]`)).not.toBeNull(),
    );

    // Slide 3, then slide 1.
    for (const id of [ids[2]!, ids[0]!]) {
      const add = await waitFor(() => {
        const el = q("[data-custom-show-add]") as HTMLSelectElement | null;
        expect(el).not.toBeNull();
        return el!;
      });
      await drive(() => fireEvent.change(add, { target: { value: id } }));
      await drive(() => fireEvent.click(add.nextElementSibling as HTMLElement));
    }
    await waitFor(async () =>
      expect((await shows.list())[0]!.pages).toEqual([ids[2], ids[0]]),
    );
    await waitFor(() =>
      expect(
        [...view.container.querySelectorAll("[data-custom-show-slide]")].map(
          (e) => e.getAttribute("data-custom-show-slide"),
        ),
      ).toEqual(["3", "1"]),
    );

    await drive(() => fireEvent.click(q("[data-custom-show-delete]")!));
    await waitFor(async () => expect(await shows.list()).toEqual([]));
  });
});
