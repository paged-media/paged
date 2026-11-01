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
import { inflateRawSync } from "node:zlib";

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
  return openDeckFile(page, PPTX_FIXTURE, "slide-deck.pptx", 10);
}

/** A blank editor with the deck at `path` open (`pages` slides) and the
 *  probe bundle loaded. Answers the page ids. */
export async function openDeckFile(
  page: Page,
  path: string,
  name: string,
  pages: number,
): Promise<string[]> {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  const bytes = [...readFileSync(path)];
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
    { bytes, name },
  );
  await expect
    .poll(async () => (await designer.handle()).pageCount, { timeout: 30_000 })
    .toBe(pages);
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

/** The deck the exporter writes now: part `name` as text. */
export async function exportedPart(page: Page, name: string): Promise<string> {
  const bytes = await page.evaluate(async () => {
    const ex = (
      globalThis as unknown as {
        __canvas: {
          registries: {
            exporters?: {
              list: () => {
                id: string;
                export: () => Promise<{ bytes: Uint8Array } | null>;
              }[];
            };
          };
        };
      }
    ).__canvas.registries.exporters
      ?.list()
      .find((e) => e.id === "media.paged.slide.exporter.pptx");
    const out = ex ? await ex.export() : null;
    return out ? Array.from(out.bytes) : null;
  });
  const b = Buffer.from(bytes!);
  let eocd = b.length - 22;
  while (b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < b.readUInt16LE(eocd + 10); i++) {
    const n = b.readUInt16LE(p + 28);
    const local = b.readUInt32LE(p + 42);
    if (b.toString("utf8", p + 46, p + 46 + n) === name) {
      const start =
        local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + b.readUInt32LE(p + 20));
      return (
        b.readUInt16LE(p + 10) === 8 ? inflateRawSync(data) : data
      ).toString("utf8");
    }
    p += 46 + n + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  throw new Error(`no ${name}`);
}

type TreeNode = {
  id?: { kind: string; id: string };
  children?: TreeNode[];
  pluginMetadata?: { key: string; value: string }[];
};

/** The shapes on a slide, one element per shape (its first item) with its
 *  shape key (`<slide part>#<cNvPr id>`), in order, as a plugin reads them. */
export async function shapesOn(
  page: Page,
  pageId: string,
): Promise<{ kind: string; id: string; key: string }[]> {
  return page.evaluate(async (pid) => {
    const host = (
      globalThis as unknown as {
        __slideProbe: {
          document: {
            tree(): Promise<TreeNode[]>;
            elementGeometry(
              ids: unknown[],
            ): Promise<{ id: { id: string }; pageId?: string | null }[]>;
          };
        };
      }
    ).__slideProbe;
    const rows: { kind: string; id: string; key: string }[] = [];
    const keys = new Set<string>();
    const walk = (nodes: TreeNode[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.id) {
          const key = /"shape":"([^"]+)"/.exec(
            n.pluginMetadata?.map((m) => m.value).join("") ?? "",
          )?.[1];
          if (key && !keys.has(key)) {
            keys.add(key);
            rows.push({ ...n.id, key });
          }
        } else walk(n.children);
      }
    };
    walk(await host.document.tree());
    const geo = await host.document.elementGeometry(rows);
    const on = new Set(geo.filter((g) => g.pageId === pid).map((g) => g.id.id));
    return rows.filter((r) => on.has(r.id));
  }, pageId);
}
