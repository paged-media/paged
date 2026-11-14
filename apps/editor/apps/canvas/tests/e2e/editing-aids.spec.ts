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

// Editing aids and Proof view (editor ADR "Editing aids and Proof view";
// the redesign strategy's §4.1 and §4.5; the interaction contract's
// UXI-GDE-003 / -004 and UXI-OVR-002): each aid is its own remembered
// toggle, in the bottom bar's control and View ▸ Editing aids; the hidden
// characters, nonprinting items and a frame's own baseline grid come from
// the engine (engine ADR 1306); Proof view hides every aid and the
// selection's handles, masks the pasteboard at the trim (or the bleed),
// draws the page as a proof and never touches the selection. Each asserts
// the overlays, the engine's answers, the selection and the history, not
// a screenshot.

import { expect, test, type Page } from "@playwright/test";

import {
  buildFixtureIdml,
  covers,
  rect,
  textFrame,
} from "@paged-media/test-kit";

import { openCanvas } from "../fidelity/canvas-driver";
import { selectElements } from "./harness/gesture-kit";
import { expectHistoryUnchanged } from "./harness/history";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import { clickMenuRow } from "./harness/shell-surface";
import { loadIdmlFixture, openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;

const aid = (page: Page, id: string) =>
  page.locator(`[data-editing-aid="${id}"]`);

async function openControl(page: Page) {
  const control = page.locator("[data-editing-aids-control]");
  await control.click();
  await expect(aid(page, "frameEdges")).toBeVisible();
}

async function storedAids(page: Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("paged.view.editingAids") ?? "null"),
  );
}

type G = {
  __canvas: {
    client: {
      send(m: unknown): Promise<{ kind: string; payload: unknown }>;
      subscribe(
        f: (msg: { kind: string; payload: unknown }) => void,
      ): () => void;
    };
  };
};

/** The engine-side aids' fixture: a text frame of two paragraphs, a frame
 *  with a baseline grid of its own, and a black nonprinting square. */
const AIDS = {
  pageId: "aidsP",
  text: { id: "aidsText", story: "aidsS", box: [72, 72, 200, 540] as const },
  grid: { id: "aidsGrid", story: "aidsG", box: [240, 72, 360, 300] as const },
  np: { id: "aidsNp", box: [420, 100, 520, 300] as const, at: [200, 470] },
};

function aidsIdml(): Uint8Array {
  return buildFixtureIdml({
    name: "editing-aids",
    pages: [
      {
        id: AIDS.pageId,
        items: [
          textFrame(AIDS.text.id, AIDS.text.box, AIDS.text.story),
          textFrame(AIDS.grid.id, AIDS.grid.box, AIDS.grid.story, {
            baselineGrid: { start: 5, increment: 13, relativeTo: "TopOfFrame" },
          }),
          rect(AIDS.np.id, AIDS.np.box, {
            fill: "Color/Black",
            nonprinting: true,
          }),
        ],
      },
    ],
    stories: [
      { id: AIDS.text.story, paragraphs: ["One two three", "Four"] },
      { id: AIDS.grid.story, paragraphs: ["On a grid"] },
    ],
  });
}

/** What the engine hits at a page-local point. */
async function hitAt(page: Page, at: readonly number[]) {
  return page.evaluate(
    async ({ pageId, at }) => {
      const r = await (globalThis as unknown as G).__canvas.client.send({
        kind: "hitTest",
        payload: { pageId, docPoint: at, filter: "any" },
      });
      const p = r.payload as { element?: { id: string } | null } | null;
      return p?.element?.id ?? null;
    },
    { pageId: AIDS.pageId, at },
  );
}

/** Record the view settings the engine applies from now on. */
async function watchViewSettings(page: Page) {
  await page.evaluate(() => {
    const w = globalThis as unknown as G & { __viewSettings: unknown[] };
    w.__viewSettings = [];
    w.__canvas.client.subscribe((msg) => {
      if (msg.kind === "viewSettingsApplied")
        w.__viewSettings.push((msg.payload as { settings: unknown }).settings);
    });
  });
}

/** The last view settings the engine applied (an absent flag is off). */
async function lastViewSettings(page: Page) {
  return page.evaluate(() => {
    const all = (globalThis as unknown as { __viewSettings: unknown[] })
      .__viewSettings;
    const last = all[all.length - 1] as
      { hideNonprinting?: boolean; proof?: boolean } | undefined;
    return last
      ? {
          hideNonprinting: last.hideNonprinting === true,
          proof: last.proof === true,
        }
      : null;
  });
}

test.describe("editing aids and Proof view", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
  });

  test("each aid is its own remembered switch, every one enabled @feat:editor-shell.view-menu @level:happy", async ({
    page,
  }) => {
    covers(
      "command:paged.view.toggleFrameEdges",
      "command:paged.view.toggleMarginsColumns",
      "command:paged.view.toggleBaselineGrid",
      "command:paged.view.toggleOversetMarkers",
      "command:paged.view.toggleHiddenCharacters",
      "command:paged.view.toggleNonprinting",
      "setting:paged.view.editingAids",
    );
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      await openControl(page);
      // The defaults: a clean page with its margins, guides and overset
      // markers; frame edges and the baseline grid off.
      await expect(aid(page, "frameEdges")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(aid(page, "marginsColumns")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(aid(page, "guides")).toHaveAttribute("aria-checked", "true");
      for (const id of ["hiddenCharacters", "nonprinting"]) {
        await expect(aid(page, id)).not.toHaveAttribute("data-disabled", "");
        await expect(aid(page, id)).not.toContainText("not supported");
      }
      await expect(aid(page, "hiddenCharacters")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(aid(page, "nonprinting")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(page.locator("[data-frame-edge]")).toHaveCount(0);

      // Frame edges on: every item's edge, the unselected ones too.
      await aid(page, "frameEdges").click();
      await expect(
        page.locator(`[data-frame-edge="${A.back.id.id}"]`),
      ).toBeAttached();
      await expect(
        page.locator(`[data-frame-edge="${A.note.id.id}"]`),
      ).toBeAttached();
      // Margins and columns off, independently: the frame edges stay.
      await aid(page, "marginsColumns").click();
      await expect(aid(page, "marginsColumns")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(page.locator("[data-margin-guides]")).toHaveCount(0);
      await expect(
        page.locator(`[data-frame-edge="${A.back.id.id}"]`),
      ).toBeAttached();
      // The baseline grid, at a zoom where its lines are apart.
      await aid(page, "baselineGrid").click();
      await expect(
        page.locator("[data-baseline-grid] line").first(),
      ).toBeAttached();
      await page.keyboard.press("Escape");
    });
    expect(await storedAids(page)).toMatchObject({
      frameEdges: true,
      marginsColumns: false,
      baselineGrid: true,
      guides: true,
    });

    // The View menu shows the same switches, and a new editor on this
    // page remembers them.
    await clickMenuRow(page, "View/Editing aids/Margins and columns");
    await clickMenuRow(page, "View/Editing aids/Frame edges");
    await expect(page.locator("[data-frame-edge]")).toHaveCount(0);
    await clickMenuRow(page, "View/Editing aids/Baseline grid");
    expect(await storedAids(page)).toMatchObject({
      frameEdges: false,
      marginsColumns: true,
      baselineGrid: false,
    });
    await clickMenuRow(page, "View/Editing aids/Ruler guides");
    await clickMenuRow(page, "View/Editing aids/Overset markers");
    expect(await storedAids(page)).toMatchObject({
      guides: false,
      oversetMarkers: false,
    });
    await clickMenuRow(page, "View/Editing aids/Ruler guides");
    await clickMenuRow(page, "View/Editing aids/Overset markers");
    await clickMenuRow(page, "View/Editing aids/Frame edges");
    await openUxiFixture(page, "A");
    await expect(
      page.locator(`[data-frame-edge="${A.back.id.id}"]`),
    ).toBeAttached();
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("Proof view hides the aids and the handles, masks the pasteboard at the trim, and keeps the selection @feat:editor-shell.view-menu @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:View/Proof view",
      "menu:View/Editing aids/Frame edges",
      "menu:View/Editing aids/Margins and columns",
      "menu:View/Editing aids/Ruler guides",
      "menu:View/Editing aids/Baseline grid",
      "menu:View/Editing aids/Text threads",
      "menu:View/Editing aids/Overset markers",
      "menu:View/Editing aids/Hidden characters",
      "menu:View/Editing aids/Nonprinting items",
      "command:paged.view.toggleGuides",
    );
    const model = await modelSnapshot(page);
    await selectElements(page, [A.front.id]);
    await clickMenuRow(page, "View/Editing aids/Frame edges");
    const selected = await selectionSnapshot(page);
    expect(selected.elements).toEqual([A.front.id]);
    const handles = page.locator("[data-selection-handle]");
    await expect(handles.first()).toBeVisible();
    await expect(page.locator("[data-frame-edge]").first()).toBeAttached();

    await expectHistoryUnchanged(page, async () => {
      await clickMenuRow(page, "View/Proof view");
      await expect(page.locator("[data-proof-surface]")).toHaveAttribute(
        "data-proof-surface",
        "trim",
      );
      await expect(page.locator("[data-proof-badge]")).toContainText(
        "Trim 612 × 792 pt",
      );
      await expect(handles).toHaveCount(0);
      await expect(page.locator("[data-frame-edge]")).toHaveCount(0);
      // The aids keep their states: Proof view hides, it does not switch.
      expect(await storedAids(page)).toMatchObject({ frameEdges: true });
      // The selection survived the switch.
      expect(await selectionSnapshot(page)).toEqual(selected);

      // The bottom bar's control says so and turns it off again.
      await expect(page.locator("[data-editing-aids-control]")).toHaveAttribute(
        "data-proof-view",
        "on",
      );
      await page.locator("[data-proof-leave]").click();
      await expect(page.locator("[data-proof-surface]")).toHaveCount(0);
      await expect(handles.first()).toBeVisible();
      await expect(page.locator("[data-frame-edge]").first()).toBeAttached();
      expect(await selectionSnapshot(page)).toEqual(selected);

      // The Bleed screen mode is the proof with the bleed let through.
      await openControl(page);
      await aid(page, "proofView").click();
      await expect(page.locator("[data-proof-surface]")).toHaveAttribute(
        "data-proof-surface",
        "trim",
      );
      await page.keyboard.press("Escape");
      // W, InDesign's key, from the page (not a focused button).
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur?.(),
      );
      await page.keyboard.press("w");
      await expect(page.locator("[data-proof-surface]")).toHaveCount(0);
      await expect(handles.first()).toBeVisible();
    });
    expect(await selectionSnapshot(page)).toEqual(selected);
    expect(await modelSnapshot(page)).toBe(model);
  });
  test("hidden characters, nonprinting items and a frame's own grid come from the engine, and change no document @feat:editor-shell.view-menu @level:happy", async ({
    page,
  }) => {
    covers(
      "command:paged.view.toggleHiddenCharacters",
      "command:paged.view.toggleNonprinting",
      "setting:view.hiddenCharacters",
      "setting:view.nonprinting",
      "setting:view.baselineGrid",
    );
    await openCanvas(page);
    await loadIdmlFixture(page, "editing-aids.idml", aidsIdml());
    await watchViewSettings(page);
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      // Hidden characters: the marks of the spaces, the returns and the
      // story's end, where the engine says the lines hold them.
      const marks = page.locator("[data-hidden-characters]");
      await expect(marks).toHaveCount(0);
      await clickMenuRow(page, "View/Editing aids/Hidden characters");
      await expect(marks).toBeAttached();
      await expect
        .poll(async () =>
          Number(await marks.getAttribute("data-hidden-characters")),
        )
        .toBeGreaterThan(3);
      const kinds = (await marks.getAttribute("data-hidden-kinds")) ?? "";
      for (const k of ["space", "paragraphEnd", "storyEnd"])
        expect(kinds.split(" ")).toContain(k);
      await expect(page.locator("[data-hidden-run]").first()).toBeAttached();

      // Nonprinting items: shown, the square is on screen and hit; off,
      // the engine leaves it off the screen and nothing lands on it.
      expect(await hitAt(page, AIDS.np.at)).toBe(AIDS.np.id);
      await clickMenuRow(page, "View/Editing aids/Nonprinting items");
      await expect
        .poll(() => lastViewSettings(page))
        .toMatchObject({ hideNonprinting: true });
      await expect.poll(() => hitAt(page, AIDS.np.at)).toBeNull();
      await clickMenuRow(page, "View/Editing aids/Nonprinting items");
      await expect.poll(() => hitAt(page, AIDS.np.at)).toBe(AIDS.np.id);

      // The baseline grid draws the frame's own grid over the frame.
      await clickMenuRow(page, "View/Editing aids/Baseline grid");
      await expect(
        page
          .locator(`[data-frame-baseline-grid="${AIDS.grid.id}"] line`)
          .first(),
      ).toBeAttached();
      await clickMenuRow(page, "View/Editing aids/Baseline grid");
      await clickMenuRow(page, "View/Editing aids/Hidden characters");
      await expect(marks).toHaveCount(0);
    });
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("Proof view draws the page as a proof: no page edge, no markers, no nonprinting items @feat:editor-shell.view-menu @level:happy", async ({
    page,
  }) => {
    covers("menu:View/Proof view");
    await openCanvas(page);
    await loadIdmlFixture(page, "editing-aids.idml", aidsIdml());
    await watchViewSettings(page);
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      await clickMenuRow(page, "View/Proof view");
      await expect
        .poll(() => lastViewSettings(page))
        .toMatchObject({ proof: true, hideNonprinting: true });
      // What prints: the nonprinting square is not on the proof.
      await expect.poll(() => hitAt(page, AIDS.np.at)).toBeNull();
      await clickMenuRow(page, "View/Proof view");
      await expect
        .poll(() => lastViewSettings(page))
        .toMatchObject({ proof: false, hideNonprinting: false });
      await expect.poll(() => hitAt(page, AIDS.np.at)).toBe(AIDS.np.id);
    });
    expect(await modelSnapshot(page)).toBe(model);
  });
});
