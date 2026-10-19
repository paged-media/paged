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

// The Notes panel, RENDERED (happy-dom) against the real engine with a deck
// open: it shows the speaker notes of the slide the canvas is on, follows
// the canvas to another slide, and an edit is written when the field loses
// focus, into that slide's page label, as one undo step.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { NOTES_PANEL_ID } from "../../src/activate";
import { parseState } from "../../src/slides-model";
import { drive, mount, openDeck, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck();
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

async function notesOf(pageId: string): Promise<string | undefined> {
  const page = (
    await d.h.host.document.collection<{
      selfId: string;
      pluginMetadata?: { key: string; value: string }[];
    }>("pages")
  ).find((p) => p.selfId === pageId)!;
  return parseState(page.pluginMetadata ?? []).notes;
}

describe("the Notes panel", () => {
  it("shows the notes of the active slide and follows the canvas to another one", async () => {
    covers("panel:media.paged.slide.panel.notes");
    expect(d.panel(NOTES_PANEL_ID).rail).toBe(true);
    const ids = await d.pageIds();
    const view = mount(d.panel(NOTES_PANEL_ID));
    const field = () =>
      view.container.querySelector<HTMLTextAreaElement>("[data-notes-text]");
    await waitFor(() => expect(field()).not.toBeNull());
    expect(field()!.value).toBe((await notesOf(ids[0]!)) ?? "");
    expect(view.container.textContent).toContain("Slide 1");
    await drive(() => d.setActivePage(ids[1]!));
    await waitFor(() =>
      expect(view.container.textContent).toContain("Slide 2"),
    );
    expect(field()!.value).toBe((await notesOf(ids[1]!)) ?? "");
  });

  it("writes an edit on blur into the slide's page label, one undo step", async () => {
    covers("panel:media.paged.slide.panel.notes");
    const [first] = await d.pageIds();
    const before = await notesOf(first!);
    const view = mount(d.panel(NOTES_PANEL_ID));
    const field = await waitFor(() => {
      const el =
        view.container.querySelector<HTMLTextAreaElement>("[data-notes-text]");
      expect(el).not.toBeNull();
      return el!;
    });
    // Typing writes nothing; leaving the field writes once.
    await drive(() =>
      fireEvent.change(field, { target: { value: "Say hello first." } }),
    );
    expect(await notesOf(first!)).toBe(before);
    await drive(() => fireEvent.blur(field));
    expect(await notesOf(first!)).toBe("Say hello first.");
    // Undo puts the old notes back, and the panel shows them.
    await drive(() => d.host.document.undo());
    expect(await notesOf(first!)).toBe(before);
    await waitFor(() => expect(field.value).toBe(before ?? ""));
  });

  it("says so when no slide is active", async () => {
    covers("panel:media.paged.slide.panel.notes");
    await drive(() => d.setActivePage(null));
    const view = mount(d.panel(NOTES_PANEL_ID));
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-notes-panel="empty"]'),
      ).not.toBeNull(),
    );
    expect(view.container.textContent).toContain("No slide selected.");
  });
});
