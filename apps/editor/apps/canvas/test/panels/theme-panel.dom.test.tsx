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

// Theme (paged.theme, engine ADR 1056 / 1057): a preset applies through
// setTheme, a slot edit is one setThemeColor and recolours the swatches that
// follow it, and a document with no theme makes one from its swatches. The
// panel writes engine operations only.

import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import {
  ThemePanel,
  themeSpec,
  type ThemeRow,
} from "../../src/panels/theme-panel";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

const mount = () => mountPanel(ThemePanel, { id: "paged.theme" });

describe("Theme panel", () => {
  test("a document with no theme offers presets and a theme from swatches", async () => {
    covers("panel:paged.theme");
    const h = await mount();
    expect(h.root.querySelector('[data-theme="none"]')).not.toBeNull();
    expect(
      h.root.querySelector('[data-theme-section="from-swatches"]'),
    ).not.toBeNull();
    const options = [
      ...h.root.querySelectorAll<HTMLOptionElement>(
        '[data-action="preset"] option',
      ),
    ].map((o) => o.value);
    expect(options).toEqual(["", "office-2013", "office-2023"]);
  });

  test("a preset applies through setTheme and shows its twelve slots", async () => {
    covers("panel:paged.theme");
    const h = await mount();
    await h.choose(
      h.root.querySelector('[data-action="preset"]') as HTMLElement,
      "office-2013",
    );
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="apply-preset"]')!);
    expect(h.mutations(from).map((m) => m.op)).toEqual(["setTheme"]);
    const rows = (await h.client.collection("theme")) as ThemeRow[];
    expect(rows[0].name).toBe("Office 2013-2022");
    expect(h.root.querySelectorAll("[data-theme-slot]").length).toBe(12);
    expect(
      h.root.querySelector<HTMLInputElement>('[data-theme-slot="accent1"]')!
        .value,
    ).toBe("#4472c4");
  });

  test("a slot edit is one setThemeColor; the fonts edit through setThemeFonts", async () => {
    covers("panel:paged.theme");
    const h = await mount();
    await h.choose(
      h.root.querySelector('[data-action="preset"]') as HTMLElement,
      "office-2013",
    );
    await h.click(h.root.querySelector('[data-action="apply-preset"]')!);
    const from = h.mark();
    await h.act(() =>
      fireEvent.change(h.root.querySelector('[data-theme-slot="accent2"]')!, {
        target: { value: "#00ff00" },
      }),
    );
    expect(h.mutations(from)).toEqual([
      { op: "setThemeColor", args: { slot: "accent2", value: "00ff00" } },
    ] as never);
    const font = h.root.querySelector<HTMLInputElement>(
      '[data-theme-font="major"]',
    )!;
    await h.act(() => {
      fireEvent.change(font, { target: { value: "Georgia" } });
      fireEvent.blur(font);
    });
    const rows = (await h.client.collection("theme")) as ThemeRow[];
    expect(rows[0].colors.find((c) => c.slot === "accent2")?.value).toBe(
      "00FF00",
    );
    expect(rows[0].major.latin).toBe("Georgia");
  });

  test("a theme is made from a swatch, which then follows its slot", async () => {
    covers("panel:paged.theme");
    const h = await mount();
    await h.mutate({
      op: "createSwatch",
      args: { spec: { name: "Brand", space: "RGB", value: [21, 96, 130] } },
    } as never);
    const pick = h.root.querySelector<HTMLSelectElement>(
      '[data-pick-slot="accent1"]',
    )!;
    const brand = [...pick.options].find((o) => o.textContent === "Brand")!;
    await h.choose(pick, brand.value);
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="create-theme"]')!);
    const ops = h.mutations(from);
    expect(ops.map((m) => m.op)).toEqual(["createThemeFromSwatches"]);
    const rows = (await h.client.collection("theme")) as ThemeRow[];
    expect(rows[0].colors[0]).toMatchObject({
      slot: "accent1",
      value: "156082",
    });
    expect(h.root.querySelector('[data-theme-slot="accent1"]')).not.toBeNull();
  });

  test("a refusal is shown and changes nothing", async () => {
    covers("panel:paged.theme");
    const h = await mount();
    await h.click(h.root.querySelector('[data-action="create-theme"]')!);
    expect(h.root.querySelector("[data-theme-error]")).not.toBeNull();
    expect(((await h.client.collection("theme")) as unknown[]).length).toBe(0);
  });

  test("themeSpec carries scripts in the wire shape", () => {
    const row: ThemeRow = {
      name: "T",
      colors: [{ slot: "dk1", value: "000000", system: "windowText" }],
      major: { latin: "A", scripts: [["Jpan", "Yu Gothic"]] },
      minor: {},
    };
    expect(themeSpec(row).major.scripts).toEqual([
      { script: "Jpan", typeface: "Yu Gothic" },
    ]);
    expect(themeSpec(row).colors[0].system).toBe("windowText");
  });
});
