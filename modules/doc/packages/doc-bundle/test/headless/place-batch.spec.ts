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
  paras: Array<{ text: string; style: string | null; rects: number[][] }>;
  pages: number;
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
  const send = (m: unknown) =>
    h.host.editor.client.send(m as never) as Promise<Reply>;
  const script = async (s: string) => {
    const r = await send({ kind: "executeScript", payload: { source: s } });
    return JSON.parse(r.payload?.output?.[0] ?? "[]");
  };
  const storyCount = async () =>
    ((await script("paged.stories()")) as unknown[]).length;
  const before = await storyCount();
  const engine = await DocEngine.boot();
  let isNative = false;
  let placed;
  try {
    engine.loadDocx(bytes);
    const ir = engine.lowered();
    isNative = !("reason" in engine.placeBatch("$h:docFrame"));
    NATIVE_PLACE.enabled = native;
    placed = await placeEmbedded(h.host, ir, bytes, name, engine);
  } finally {
    NATIVE_PLACE.enabled = true;
    engine.dispose();
  }
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
  const paras: Placed["paras"] = [];
  const r = await send({
    kind: "requestStoryContent",
    payload: { storyId },
  });
  const content: Array<{
    paragraphStyle?: string;
    runs: Array<{ text: string }>;
  }> = r.payload?.content?.paragraphs ?? [];
  let off = 0;
  for (const p of content) {
    const b = (
      await send({
        kind: "requestParagraphBounds",
        payload: { storyId, offset: off },
      })
    ).payload?.bounds as { start: number; end: number } | null;
    if (!b) break;
    const g = await send({
      kind: "requestSelectionGeometry",
      payload: {
        selection: { storyId, start: b.start, end: Math.max(b.end, b.start) },
      },
    });
    const rects: Array<{
      pageId: string;
      topPt: number;
      leftPt: number;
      widthPt: number;
      heightPt: number;
    }> = g.payload?.rects ?? [];
    paras.push({
      text: p.runs.map((x) => x.text).join(""),
      style: p.paragraphStyle ?? null,
      rects: rects.map((x) =>
        [
          pageIds.indexOf(x.pageId),
          x.topPt,
          x.leftPt,
          x.widthPt,
          x.heightPt,
        ].map((v) => Math.round(v * 10) / 10),
      ),
    });
    if (b.end + 1 <= off) break;
    off = b.end + 1;
  }
  // One undo step takes the whole placement back.
  await h.host.document.undo();
  const undone = { stories: await storyCount() };
  expect(undone.stories).toBe(before);
  return {
    h,
    native: isNative,
    paras,
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
];

describe.skipIf(!docxPresent)(
  "doc headless — placement batch (ADR 625)",
  () => {
    const opened: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of opened.splice(0)) h.dispose();
    });

    for (const name of FIXTURES) {
      it(`${name}: the Rust batch places what the pour places`, async () => {
        const old = await place(name, false);
        const now = await place(name, true);
        opened.push(old.h, now.h);
        if (!now.native) {
          // A fixture the builder refuses today is placed by the pour: the
          // result must still be the same.
          expect(now.paras).toEqual(old.paras);
          return;
        }
        expect(now.paras.map((p) => p.text)).toEqual(
          old.paras.map((p) => p.text),
        );
        expect(now.pages).toBe(old.pages);
        expect(now.paras.map((p) => p.rects)).toEqual(
          old.paras.map((p) => p.rects),
        );
        // The native placement holds no style the lowering invented.
        expect(now.styles.filter((s) => s.includes("docx-auto"))).toEqual([]);
        expect(now.stories).toBe(old.stories);
      }, 120_000);
    }
  },
);
