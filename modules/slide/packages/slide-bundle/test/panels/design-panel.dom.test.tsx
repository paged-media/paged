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

// The Design panel (slide ADRs 713, 719), RENDERED (happy-dom) against the
// real engine with the PowerPoint-authored `placeholders` deck open: the
// gallery, a theme and a variant applied (one undo step each), and a lost
// theme swatch counted and remapped.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { MutationInput } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { DESIGN_PANEL_ID } from "../../src/design";
import { mount, openDeck, settle, type DeckHarness } from "./harness";

let d: DeckHarness;

beforeEach(async () => {
  d = await openDeck("placeholders");
}, 60_000);

afterEach(() => {
  cleanup();
  d.dispose();
});

const current = (c: HTMLElement) =>
  c.querySelector("[data-design-current]")?.textContent ?? "";

async function swatch(id: string): Promise<string> {
  const [s] = await d.host.document.swatchDisplay([id]);
  return s!.rgbHex.toLowerCase();
}

describe("the Design panel", () => {
  it("applies a theme and a variant from the gallery, each one undo step", async () => {
    covers("panel:media.paged.slide.panel.design");
    const view = mount(d.panel(DESIGN_PANEL_ID));
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-design-panel="ready"]'),
      ).not.toBeNull(),
    );
    const cards = () => [
      ...view.container.querySelectorAll<HTMLButtonElement>(
        "[data-design-theme]",
      ),
    ];
    await waitFor(() => expect(cards().length).toBeGreaterThanOrEqual(7));
    expect(cards()[0]!.dataset.designTheme).toBe("deck");
    expect(cards()[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(current(view.container)).toContain("Office");
    expect(await swatch("Color/accent1")).toBe("#156082");

    fireEvent.click(
      view.container.querySelector('[data-design-theme="paper"]')!,
    );
    await waitFor(() => expect(current(view.container)).toContain("Paper"));
    expect(await swatch("Color/accent1")).toBe("#b5523b");
    // The variants of the theme shown; Dark swaps the light and dark slots.
    fireEvent.click(view.container.querySelector('[data-design-variant="1"]')!);
    await waitFor(() => expect(current(view.container)).toContain("Dark"));
    expect(await swatch("Color/lt1")).toBe("#1b1b1b");
    expect(await swatch("Color/dk1")).toBe("#ffffff");

    await d.host.document.undo();
    await waitFor(() => expect(current(view.container)).not.toContain("Dark"));
    expect(await swatch("Color/lt1")).toBe("#ffffff");
    await d.host.document.undo();
    await waitFor(() => expect(current(view.container)).toContain("Office"));
    expect(await swatch("Color/accent1")).toBe("#156082");
  }, 60_000);

  it("counts a lost theme swatch and remaps it", async () => {
    const view = mount(d.panel(DESIGN_PANEL_ID));
    await settle();
    const out = await d.host.document.mutate({
      op: "deleteSwatch",
      args: { swatchId: "Color/accent6" },
    } as MutationInput);
    expect(out.applied).toBe(true);
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-design-missing]")?.textContent,
      ).toContain("1 references missing"),
    );
    fireEvent.click(view.container.querySelector("[data-design-remap]")!);
    const select = view.container.querySelector<HTMLSelectElement>(
      '[data-design-remap-select="Color/accent6"]',
    )!;
    const target = [...select.options].find((o) =>
      o.value.startsWith("Color/accent5"),
    )!;
    fireEvent.change(select, { target: { value: target.value } });
    fireEvent.click(
      view.container.querySelector(
        '[data-design-remap-apply="Color/accent6"]',
      )!,
    );
    await waitFor(() =>
      expect(view.container.querySelector("[data-design-missing]")).toBeNull(),
    );
  }, 60_000);
});
