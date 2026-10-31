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

// Shared steps of the slide show journeys (slide ADR 716): open the
// PowerPoint fixture deck through the host's importer registry (the path
// File ▸ Open takes), and a probe bundle that reads the editor's active
// page and the slides' state, as a plugin sees them.

import { expect, type Page } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Designer } from "../driver/designer";

const PPTX_FIXTURE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../e2e/harness/slide-deck.pptx",
);

type Probe = {
  viewport: {
    goToPage(id: string): Promise<boolean>;
    activePage(): string | null;
  };
  document: {
    collection(
      name: string,
    ): Promise<
      { selfId: string; pluginMetadata?: { key: string; value: string }[] }[]
    >;
  };
};
type G = { __slideProbe?: Probe };

/** A blank editor with the fixture deck open (ten 960 × 540 pt slides).
 *  Answers the page ids. */
export async function openDeck(page: Page): Promise<string[]> {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  const bytes = [...readFileSync(PPTX_FIXTURE)];
  await page.evaluate(
    async ({ bytes, name }) => {
      const reg = (
        globalThis as unknown as {
          __canvas: {
            registries: {
              importers: {
                resolve(n: string): {
                  import(a: {
                    name: string;
                    bytes: Uint8Array;
                    mimeType: string;
                  }): Promise<void>;
                } | null;
              };
            };
          };
        }
      ).__canvas.registries.importers;
      await reg.resolve(name)!.import({
        name,
        bytes: new Uint8Array(bytes),
        mimeType: "",
      });
    },
    { bytes, name: "slide-deck.pptx" },
  );
  await expect
    .poll(async () => (await designer.handle()).pageCount, { timeout: 30_000 })
    .toBe(10);
  // A probe bundle: the page doors as a plugin has them.
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __loadTestBundle?: unknown })
        .__loadTestBundle === "function",
  );
  await page.evaluate(async () => {
    const g = globalThis as unknown as G & {
      __loadTestBundle: (b: unknown) => unknown;
    };
    await new Promise<void>((resolve) => {
      g.__loadTestBundle({
        manifest: {
          id: "media.paged.journey.slideprobe",
          name: "slide probe",
          version: "0.0.0",
          apiVersion: "^0.2",
          capabilities: { document: { read: "broad" } },
        },
        activate(host: Probe) {
          g.__slideProbe = host;
          resolve();
          return { dispose() {} };
        },
      });
    });
  });
  return (await designer.handle()).pageIds;
}

/** The page the editor is on, as a plugin reads it. */
export const activePage = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as G).__slideProbe!.viewport.activePage(),
  );

/** Bring a slide into view, as the Slides panel does. */
export async function goToSlide(page: Page, pageId: string): Promise<void> {
  await page.evaluate(
    (id) => (globalThis as unknown as G).__slideProbe!.viewport.goToPage(id),
    pageId,
  );
  await expect.poll(() => activePage(page), { timeout: 10_000 }).toBe(pageId);
}

/** A slide's state as its page label holds it. */
export async function slideState(
  page: Page,
  pageId: string,
): Promise<{ hidden?: boolean; transition?: { advanceAfterMs?: number } }> {
  return page.evaluate(async (id) => {
    const pages = await (
      globalThis as unknown as G
    ).__slideProbe!.document.collection("pages");
    const v = pages
      .find((p) => p.selfId === id)
      ?.pluginMetadata?.find(
        (m) => m.key === "x-paged:media.paged.slide",
      )?.value;
    return v ? (JSON.parse(v) as { data: object }).data : {};
  }, pageId);
}

/** Hand the keys to the editor (not a panel field), as a click on the
 *  page area does. */
export async function focusEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
}
