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

// Export Tagging (paged.export-tagging): a CONCEPT panel. The
// Paragraph / Character scope is live local state that changes the
// suggested tags; every field is a disabled seam and nothing reaches the
// engine.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ExportTaggingPanel } from "../../src/panels/concept/export-tagging-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = () =>
  mountPanel(ExportTaggingPanel, {
    id: "paged.export-tagging",
    scene: richScene,
  });

const scope = (h: PanelHarness<unknown>, name: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-scope="${name}"]`)!;

const seams = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll<HTMLInputElement>("[data-seam]")].filter((el) =>
    el.matches("select, input, button"),
  );

/** The disabled seam selects' shown values, in order. */
const shownValues = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll<HTMLSelectElement>("select[data-seam]")].map(
    (s) => s.selectedOptions[0]?.textContent ?? s.textContent,
  );

describe("Export Tagging", () => {
  test("Paragraph scope: p, bodymatter, P; every field a disabled seam", async () => {
    covers("panel:paged.export-tagging");
    const h = await mount();
    expect(scope(h, "Paragraph").getAttribute("data-active")).toBe("true");
    expect(shownValues(h)).toEqual(["—", "p", "—", "bodymatter", "P"]);
    expect(h.root.querySelector("[data-tagging-preview]")!.textContent).toBe(
      '<p class="…">…</p>',
    );
    for (const el of seams(h)) expect(el.disabled).toBe(true);
  });

  test("Character scope: span, Span", async () => {
    covers("panel:paged.export-tagging");
    const h = await mount();
    await h.click(scope(h, "Character"));
    expect(scope(h, "Character").getAttribute("data-active")).toBe("true");
    expect(shownValues(h)).toEqual(["—", "span", "—", "—", "Span"]);
    expect(h.root.querySelector("[data-tagging-preview]")!.textContent).toBe(
      '<span class="…">…</span>',
    );
  });

  test("nothing reaches the engine", async () => {
    covers("panel:paged.export-tagging");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.click(scope(h, "Character"));
    await h.click(scope(h, "Paragraph"));
    for (const el of seams(h)) await h.click(el);
    expect(h.mutations(from)).toEqual([]);
  });

  // The scope pair is a two-way toggle whose state lives only in colour
  // and a data attribute; assistive technology cannot tell which is on.
  test.failing(
    "PN-213: the scope segments say which one is on (aria-pressed)",
    async () => {
      covers("panel:paged.export-tagging");
      const h = await mount();
      expect(scope(h, "Paragraph").getAttribute("aria-pressed")).toBe("true");
      expect(scope(h, "Character").getAttribute("aria-pressed")).toBe("false");
    },
  );
});
