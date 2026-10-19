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

// Ink Manager (paged.ink-manager): one row per spot ink with the
// output-time settings (convert to process, alias to another ink), the
// four process plates, and the document's "Use Standard Lab Values for
// Spots". None of them edit the swatch.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { InkManagerPanel } from "../../src/panels/ink-manager-panel";
import { apply, richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(InkManagerPanel, { id: "paged.ink-manager", scene: richScene });

const ink = (h: H, spotId: string) =>
  h.root.querySelector<HTMLElement>(`[data-ink-spot="${CSS.escape(spotId)}"]`)!;
const inks = async (h: H) =>
  (await h.client.collection("inks")) as Array<{
    spotId: string;
    convertToProcess: boolean;
    aliasTo: string | null;
  }>;

describe("Ink Manager panel: states", () => {
  test("a blank document: the four process plates and no spot inks", async () => {
    covers("panel:paged.ink-manager");
    const h = await mountPanel(InkManagerPanel, { id: "paged.ink-manager" });
    expect(
      [...h.root.querySelectorAll("[data-ink-process]")].map((r) =>
        r.getAttribute("data-ink-process"),
      ),
    ).toEqual(["cyan", "magenta", "yellow", "black"]);
    expect(h.root.querySelector('[data-inks="empty"]')).not.toBeNull();
    expect(
      h.root.querySelector<HTMLInputElement>('[data-action="standard-lab"]')!
        .checked,
    ).toBe(false);
  });

  test("a spot swatch is a spot ink, on its own plate, not converted", async () => {
    covers("panel:paged.ink-manager");
    const h = await mount();
    const row = ink(h, h.scene.spot);
    expect(row.textContent).toContain("Spot");
    expect(
      row.querySelector<HTMLInputElement>('[data-action="convert-to-process"]')!
        .checked,
    ).toBe(false);
    expect(
      row.querySelector<HTMLSelectElement>('[data-action="alias-ink"]')!.value,
    ).toBe("");
  });
});

describe("Ink Manager panel: controls", () => {
  test("Use Standard Lab Values writes the document setting", async () => {
    covers("panel:paged.ink-manager");
    const h = await mount();
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="standard-lab"]')!);
    expect(h.mutations(from)).toEqual([
      { op: "setUseStandardLabForSpots", args: { enabled: true } },
    ] as never);
    expect((await h.client.documentMeta()).useStandardLabForSpots).toBe(true);
    expect(
      h.root.querySelector<HTMLInputElement>('[data-action="standard-lab"]')!
        .checked,
    ).toBe(true);
  });

  test("→CMYK converts the ink to process at output; the swatch stays a spot", async () => {
    covers("panel:paged.ink-manager");
    const h = await mount();
    const from = h.mark();
    await h.click(
      ink(h, h.scene.spot).querySelector('[data-action="convert-to-process"]')!,
    );
    expect(h.mutations(from)).toEqual([
      {
        op: "setInkSetting",
        args: { spotId: h.scene.spot, convertToProcess: true, aliasTo: null },
      },
    ] as never);
    expect((await inks(h))[0].convertToProcess).toBe(true);
    expect(
      ink(h, h.scene.spot).querySelector<HTMLInputElement>(
        '[data-action="convert-to-process"]',
      )!.checked,
    ).toBe(true);
    const swatches = (await h.client.collection("swatches")) as Array<{
      selfId: string;
      kind: string;
    }>;
    expect(swatches.find((s) => s.selfId === h.scene.spot)?.kind).toBe("spot");
  });

  test("alias: a second spot ink can print on the first one's plate", async () => {
    covers("panel:paged.ink-manager");
    const h = await mountPanel(InkManagerPanel, {
      id: "paged.ink-manager",
      scene: async (ctx) => {
        const s = await richScene(ctx);
        await apply(ctx.client, {
          op: "createSwatch",
          args: {
            spec: {
              name: "Spot 2",
              space: "CMYK",
              value: [0, 0, 100, 0],
              model: "Spot",
            },
          },
        } as never);
        return s;
      },
    });
    const second = (await inks(h)).find(
      (i) => i.spotId !== h.scene.spot,
    )!.spotId;
    const from = h.mark();
    await h.choose(
      ink(h, second).querySelector('[data-action="alias-ink"]') as HTMLElement,
      h.scene.spot,
    );
    expect(h.mutations(from)).toEqual([
      {
        op: "setInkSetting",
        args: {
          spotId: second,
          convertToProcess: false,
          aliasTo: h.scene.spot,
        },
      },
    ] as never);
    expect((await inks(h)).find((i) => i.spotId === second)?.aliasTo).toBe(
      h.scene.spot,
    );
    expect(
      ink(h, second).querySelector<HTMLSelectElement>(
        '[data-action="alias-ink"]',
      )!.value,
    ).toBe(h.scene.spot);
    // An ink is never offered as its own alias.
    const own = [
      ...ink(h, h.scene.spot).querySelectorAll<HTMLOptionElement>(
        '[data-action="alias-ink"] option',
      ),
    ].map((o) => o.value);
    expect(own).not.toContain(h.scene.spot);
  });
});
