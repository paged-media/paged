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

// A drop says what it will do (editor ADR 1205; interaction spec
// UXI-DND-001 to UXI-DND-004, UXI-FIL-001): the label at the pointer while
// dragging, then exactly that on the drop. Each test asserts the model and
// the history.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

import { openCanvas } from "../fidelity/canvas-driver";
import { fixturePath } from "./harness/fixtures";
import { screenPoint } from "./harness/viewport";

/** A 4 × 4 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==",
  "base64",
);

type Win = {
  __canvas: {
    ready: boolean;
    snapshotsReady: boolean;
    handle: { docId: string; pageIds: string[] } | null;
    client: {
      mutate(m: unknown): Promise<{
        kind: string;
        payload: { createdId?: { kind: string; id: string } | null };
      }>;
      undoLog(): Promise<{ undoLen: number }>;
      documentMeta(): Promise<{ pageCount: number; dirty: boolean }>;
      elementGeometry(
        ids: unknown[],
      ): Promise<{ id: { id: string }; hasImage?: boolean }[]>;
      sceneTree(): Promise<unknown[]>;
      setElementSelection(ids: unknown[], mode: string): Promise<unknown[]>;
    };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

const ZONE = "[data-cockpit-canvas]";

async function ready(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (globalThis as unknown as Win).__canvas;
          return c.ready && c.snapshotsReady && Boolean(c.handle);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** A blank page to drop on. */
async function blankDocument(page: Page): Promise<void> {
  await openCanvas(page, { answerReplacePrompts: false });
  await page.evaluate(() =>
    (globalThis as unknown as Win).__canvas.registries.commands.invoke(
      "paged.file.new",
    ),
  );
  await ready(page);
}

/** An empty graphic frame at page-local `[top, left, bottom, right]`. */
async function emptyFrame(
  page: Page,
  bounds: [number, number, number, number],
): Promise<{ kind: string; id: string }> {
  return page.evaluate(async (b) => {
    const c = (globalThis as unknown as Win).__canvas;
    const reply = await c.client.mutate({
      op: "insertFrame",
      args: { pageId: c.handle!.pageIds[0], bounds: b },
    });
    if (!reply.payload.createdId) throw new Error(`no frame: ${reply.kind}`);
    return reply.payload.createdId;
  }, bounds);
}

const hasImage = (page: Page, id: { kind: string; id: string }) =>
  page.evaluate(
    async (el) =>
      (
        await (globalThis as unknown as Win).__canvas.client.elementGeometry([
          el,
        ])
      )[0]?.hasImage === true,
    id,
  );

const facts = (page: Page) =>
  page.evaluate(async () => {
    const c = (globalThis as unknown as Win).__canvas;
    const meta = await c.client.documentMeta();
    const log = await c.client.undoLog();
    const tree = await c.client.sceneTree();
    let items = 0;
    const visit = (n: { kind?: string; children?: unknown[] }) => {
      if (n.kind && !["Spread", "Page"].includes(n.kind)) items++;
      for (const ch of (n.children ?? []) as Array<typeof n>) visit(ch);
    };
    for (const root of tree as Array<{ kind?: string; children?: unknown[] }>)
      visit(root);
    return {
      docId: c.handle?.docId ?? null,
      pages: meta.pageCount,
      dirty: meta.dirty,
      undo: log.undoLen,
      items,
    };
  });

/** Drag a file over the canvas to `(x, y)`, optionally dropping it. */
async function drag(
  page: Page,
  file: { name: string; type: string; bytes: number[] },
  at: { x: number; y: number },
  drop: boolean,
): Promise<void> {
  await page.evaluate(
    ({ file, at, drop, zone }) => {
      const target = document.querySelector(zone);
      if (!target) throw new Error("no drop zone");
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
      );
      const fire = (type: string) =>
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
            clientX: at.x,
            clientY: at.y,
          }),
        );
      fire("dragenter");
      fire("dragover");
      if (drop) fire("drop");
    },
    { file, at, drop, zone: ZONE },
  );
}

const png = { name: "photo.png", type: "image/png", bytes: [...PNG] };
const label = (page: Page) => page.locator("[data-drop-intent]");

test.describe("a drop says what it will do (editor ADR 1205)", () => {
  test("UXI-T62 — a picture dragged over an empty page shows Place and is placed there, nothing replaced @feat:images-graphics.placed-images @feat:editor-shell.file-intake @level:happy", async ({
    page,
  }) => {
    await blankDocument(page);
    const before = await facts(page);
    const at = await screenPoint(page, 300, 400);
    await drag(page, png, at, false);
    await expect(label(page)).toHaveAttribute("data-drop-intent", "place");
    await expect(label(page)).toContainText("Place photo.png");
    await drag(page, png, at, true);
    await expect(label(page)).toHaveCount(0);
    await expect
      .poll(async () => (await facts(page)).items)
      .toBe(before.items + 1);
    const after = await facts(page);
    expect(after.docId, "the document was not replaced").toBe(before.docId);
    expect(after.pages).toBe(before.pages);
    expect(after.undo).toBeGreaterThan(before.undo);
  });

  test("a picture dragged over an empty frame goes into THAT frame, not the selected one @feat:images-graphics.placed-images @level:edge", async ({
    page,
  }) => {
    await blankDocument(page);
    const selected = await emptyFrame(page, [400, 72, 520, 192]);
    const under = await emptyFrame(page, [100, 300, 260, 460]);
    await page.evaluate(
      (id) =>
        (globalThis as unknown as Win).__canvas.client.setElementSelection(
          [id],
          "replace",
        ),
      selected,
    );
    const before = await facts(page);
    const at = await screenPoint(page, 380, 180);
    await drag(page, png, at, false);
    await expect(label(page)).toHaveAttribute(
      "data-drop-intent",
      "place-in-frame",
    );
    await expect(page.locator("[data-drop-target-frame]")).toBeVisible();
    await drag(page, png, at, true);
    await expect.poll(() => hasImage(page, under)).toBe(true);
    expect(await hasImage(page, selected)).toBe(false);
    const after = await facts(page);
    expect(after.items, "no frame was minted").toBe(before.items);
    expect(after.undo).toBe(before.undo + 1);
  });

  test("UXI-T63 — a document dropped on an edited one asks first; Cancel keeps the edits @feat:editor-shell.file-intake @level:edge", async ({
    page,
  }) => {
    await blankDocument(page);
    await emptyFrame(page, [100, 100, 200, 200]);
    await expect.poll(async () => (await facts(page)).dirty).toBe(true);
    const before = await facts(page);
    const idml = {
      name: "geometry.idml",
      type: "",
      bytes: [...readFileSync(fixturePath("geometry"))],
    };
    const at = await screenPoint(page, 300, 400);
    await drag(page, idml, at, false);
    await expect(label(page)).toHaveAttribute(
      "data-drop-intent",
      "replace-document",
    );
    await expect(page.locator("[data-drop-reason]")).toHaveText(
      "You will be asked to save your changes first.",
    );
    await drag(page, idml, at, true);
    const dialog = page.getByTestId("replace-document-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("replace-document-keep").click();
    await expect(dialog).toBeHidden();
    expect(await facts(page)).toEqual(before);
  });

  test("UXI-T64 — an unsupported file is refused with the reason; nothing changes @feat:editor-shell.file-intake @level:edge", async ({
    page,
  }) => {
    await blankDocument(page);
    await emptyFrame(page, [100, 100, 200, 200]);
    const before = await facts(page);
    const txt = {
      name: "notes.txt",
      type: "text/plain",
      bytes: [...Buffer.from("notes")],
    };
    const at = await screenPoint(page, 300, 400);
    await drag(page, txt, at, false);
    await expect(label(page)).toHaveAttribute("data-drop-intent", "reject");
    await expect(label(page)).toContainText("Paged cannot open .txt files");
    await expect(page.locator("[data-drop-reason]")).toContainText(
      "It opens Paged and InDesign (IDML) documents",
    );
    await drag(page, txt, at, true);
    await expect(page.locator("body")).toContainText(
      "Paged cannot open .txt files.",
    );
    expect(await facts(page)).toEqual(before);
  });
});
