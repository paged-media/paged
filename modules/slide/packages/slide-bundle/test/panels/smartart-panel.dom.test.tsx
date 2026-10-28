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

// The SmartArt text pane (slide W4), RENDERED (happy-dom) against the real
// engine with the PowerPoint-authored `smartart` deck open: it follows the
// selection, lists the diagram's points and writes an edited one.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { SMARTART_PANEL_ID } from "../../src/smartart";
import { mount, openDeck, settle, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck("smartart");
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

const fields = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLTextAreaElement>("[data-smartart-point]")];

describe("the SmartArt text pane", () => {
  it("shows the selected diagram's points and writes an edit", async () => {
    covers("panel:media.paged.slide.panel.smartart");
    const view = mount(d.panel(SMARTART_PANEL_ID));
    await settle();
    expect(view.container.querySelector('[data-smartart-panel="empty"]')).not.toBeNull();
    await d.host.selection.set([{ kind: "group", id: "u7" }]);
    await waitFor(() => expect(fields(view.container).length).toBe(5));
    expect(fields(view.container).map((f) => f.value)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
    ]);
    const gamma = fields(view.container)[2]!;
    fireEvent.change(gamma, { target: { value: "Omega" } });
    fireEvent.keyDown(gamma, { key: "Enter" });
    await waitFor(async () => {
      const stories = await d.host.document.collection<{ selfId: string }>("stories");
      const texts = await Promise.all(
        stories.map(async (s) =>
          (await d.host.document.storyContent(s.selfId))!.paragraphs
            .map((p) => p.runs.map((r) => r.text).join(""))
            .join("\n"),
        ),
      );
      expect(texts).toContain("Omega");
    });
    // Escape puts back what the document holds.
    const beta = fields(view.container)[1]!;
    fireEvent.change(beta, { target: { value: "Zeta" } });
    fireEvent.keyDown(beta, { key: "Escape" });
    expect(beta.value).toBe("Beta");
  }, 60_000);
});
