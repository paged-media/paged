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

// Separations & Ink Limit (paged.separations). Two readings: the swatch
// ink limit (exact palette arithmetic, no profile needed) and the
// rendered plates per page (the inkCoverage collection, which needs a
// CMYK working profile). The public repository carries no ICC profile, so
// the plate rows are asserted in their no-profile state: the panel must
// say there is no ink lane, never report "no ink".

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { SeparationsPanel } from "../../src/panels/cockpit/separations-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { inkSwatches, pill } from "./support/cockpit";

afterEach(unmountAll);

type H = PanelHarness<void>;

const mount = () =>
  mountPanel(SeparationsPanel, {
    id: "paged.separations",
    scene: ({ client }) => inkSwatches(client),
  });

const preset = (h: H, value: number) =>
  h.root.querySelector<HTMLButtonElement>(
    `[data-ink-limit-preset="${value}"]`,
  )!;

const over = (h: H) =>
  [...h.root.querySelectorAll("[data-swatch-over-limit]")].map(
    (row) => row.textContent,
  );

describe("Separations: the swatch ink limit", () => {
  test("the four press presets, sheet-fed coated 300 % pressed by default", async () => {
    covers("panel:paged.separations");
    const h = await mount();
    expect(
      [...h.root.querySelectorAll("[data-ink-limit-preset]")].map((b) => [
        b.textContent,
        b.getAttribute("aria-pressed"),
      ]),
    ).toEqual([
      ["Sheet-fed coated 300%", "true"],
      ["Web coated 280%", "false"],
      ["Uncoated 260%", "false"],
      ["Newsprint 240%", "false"],
    ]);
  });

  test("at 300 %: only the swatch above it, a 300 % swatch is within", async () => {
    covers("panel:paged.separations");
    const h = await mount();
    expect(over(h)).toEqual(["Registration-ish400%"]);
    expect(pill(h.root, "swatch-limit-state")).toEqual({
      text: "1 over",
      tone: "error",
    });
  });

  test("a lower preset re-reads the palette: rich black goes over, highest first", async () => {
    covers("panel:paged.separations");
    const h = await mount();
    const from = h.mark();
    await h.click(preset(h, 280));
    expect(preset(h, 280).getAttribute("aria-pressed")).toBe("true");
    expect(preset(h, 300).getAttribute("aria-pressed")).toBe("false");
    expect(over(h)).toEqual(["Registration-ish400%", "Rich Black300%"]);
    expect(pill(h.root, "swatch-limit-state")?.text).toBe("2 over");
    // A re-threshold, not a re-read: nothing reaches the engine.
    expect(h.sent(undefined, from)).toEqual([]);
  });

  test("a palette within the limit reads Within limit", async () => {
    covers("panel:paged.separations");
    const h = await mountPanel(SeparationsPanel, { id: "paged.separations" });
    expect(over(h)).toEqual([]);
    expect(pill(h.root, "swatch-limit-state")).toEqual({
      text: "Within limit",
      tone: "ok",
    });
  });

  test("an RGB swatch is counted as uncheckable, not hidden", async () => {
    covers("panel:paged.separations");
    const h = await mount();
    expect(
      h.root.querySelector("[data-swatch-unseparable]")?.textContent,
    ).toContain("1 swatch(es) — RGB, Lab or mixed-ink — have no ink breakdown");
  });

  test("a swatch added while open is checked at once", async () => {
    covers("panel:paged.separations");
    const h = await mount();
    await h.mutate({
      op: "createSwatch",
      args: {
        spec: {
          name: "Heavy",
          space: "CMYK",
          value: [100, 100, 100, 50],
          model: "Process",
        },
      },
    } as never);
    expect(over(h)).toEqual(["Registration-ish400%", "Heavy350%"]);
  });
});

describe("Separations: plates", () => {
  test("without a working CMYK profile it says there is no ink lane, not that there is no ink", async () => {
    covers("panel:paged.separations");
    const h = await mount();
    const coverage = (await h.client.collection("inkCoverage")) as Array<{
      separationAvailable: boolean;
    }>;
    expect(coverage.map((c) => c.separationAvailable)).toEqual([false]);
    expect(
      h.root.querySelector("[data-separations-unavailable]")?.textContent,
    ).toContain("No CMYK working profile is active");
    expect(h.root.querySelector("[data-separations-no-plates]")).toBeNull();
    // No page-coverage verdict without a lane to read it from.
    expect(pill(h.root, "page-limit-state")).toBeNull();
  });

  test("no document: asks for one", async () => {
    covers("panel:paged.separations");
    const h = await mountPanel(SeparationsPanel, {
      id: "paged.separations",
      document: "none",
    });
    expect(h.root.textContent).toContain("Open a document to separate it.");
  });

  test("the plate preview is a stated seam, with no control", async () => {
    covers("panel:paged.separations");
    const h = await mount();
    const seam = h.root.querySelector("[data-separations-preview-seam]");
    expect(seam?.textContent).toContain(
      "Isolating a single plate on the canvas is not wired.",
    );
    expect(seam?.querySelector("button, input, select")).toBeNull();
  });
});
