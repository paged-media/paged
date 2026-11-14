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

// Layout variants (editor ADR 1235; the UX strategy's Concept D; task PX5):
// a layout branched into a named variant on the document's repository (no
// file duplicated); opened, a variant's saves commit to it and main stays
// as it was; two layouts compare side by side with what changed listed;
// Make main is a new version of main; a style main changed reaches the
// variant only through Apply shared changes, after its preview.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

type Win = {
  __canvas: {
    client: {
      mutate(m: unknown): Promise<{ kind: string }>;
      send(m: unknown): Promise<{ kind: string; payload: unknown }>;
      collection(name: string): Promise<Array<Record<string, unknown>>>;
      elementGeometry(
        ids: unknown[],
      ): Promise<Array<{ itemTransform?: number[] | null }>>;
    };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Win).__canvas.registries.commands.invoke(cmd),
    id,
  );

const frontX = (page: Page) =>
  page.evaluate(async (id) => {
    const [g] = await (
      globalThis as unknown as Win
    ).__canvas.client.elementGeometry([id]);
    return g?.itemTransform?.[4] ?? 0;
  }, UXI_A.front.id);

async function save(page: Page): Promise<void> {
  const download = page.waitForEvent("download");
  await invoke(page, "paged.file.savePaged");
  await download;
}

async function clearLibrary(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root
      .removeEntry("paged-library", { recursive: true })
      .catch(() => undefined);
  });
}

/** Make the paragraph style "Shared" (main, before the variant). */
const makeSharedStyle = (page: Page) =>
  page.evaluate(async () => {
    const c = (globalThis as unknown as Win).__canvas.client;
    const reply = await c.mutate({
      op: "createParagraphStyle",
      args: { name: "Shared" },
    });
    return reply.kind;
  });

/** Set the "Shared" style's size to `pt`. */
const sizeSharedStyle = (page: Page, pt: number) =>
  page.evaluate(async (size) => {
    const c = (globalThis as unknown as Win).__canvas.client;
    const style = (await c.collection("paragraphStyles")).find(
      (s) => s.name === "Shared",
    );
    if (!style) return "no style";
    const reply = await c.mutate({
      op: "setStyleProperty",
      args: {
        collection: "paragraph",
        styleId: style.selfId,
        path: "characterFontSize",
        value: { type: "length", value: size },
      },
    });
    return reply.kind;
  }, pt);

test.describe("PX5 — layout variants", () => {
  test("PX5 — a variant branches, saves on its own, compares, becomes main, and takes shared changes only when applied @feat:editor-shell.panels.library @level:happy @uxi:UXI-MUT-011", async ({
    page,
  }) => {
    covers("panel:paged.variants");
    await openUxiFixture(page, "A");
    await clearLibrary(page);
    await page.reload();
    await openUxiFixture(page, "A");
    await invoke(page, "paged.panel.show.paged.variants");
    const panel = page.locator("[data-variants-panel]");
    const mainRow = panel.locator('[data-variant-row="main"]');
    await expect(mainRow).toHaveAttribute("data-variant-open", "true");
    // A style main and its variants will share.
    expect(await makeSharedStyle(page)).toBe("mutationApplied");
    await save(page);

    // Branch the open layout into "Compact", then open it.
    await panel.locator("[data-variant-new]").click();
    await panel.locator("[data-variant-name]").fill("Compact");
    await panel.locator("[data-variant-create]").click();
    const compact = panel.locator('[data-variant-row="compact"]');
    await expect(compact).toHaveCount(1);
    await compact.locator("[data-variant-open-button]").click();
    await expect(compact).toHaveAttribute("data-variant-open", "true");

    // Work on the variant and save it: the save commits to the variant.
    const x0 = await frontX(page);
    await page.evaluate(
      async ([id, x]) => {
        await (globalThis as unknown as Win).__canvas.client.mutate({
          op: "moveFrame",
          args: { frameId: id, transform: [1, 0, 0, 1, x, 0] },
        });
      },
      [UXI_A.front.id.id, x0 + 40] as const,
    );
    await save(page);

    // Main and the variant side by side: the moved frame is listed.
    await compact.locator("[data-variant-compare]").click();
    const dialog = page.locator("[data-compare-dialog]");
    await expect(dialog).toHaveAttribute("data-compare-status", "ready", {
      timeout: 60_000,
    });
    await expect(
      dialog.locator(
        '[data-compare-group="frames"] [data-compare-change="moved"]',
      ),
    ).toContainText(UXI_A.front.id.id);
    await dialog.locator("[data-compare-close]").click();

    // Make main: a new version of main, which opens with the variant's layout.
    await compact.locator("[data-variant-promote]").click();
    await compact.locator("[data-variant-promote-go]").click();
    await expect(mainRow).toHaveAttribute("data-variant-open", "true");
    await expect.poll(() => frontX(page)).toBeCloseTo(x0 + 40, 1);

    // A shared change on main reaches the variant only when applied.
    expect(await sizeSharedStyle(page, 18)).toBe("mutationApplied");
    await save(page);
    await panel.locator("[data-variant-shared-plan]").click();
    const plan = panel.locator('[data-variant-plan="compact"]');
    await expect(plan).toHaveAttribute("data-variant-plan-styles", /[1-9]/, {
      timeout: 60_000,
    });
    await expect(plan).toContainText("Shared");
    await panel.locator("[data-variant-shared-apply]").click();
    await expect(panel.locator("[data-variant-shared-preview]")).toHaveCount(
      0,
      {
        timeout: 60_000,
      },
    );
    // Asked again, there is nothing left to apply.
    await panel.locator("[data-variant-shared-plan]").click();
    await expect(panel.locator("[data-variant-shared-nothing]")).toHaveCount(
      1,
      {
        timeout: 60_000,
      },
    );
  });
});
