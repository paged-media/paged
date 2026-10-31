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

// The Word structure journeys' kit (doc ADRs 611 / 612): open
// doc-structure.docx (docx_conformance::structure_docx) with File ▸ Open
// and read the engine back.

import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page } from "@playwright/test";

import { openCanvas } from "../../fidelity/canvas-driver";

export const FIXTURE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../e2e/harness/doc-structure.docx",
);
const OPEN = "paged.file.openIdml";
const IMPORTER = "media.paged.doc.importer.docx";
export const STORY = "docx_s0";

type Reply = { kind: string; payload: Record<string, unknown> };
type CanvasGlobal = {
  __canvas: {
    ready: boolean;
    client: { send(m: unknown): Promise<Reply> };
    registries: {
      commands: { invoke(id: string): Promise<unknown> };
      importers: { resolve(name: string): { id: string } | null };
    };
    setContentSelection(s: unknown): void;
  };
};

export const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke(cmd),
    id,
  );

export interface Content {
  paragraphs: Array<{
    paragraphStyle?: string;
    toc?: string;
    runs: Array<{ text: string; fieldCode?: string }>;
  }>;
  textAnchors?: Array<{ name: string }>;
}

export async function content(
  page: Page,
  storyId = STORY,
): Promise<Content | null> {
  return page.evaluate(async (storyId) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const r = await c.client.send({
      kind: "requestStoryContent",
      payload: { storyId },
    });
    return (r.payload.content ?? null) as Content | null;
  }, storyId);
}

export async function texts(page: Page, storyId = STORY): Promise<string[]> {
  return ((await content(page, storyId))?.paragraphs ?? []).map((p) =>
    p.runs.map((r) => r.text).join(""),
  );
}

export async function collection<T>(page: Page, name: string): Promise<T[]> {
  return page.evaluate(async (name) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const r = await c.client.send({
      kind: "requestCollection",
      payload: { name },
    });
    return (r.payload.items ?? []) as T[];
  }, name);
}

export async function get(page: Page, address: string, path: string) {
  return page.evaluate(
    async ({ address, path }) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const r = await c.client.send({
        kind: "requestGet",
        payload: { address, path },
      });
      const v = r.payload.value as { value: unknown } | null;
      return v?.value ?? null;
    },
    { address, path },
  );
}

export const select = (page: Page, start: number, end = start) =>
  page.evaluate(
    ({ storyId, start, end }) =>
      (globalThis as unknown as CanvasGlobal).__canvas.setContentSelection({
        storyId,
        start,
        end,
      }),
    { storyId: STORY, start, end },
  );

/** File ▸ Open of doc-structure.docx through the Word importer. */
export async function openStructure(page: Page): Promise<void> {
  await openCanvas(page);
  await invoke(page, "paged.file.new");
  await page.waitForFunction(
    () => (globalThis as unknown as CanvasGlobal).__canvas.ready === true,
    null,
    { timeout: 15_000 },
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as CanvasGlobal
            ).__canvas.registries.importers.resolve("x.docx")?.id ?? null,
        ),
      { timeout: 15_000 },
    )
    .toBe(IMPORTER);
  const chooser = page.waitForEvent("filechooser");
  const opened = invoke(page, OPEN);
  await (await chooser).setFiles(FIXTURE);
  await opened;
  await expect
    .poll(async () => (await texts(page))[0] ?? "", { timeout: 30_000 })
    .toBe("Contents");
}

/** The content offset (the caret's unit) of the start of the paragraph
 *  whose text starts with `prefix`: UTF-8 bytes plus one per break. */
export async function offsetOf(page: Page, prefix: string): Promise<number> {
  const ps = await texts(page);
  const enc = new TextEncoder();
  let at = 0;
  for (const p of ps) {
    if (p.startsWith(prefix)) return at;
    at += enc.encode(p).length + 1;
  }
  throw new Error(`no paragraph starting "${prefix}"`);
}
