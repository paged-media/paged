/*
 * This file is part of paged (https://paged.media).
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

// Doc ADR 625 amendment — embedded placement by the Rust batch against the
// TypeScript pour, on the REAL engine: the same Word document placed into the
// same empty document both ways must hold the same text, the same paragraph
// styles and lay out the same (every paragraph's selection rectangles, the page
// count); the native placement names no invented style; and one undo takes
// either placement back.

import { afterEach, describe, expect, it } from "bun:test";

import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";

import { docBundle } from "../../src";
import { DocEngine } from "../../src/engine";
import { NATIVE_PLACE, placeEmbedded } from "../../src/place";
import {
  ENGINE_ANCHOR,
  docxPresent,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — placement batch");

type Reply = { kind: string; payload?: any };

interface Placed {
  h: HeadlessHost;
  native: boolean;
  offered: boolean;
  refusal: string;
  applyError: string;
  paras: Array<{
    text: string;
    style: string | null;
  }>;
  pages: number;
  cells: string[];
  styles: string[];
  stories: number;
  undone: { stories: number };
}

async function place(name: string, native: boolean): Promise<Placed> {
  const bytes = fixture(name);
  const h = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    console: silent,
  });
  await h.newBlank(612, 792);
  // The bundle owns its metadata namespace, as in the editor.
  h.loadBundle(docBundle);
  const send = (m: unknown) =>
    h.host.editor.client.send(m as never) as Promise<Reply>;
  const script = async (s: string) => {
    const r = await send({ kind: "executeScript", payload: { source: s } });
    return JSON.parse(r.payload?.output?.[0] ?? "[]");
  };
  const storyCount = async () =>
    ((await script("paged.stories()")) as unknown[]).length;
  const engine = await DocEngine.boot();
  let isNative = false;
  let appliedNative = false;
  let refusal = "";
  NATIVE_PLACE.lastError = "";
  let placed;
  try {
    engine.loadDocx(bytes);
    const ir = engine.lowered();
    const offer = engine.placeBatch("$h:docFrame");
    isNative = !("reason" in offer);
    if ("reason" in offer) refusal = offer.reason;
    NATIVE_PLACE.enabled = native;
    placed = await placeEmbedded(h.host, ir, bytes, name, engine);
  } finally {
    NATIVE_PLACE.enabled = true;
    engine.dispose();
  }
  appliedNative = placed!.native === true;
  const storyId = placed!.storyId!;
  const stories = await storyCount();
  const styles = (
    (await h.host.document.collection<{ selfId: string }>(
      "paragraphStyles",
    )) as Array<{ selfId: string }>
  ).map((s) => s.selfId);
  let last = -1;
  let pageIds: string[] = [];
  for (let i = 0; i < 100; i++) {
    const ps = (await script("paged.pages()")) as Array<{ selfId: string }>;
    for (const p of ps) {
      await send({
        kind: "requestPage",
        payload: { pageId: p.selfId, lod: "live" },
      });
    }
    pageIds = ps.map((p) => p.selfId);
    if (ps.length === last) break;
    last = ps.length;
  }
  const cells: string[] = [];
  try {
    for (const t of await h.objects.query(`story:${storyId} > table`)) {
      const id = t.replace(/^table:/, "");
      for (let row = 0; row < 50; row++) {
        for (let col = 0; col < 50; col++) {
          let read;
          try {
            read = await h.objects.get(`cell:${id}/${row},${col}`, "text");
          } catch {
            break;
          }
          if (read.kind !== "value") break;
          cells.push(`${row},${col}=${String(read.value)}`);
        }
      }
    }
  } catch {
    /* no object model for tables: the text compare stands */
  }
  const paras: Placed["paras"] = [];
  const r = await send({
    kind: "requestStoryContent",
    payload: { storyId },
  });
  const content: Array<{
    paragraphStyle?: string;
    runs: Array<{ text: string }>;
  }> = r.payload?.content?.paragraphs ?? [];
  for (const p of content) {
    paras.push({
      text: p.runs.map((x) => x.text).join(""),
      style: p.paragraphStyle ?? null,
    });
  }
  // One undo step takes the placement back: the frame is gone.
  const probes = async () => {
    const out: string[] = [];
    for (const q of ["page:usp > *", `story:${storyId} > *`]) {
      try {
        out.push(`${q} => ${JSON.stringify(await h.objects.query(q))}`);
      } catch (e) {
        out.push(`${q} => ${String(e).slice(0, 80)}`);
      }
    }
    for (const c of ["textFrames", "frames", "stories"]) {
      try {
        out.push(
          `${c} => ${JSON.stringify(await h.host.document.collection(c as never)).slice(0, 160)}`,
        );
      } catch (e) {
        out.push(`${c} => ${String(e).slice(0, 60)}`);
      }
    }
    return out;
  };
  const beforeUndo = await probes();
  await h.host.document.undo();
  const afterUndo = await probes();
  console.warn(
    `undo ${name}\n${beforeUndo.join("\n")}\n--\n${afterUndo.join("\n")}`,
  );
  const undone = { stories: await storyCount() };
  return {
    h,
    native: isNative && appliedNative,
    offered: isNative,
    refusal,
    applyError: NATIVE_PLACE.lastError,
    paras,
    cells,
    pages: pageIds.length,
    styles,
    stories,
    undone,
  };
}

// Paragraph-only fixtures the batch builder takes (the slices that add tables,
// pictures, fields, lists, hyperlinks, notes and comments extend this list).
const FIXTURES = [
  "direct-format.docx",
  "template-letter.docx",
  "structure.docx",
  // Slice 3: hyperlinks, fields, lists, drop caps, bookmarks.
  "hyperlink-body.docx",
  "field-body.docx",
  "list-body.docx",
  "drop-cap.docx",
];

// Documents the builder may still refuse (the pour then places them, and
// the result must be the same); the refusal is logged.
const OPTIONAL_FIXTURES = [
  "toc-body.docx",
  "merge-letter.docx",
  "review-body.docx",
  "cell-comment.docx",
  "breaks-body.docx",
];

// Slice 2: tables (cell text and styles, spans, row heights, borders and
// fill, nested tables). A cell holds no model range for direct formatting,
// so the styles the lowering invented for cell text stay in the document.
const TABLE_FIXTURES = [
  "table-body.docx",
  "price-table.docx",
  "objects-table-look.docx",
  "objects-nested-tables.docx",
];

describe.skipIf(!docxPresent)(
  "doc headless — placement batch (ADR 625)",
  () => {
    const opened: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of opened.splice(0)) h.dispose();
    });

    for (const name of [...FIXTURES, ...TABLE_FIXTURES, ...OPTIONAL_FIXTURES]) {
      const tabled = TABLE_FIXTURES.includes(name);
      it(`${name}: the Rust batch places what the pour places`, async () => {
        const old = await place(name, false);
        const now = await place(name, true);
        opened.push(old.h, now.h);
        // Every fixture listed is one the builder takes whole, and the batch
        // it offers is the batch the engine applies.
        if (OPTIONAL_FIXTURES.includes(name)) {
          console.warn(`placement batch ${name}: ${now.refusal || "taken"}`);
        } else {
          expect(now.refusal).toBe("");
          expect([now.native, now.applyError]).toEqual([true, ""]);
        }
        expect(now.paras.map((p) => p.text)).toEqual(
          old.paras.map((p) => p.text),
        );
        expect(now.pages).toBe(old.pages);
        expect(now.cells).toEqual(old.cells);
        // The native placement holds no style the lowering invented.
        const auto = (x: Placed) =>
          x.styles.filter((s) => s.includes("docx-auto"));
        if (tabled || !now.native) {
          expect(auto(old)).toEqual(expect.arrayContaining(auto(now)));
        } else {
          expect(auto(now)).toEqual([]);
        }
        expect(now.stories).toBe(old.stories);
      }, 120_000);
    }
  },
);
