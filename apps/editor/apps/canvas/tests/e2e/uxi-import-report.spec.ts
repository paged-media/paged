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

// The compatibility report (editor ADR 1222; UXI-FIL-001, UXI-FIL-002;
// task DF4): an import that converts or leaves something out says so once
// ("Imported fx.svg · 1 unsupported effect"), and its report lists exactly
// what the engine reported, explained, with the code on demand; a file
// that cannot be opened leaves the open document as it was and says so,
// in a toast and in Problems. Model and history asserted.

import { expect, test, type Page } from "@playwright/test";

import { expectHistoryUnchanged, expectUndoSteps } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { clickMenuRow } from "./harness/shell-surface";
import { openUxiFixture } from "./harness/uxi-fixtures";

type Win = {
  __canvas: {
    client: {
      svgImportPlan(
        pageId: string,
        bytes: Uint8Array,
      ): Promise<{
        report: { losses: Array<{ code: string; count: number }> };
      }>;
      sceneTree(): Promise<Array<{ id?: unknown; children?: unknown[] }>>;
    };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
    handle?: { pageIds: string[] } | null;
  };
};

/** An SVG with what `paged-svg` cannot carry: a filter effect. */
const FX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <defs><filter id="f"><feTurbulence baseFrequency="0.05" numOctaves="2"/></filter></defs>
  <rect x="20" y="20" width="160" height="160" fill="#336699" filter="url(#f)"/>
</svg>`;

const itemCount = (page: Page) =>
  page.evaluate(async () => {
    const tree = await (
      globalThis as unknown as Win
    ).__canvas.client.sceneTree();
    let n = 0;
    const visit = (node: { id?: unknown; children?: unknown[] }) => {
      if (node.id) n++;
      for (const c of (node.children ?? []) as Array<typeof node>) visit(c);
    };
    for (const r of tree) visit(r);
    return n;
  });

/** What the engine itself reports for `svg` (the report must say the
 *  same). */
const engineLosses = (page: Page, svg: string) =>
  page.evaluate(async (text) => {
    const c = (globalThis as unknown as Win).__canvas;
    const pageId = c.handle?.pageIds?.[0] ?? "uxA";
    const plan = await c.client.svgImportPlan(
      pageId,
      new TextEncoder().encode(text),
    );
    return plan.report.losses.map((l) => `${l.code}×${l.count}`).sort();
  }, svg);

test.describe("UXI-T66 — the compatibility report", () => {
  test("UXI-T66 — an import with conversion losses: the summary says it once, the report lists exactly the engine's losses @feat:editor-shell.import-svg-pdf-vectors @uxi:UXI-FIL-002 @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    const expected = await engineLosses(page, FX_SVG);
    expect(expected.length).toBeGreaterThan(0);
    const before = await itemCount(page);
    await expectUndoSteps(page, 1, async () => {
      const chooser = page.waitForEvent("filechooser");
      await clickMenuRow(page, "File/Import/SVG…");
      await (
        await chooser
      ).setFiles({
        name: "fx.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(FX_SVG),
      });
      await expect.poll(() => itemCount(page)).toBeGreaterThan(before);
    });
    // The summary, once, with View report.
    const toast = page.locator(
      '[data-feedback-toast][data-feedback-key="paged.compat|paged.svg|import"]',
    );
    await expect(toast).toHaveCount(1);
    await expect(toast.locator("[data-feedback-headline]")).toContainText(
      "Imported fx.svg ·",
    );
    await toast
      .locator('[data-feedback-action="paged.panel.show.paged.import-report"]')
      .click();
    const report = page.locator(
      '[data-import-report][data-import-report-id="paged.svg|import"]',
    );
    await expect(report).toBeVisible();
    await expect(report).toHaveAttribute("data-format", "svg");
    // Accurate: the rows are the engine's losses, code for code.
    const rows = await report.locator("[data-loss]").evaluateAll((els) =>
      els
        .map((e) => {
          const count = e.querySelector("[data-loss-count]")?.textContent;
          return `${e.getAttribute("data-loss-code")}×${count ? parseInt(count, 10) : 1}`;
        })
        .sort(),
    );
    expect(rows).toEqual(expected);
    // The technical code is there on demand only.
    const first = report.locator("[data-loss]").first();
    await expect(first.locator("[data-loss-code-text]")).toHaveCount(0);
    await first.locator("[data-loss-code-toggle]").click();
    await expect(first.locator("[data-loss-code-text]")).toBeVisible();
    // The report states the format's round-trip risk.
    await expect(report.locator("[data-import-report-risk]")).toContainText(
      "SVG",
    );
  });

  test("UXI-T66 — a file that cannot be opened leaves the document as it was, and says so @feat:editor-shell.file-intake @uxi:UXI-FIL-001 @level:edge", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    const model = await modelSnapshot(page);
    await expectHistoryUnchanged(page, async () => {
      // A ZIP-signed file whose package is damaged: the engine fails it.
      const damaged = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.alloc(200, 7),
      ]);
      await page.setInputFiles('input[type="file"]', {
        name: "damaged.idml",
        mimeType: "application/vnd.adobe.indesign-idml-package",
        buffer: damaged,
      });
      await expect(
        page.locator(
          '[data-feedback-toast][data-outcome="recoverable-failure"]',
        ),
      ).toContainText("damaged.idml");
    });
    expect(await modelSnapshot(page)).toBe(model);
    // UX audit F-02: the failure is in Problems until dismissed.
    await page.evaluate(() =>
      (globalThis as unknown as Win).__canvas.registries.commands.invoke(
        "paged.panel.show.paged.problems",
      ),
    );
    const row = page.locator("[data-problem]", { hasText: "damaged.idml" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Nothing changed.");
  });
});
