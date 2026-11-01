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

// The Icons panel (Insert ▸ Icons, slide ADR 723), RENDERED (happy-dom)
// against the real engine with a deck open: the bundled icons, and a click
// places one on the active slide as an SVG picture, selected, one undo step.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { ICONS, ICONS_PANEL_ID } from "../../src/icons";
import { drive, mount, openDeck, settle, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck("connectors");
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

const pictures = async () => {
  const tree = (await d.host.document.tree()) as {
    children?: { children?: { id?: { kind: string } }[] }[];
  }[];
  return (tree[0]?.children?.[0]?.children ?? []).filter(
    (n) => n.id?.kind === "rectangle",
  ).length;
};

describe("the Icons panel", () => {
  it("shows the bundled icons; a click places one as an SVG picture, one undo step", async () => {
    covers("panel:media.paged.slide.panel.icons");
    const view = mount(d.panel(ICONS_PANEL_ID));
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-icon]").length).toBe(
        ICONS.length,
      ),
    );
    await settle();
    expect(
      view.container.querySelector("[data-icons-from-file]"),
    ).not.toBeNull();
    const before = await pictures();
    const star =
      view.container.querySelector<HTMLButtonElement>('[data-icon="Star"]')!;
    await drive(() => fireEvent.click(star));
    await waitFor(async () => expect(await pictures()).toBe(before + 1));
    expect(d.host.selection.get().length).toBe(1);
    await d.host.document.undo();
    expect(await pictures()).toBe(before);
  });
});
