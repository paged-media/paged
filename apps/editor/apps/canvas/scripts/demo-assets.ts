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

// The demos' template files (demos/assets/*.paged): the same builders the
// in-page demos run (src/demos/templates.ts), on a headless engine through
// the Node CLI's session, saved as .paged. The iframe demo loads them, since
// a host page driving a frame has no engine client of its own. The price
// list's fields belong to paged.sheet, paged.doc and paged.draw, so it is
// built here with those modules loaded (their wasm built first:
// `moon run sheet:wasm doc:wasm draw:wasm`); the PDF/X-4 demo's output
// intent is a profile computed in `demo-files.ts`.
//
//   bun scripts/demo-assets.ts   # write demos/assets/*

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { openSession } from "../../../../cli/src/session";
import {
  demoCmykProfile,
  priceNoteDocx,
  priceWorkbookXlsx,
} from "./demo-files";
import {
  businessCard,
  postcard,
  type TemplateHost,
} from "../src/demos/templates";

const OUT = join(import.meta.dir, "../demos/assets");
const REPO = join(import.meta.dir, "../../../../..");
const bundle = (m: string) =>
  join(REPO, `modules/${m}/packages/${m}-bundle/src/index.ts`);
const BUILDERS: Record<string, (h: TemplateHost) => Promise<void>> = {
  "business-card": businessCard,
  postcard,
};

for (const [name, build] of Object.entries(BUILDERS)) {
  const s = await openSession(null, { plugins: [] });
  try {
    const client = s.driver.editor
      .client as unknown as TemplateHost["client"] & {
      send(m: unknown): Promise<unknown>;
    };
    await build({
      client,
      async setRole(role) {
        await client.send({
          kind: "setSessionPolicy",
          payload: { policy: { role, overrides: [] } },
        });
      },
      async newDocument(width, height) {
        await s.h.newBlank(width, height);
      },
    });
    const { bytes } = await s.exportBytes("paged");
    writeFileSync(join(OUT, `${name}.paged`), bytes);
    console.log(`demo-assets: wrote ${name}.paged (${bytes.byteLength} bytes)`);
  } finally {
    s.dispose();
  }
}

// ───────────────────────────────────────── the price list (module fields)

const SHEET = "media.paged.sheet";

/** A price list (A5): a fixed title, the prices placed from a workbook (a
 *  `sheet.range` field) and the week's offer, one cell (`sheet.cell`),
 *  a text block placed from a Word document (`doc.blockText`) and a
 *  coloured band (`draw.paint`). Nothing else is open to a filler. */
async function priceList(): Promise<Uint8Array> {
  const s = await openSession(null, {
    plugins: [bundle("sheet"), bundle("doc"), bundle("draw")],
  });
  try {
    const send = (kind: string, payload: unknown) =>
      s.h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
        payload: { createdId?: { kind: string; id: string }; error?: unknown };
      }>;
    const mutate = async (m: unknown) => {
      const r = await send("mutate", m);
      if (r.kind !== "mutationApplied")
        throw new Error(
          `price list: ${JSON.stringify(m).slice(0, 200)} → ${JSON.stringify(r.payload.error)}`,
        );
      return r;
    };
    const invoke = (id: string, args: unknown) =>
      s.h.objects.invoke(id as never, args) as Promise<Record<string, string>>;
    // A placed range is a window on the sheet: resizing it would show more
    // cells, so a placement is moved, its size kept.
    const moveTo = async (frameId: string, top: number, left: number) => {
      const got = await s.h.objects.get(
        `textFrame:${frameId}` as never,
        "frameBounds",
      );
      const [t, l, b, r] = (got as { value: number[] }).value as [
        number,
        number,
        number,
        number,
      ];
      await mutate({
        op: "resizeFrame",
        args: { frameId, bounds: [top, left, top + b - t, left + r - l] },
      });
    };
    const [pageId] = await s.h.newBlank(420, 595);
    await send("setSessionPolicy", { policy: { role: "author" } });

    for (const [selfId, value] of [
      ["Color/Leaf", [60, 0, 90, 10]],
      ["Color/Berry", [10, 90, 30, 10]],
      ["Color/Sun", [0, 30, 95, 0]],
    ] as const) {
      await mutate({
        op: "createSwatch",
        args: { spec: { selfId, name: selfId.slice(6), space: "CMYK", value } },
      });
    }
    const band = await mutate({
      op: "insertFrame",
      args: { pageId, bounds: [0, 0, 64, 420] },
    });
    const bandId = band.payload.createdId!;
    await mutate({
      op: "setElementProperty",
      args: {
        elementId: bandId,
        path: "frameFillColor",
        value: { type: "colorRef", value: "Color/Leaf" },
      },
    });
    await mutate({
      op: "insertTextFrame",
      args: { pageId, bounds: [84, 36, 120, 384] },
    });
    const titleStory = (
      await s.h.host.editor.client.collection<{ selfId: string }>(
        "stories" as never,
      )
    ).at(-1)!.selfId;
    await mutate({
      op: "insertText",
      args: { storyId: titleStory, offset: 0, text: "Market prices this week" },
    });

    await invoke(`${SHEET}.command.importXlsx`, {
      bytes: priceWorkbookXlsx(),
      name: "prices.xlsx",
    });
    const table = await invoke(`${SHEET}.command.lowerToFrame`, {
      range: "Prices!A1:B5",
    });
    const tableId = table.frame!.replace("textFrame:", "");
    await moveTo(tableId, 140, 36);
    const offer = await invoke(`${SHEET}.command.lowerToFrame`, {
      range: "Offer!A1:A2",
    });
    const offerId = offer.frame!.replace("textFrame:", "");
    await moveTo(offerId, 140, 250);

    const placed = await invoke("media.paged.doc.command.placeDoc", {
      bytes: priceNoteDocx(),
      fileName: "note.docx",
    });
    const noteId = placed.frame!.split(":")[1]!;
    await mutate({
      op: "resizeFrame",
      args: { frameId: noteId, bounds: [300, 36, 400, 384] },
    });

    const field = (
      elementId: { kind: string; id: string },
      name: string,
      label: string,
      kind: string,
      grants: string[],
      def: unknown,
    ) =>
      mutate({
        op: "setPluginMetadata",
        args: {
          elementId,
          key: "x-paged:template",
          value: JSON.stringify({
            v: 1,
            data: {
              field: {
                name,
                label,
                kind: "module",
                constraints: {},
                module: { kind, grants, def },
              },
            },
          }),
        },
      });
    await field(
      { kind: "textFrame", id: tableId },
      "prices",
      "Prices",
      `${SHEET}.range`,
      ["text.edit", "text.style"],
      { ref: "Prices!A2:B5", columns: ["Fruit", "Price"], rows: "fixed" },
    );
    await field(
      { kind: "textFrame", id: offerId },
      "offer",
      "Offer of the week",
      `${SHEET}.cell`,
      ["text.edit", "text.style"],
      { ref: "Offer!A2", allowed: ["Apples", "Pears", "Plums", "Figs"] },
    );
    await field(
      { kind: "textFrame", id: noteId },
      "note",
      "Note",
      "media.paged.doc.blockText",
      ["text.edit"],
      { anchor: { bookmark: "note" } },
    );
    await field(
      bandId,
      "accent",
      "Colour",
      "media.paged.draw.paint",
      ["appearance.fill"],
      { channel: "fill", allowed: ["Leaf", "Berry", "Sun"] },
    );
    await mutate({
      op: "setDocumentMetadata",
      args: {
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            order: ["prices", "offer", "note", "accent"],
            defaults: ["document.metadata"],
          },
        }),
      },
    });
    // The workbook part is saved after a short debounce: let it land.
    await new Promise((r) => setTimeout(r, 1200));
    return (await s.exportBytes("paged")).bytes;
  } finally {
    s.dispose();
  }
}

const list = await priceList();
writeFileSync(join(OUT, "price-list.paged"), list);
console.log(`demo-assets: wrote price-list.paged (${list.byteLength} bytes)`);
const icc = demoCmykProfile("paged demo CMYK (naive ink model)");
writeFileSync(join(OUT, "demo-cmyk.icc"), icc);
console.log(`demo-assets: wrote demo-cmyk.icc (${icc.byteLength} bytes)`);
