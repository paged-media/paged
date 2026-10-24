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

// plugin-doc.file-entry — the .docx/.dotx FILE ENTRY doors. The doc
// journey drives the COMMAND lane (placeDoc); what nothing asserted
// until now is the IMPORTER lane: `media.paged.doc.importer.docx` in
// the File▸Open importer-registry UNION (K-2/S-06 — the same union
// FileDrop consults), and the actual File▸Open command routing a picked
// .docx through it instead of the default IDML loader. Both are the
// registry row's named gap ("no test feeds it a .docx" through
// File▸Open) — closed here at the union + command altitude; deep DOCX
// semantics stay with plugin-doc's own conformance suite.
//
// UX audit F-08: the opened Word document reads clean (no "Edited") until
// the user changes it, although the importer builds it with mutations
// after the open. F-01 for Word: a .docx dropped on an edited document
// asks the replace question first, and Cancel keeps the document.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openCanvas } from "../fidelity/canvas-driver";

type Page = import("@playwright/test").Page;

const DOCX_FIXTURE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "harness/doc-memo.docx",
);

const IMPORTER_ID = "media.paged.doc.importer.docx";
const OUTLINE_PANEL = "media.paged.doc.panel.outline";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// "Open…" — the id keeps the historic name; the picker's accept list is
// the importer-registry union, so this one door opens every registered
// format (file-commands.ts).
const OPEN_COMMAND = "paged.file.openIdml";

type CanvasGlobal = {
  __canvas: {
    ready: boolean;
    client: {
      documentMeta: () => Promise<{ dirty: boolean; pageCount: number }>;
      sceneTree: () => Promise<Array<{ kind?: string; children?: unknown[] }>>;
    };
    registries: {
      commands: { invoke: (id: string) => Promise<unknown> };
      importers: {
        list: () => Array<{
          id: string;
          title: string;
          extensions: readonly string[];
          mimeTypes?: readonly string[];
        }>;
        resolve: (name: string, mime?: string) => { id: string } | null;
      };
    };
    debugContext: () => {
      panels: { open: string[]; active: string | null };
    };
  };
};

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke(cmd),
    id,
  );

const openPanels = (page: Page) =>
  page.evaluate(() => {
    const p = (globalThis as unknown as CanvasGlobal).__canvas.debugContext()
      .panels;
    return [p.active, ...p.open].filter(Boolean) as string[];
  });

const meta = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client
      .documentMeta()
      .then((m) => ({ dirty: m.dirty, pageCount: m.pageCount })),
  );

const dirty = async (page: Page) => (await meta(page)).dirty;

/** Page items in the document (scene-tree nodes below spreads and pages). */
const itemCount = (page: Page) =>
  page.evaluate(async () => {
    const tree = await (
      globalThis as unknown as CanvasGlobal
    ).__canvas.client.sceneTree();
    let n = 0;
    const visit = (node: { kind?: string; children?: unknown[] }) => {
      if (node.kind && !["Spread", "Page"].includes(node.kind)) n++;
      for (const c of (node.children ?? []) as Array<typeof node>) visit(c);
    };
    for (const root of tree) visit(root);
    return n;
  });

/** Drop the Word fixture on the canvas, as a file dragged from the desktop. */
const dropDocx = (page: Page) =>
  page.evaluate(
    ({ bytes, mime }) => {
      const target = document.querySelector("[data-cockpit-canvas]");
      if (!target) throw new Error("no canvas drop target");
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "doc-memo.docx", { type: mime }),
      );
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    { bytes: Array.from(readFileSync(DOCX_FIXTURE)), mime: DOCX_MIME },
  );

/** Bundle activation is async after boot — poll the union until the doc
 *  importer has registered (startup-only wiring, the B-14/B-15 lesson). */
const resolveDocx = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.importers.resolve("doc-memo.docx")?.id ?? null,
  );

test.describe("plugin-doc — file entry (File▸Open importer union)", () => {
  test("AC-DOCFE-1 — the .docx importer joins the File▸Open union: extensions, MIME, and resolve() route to it @feat:plugin-doc.file-entry @level:happy", async ({
    page,
  }) => {
    await openCanvas(page);
    await expect
      .poll(() => resolveDocx(page), { timeout: 15_000 })
      .toBe(IMPORTER_ID);

    const probe = await page.evaluate(
      ({ importerId, mime }) => {
        const reg = (globalThis as unknown as CanvasGlobal).__canvas.registries
          .importers;
        const listed = reg.list().find((i) => i.id === importerId) ?? null;
        return {
          listed: listed
            ? {
                title: listed.title,
                extensions: [...listed.extensions],
                mimeTypes: [...(listed.mimeTypes ?? [])],
              }
            : null,
          // The union resolves by EXTENSION first (both Word forms)…
          byDocxName: reg.resolve("doc-memo.docx")?.id ?? null,
          byDotxName: reg.resolve("letterhead.dotx")?.id ?? null,
          // …then by MIME when the name claims nothing (drag-drop's lane).
          byMime: reg.resolve("word-payload.bin", mime)?.id ?? null,
        };
      },
      { importerId: IMPORTER_ID, mime: DOCX_MIME },
    );

    expect(probe.listed).not.toBeNull();
    expect(probe.listed?.extensions).toEqual(
      expect.arrayContaining([".docx", ".dotx"]),
    );
    expect(probe.listed?.mimeTypes).toContain(DOCX_MIME);
    expect(probe.byDocxName).toBe(IMPORTER_ID);
    expect(probe.byDotxName).toBe(IMPORTER_ID);
    expect(probe.byMime).toBe(IMPORTER_ID);
  });

  test("AC-DOCFE-2 — File▸Open with a picked .docx routes through the importer: ingest runs and the outline panel raises @feat:plugin-doc.file-entry @level:gesture", async ({
    page,
  }) => {
    await openCanvas(page);

    // A placement target must exist BEFORE the ingest (placeEmbedded pours
    // into the OPEN document); File▸New through the real command path.
    await invoke(page, "paged.file.new");
    await page.waitForFunction(
      () => (globalThis as unknown as CanvasGlobal).__canvas.ready === true,
      null,
      { timeout: 15_000 },
    );
    await expect
      .poll(() => resolveDocx(page), { timeout: 15_000 })
      .toBe(IMPORTER_ID);

    // Drive the ONE File▸Open door. Its pickFile input.click() fires
    // Playwright's filechooser; the command promise resolves only after the
    // routed importer's ingest completes (file-commands.ts awaits import()).
    const chooser = page.waitForEvent("filechooser");
    const opened = invoke(page, OPEN_COMMAND);
    await (await chooser).setFiles(DOCX_FIXTURE);
    await opened;

    // The importer (not the IDML loader) owned the file: the doc bundle's
    // ingest raised its outline panel over the retained LoweredDoc.
    await expect
      .poll(() => openPanels(page), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([OUTLINE_PANEL]));
    await expect(page.locator('[data-doc-panel="ready"]')).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("[data-doc-summary]")).toContainText(
      "paragraphs",
    );
    // F-08: the Word document opens clean, though the importer built it
    // with mutations after the open (styles, grow rules, the pour).
    expect(await dirty(page)).toBe(false);
    await expect(page.locator("[data-doc-title-bar]")).not.toContainText(
      "Edited",
    );
  });

  test("AC-DOCFE-3 — a dropped .docx opens clean, the first edit dirties it, and a drop on the edited document asks first @feat:plugin-doc.file-entry @level:gesture", async ({
    page,
  }) => {
    await openCanvas(page, { answerReplacePrompts: false });
    await expect
      .poll(() => resolveDocx(page), { timeout: 15_000 })
      .toBe(IMPORTER_ID);

    // Nothing open: the drop opens the Word file as the document.
    await dropDocx(page);
    await expect(page.locator('[data-doc-panel="ready"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(async () => (await meta(page)).pageCount, { timeout: 15_000 })
      .toBeGreaterThan(0);
    // F-08: clean once the import settled, and it stays clean.
    await expect.poll(() => dirty(page), { timeout: 5_000 }).toBe(false);
    await page.waitForTimeout(500);
    expect(await dirty(page)).toBe(false);
    await expect(page.locator("[data-doc-title-bar]")).not.toContainText(
      "Edited",
    );

    // The first real edit turns the flag on.
    await invoke(page, "paged.insert.rectangle");
    await expect.poll(() => dirty(page), { timeout: 5_000 }).toBe(true);
    await expect(page.locator("[data-doc-title-bar]")).toContainText("Edited");
    const before = await itemCount(page);

    // F-01 for Word: dropping a file on the edited document asks the
    // File ▸ Open question; Cancel keeps the document and its edit.
    const prompt = page.getByTestId("replace-document-dialog");
    await dropDocx(page);
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    await expect(prompt).toContainText("doc-memo.docx");
    await page.getByTestId("replace-document-keep").click();
    await expect(prompt).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await dirty(page)).toBe(true);
    expect(await itemCount(page)).toBe(before);

    // Don't save replaces it with the dropped file, which opens clean.
    await dropDocx(page);
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("replace-document-discard").click();
    await expect(prompt).toHaveCount(0);
    await expect
      .poll(() => itemCount(page), { timeout: 20_000 })
      .toBe(before - 1);
    await expect.poll(() => dirty(page), { timeout: 10_000 }).toBe(false);
  });
});
