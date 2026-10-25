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

// The real-document pagination measurement (docs/reference/acceptance-real-
// docx.md) on the headless host: the REAL engine and docx-js, the bundle's
// standalone open, then per paragraph of every story the pages its lines
// land on and one rect per line — the same JSON the editor-driven
// scripts/real-docx/measure.spec.ts writes, so scripts/real-docx/compare.py
// reads either. NOT a CI suite: the documents are a private corpus and the
// fonts this machine's; it runs only when REAL_DOCX names files.
//
//   REAL_DOCX=/abs/a.docx,/abs/b.docx REAL_OUT=/abs/dir REAL_FONTS=word \
//   REAL_COMPOSER="HL Single" bun test test/headless/real-docx-measure.spec.ts
//
// REAL_FONTS=word registers Word's own faces (local font files, after the
// open: the engine re-measures what a late font changes). REAL_COMPOSER
// overrides the composer the lowering chose on the root Word style (the
// "before" of a composer change). REAL_DEBUG=1 prints the bundle's warnings
// and each story's paragraph count.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import {
  createHeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";

import { docBundle } from "../../src";
import { DocEngine } from "../../src/engine";
import { finishStandalone } from "../../src/open";
import { ENGINE_ANCHOR, docxPresent } from "../conformance/harness";

const DOCS = (process.env.REAL_DOCX ?? "").split(",").filter(Boolean);
const OUT = process.env.REAL_OUT ?? ".";
const FONTS = process.env.REAL_FONTS ?? "none";
const COMPOSER = process.env.REAL_COMPOSER ?? "";
const DF = "/Applications/Microsoft Word.app/Contents/Resources/DFonts";
const SUPP = "/System/Library/Fonts/Supplemental";
const WORD_FACES: Array<[string, string | null, string]> = [
  ["Times New Roman", null, `${DF}/times.ttf`],
  ["Times New Roman", "Bold", `${DF}/timesbd.ttf`],
  ["Times New Roman", "Italic", `${DF}/timesi.ttf`],
  ["Times New Roman", "Bold Italic", `${DF}/timesbi.ttf`],
  ["Arial", null, `${DF}/arial.ttf`],
  ["Arial", "Bold", `${DF}/arialbd.ttf`],
  ["Arial", "Italic", `${DF}/ariali.ttf`],
  ["Arial", "Bold Italic", `${DF}/arialbi.ttf`],
  ["Calibri", null, `${DF}/Calibri.ttf`],
  ["Calibri", "Bold", `${DF}/Calibrib.ttf`],
  ["Calibri", "Italic", `${DF}/Calibrii.ttf`],
  ["Calibri", "Bold Italic", `${DF}/Calibriz.ttf`],
  ["Verdana", null, `${DF}/Verdana.ttf`],
  ["Verdana", "Bold", `${DF}/Verdana Bold.ttf`],
  ["Tahoma", null, `${DF}/tahoma.ttf`],
  ["Tahoma", "Bold", `${DF}/tahomabd.ttf`],
  ["Century", null, `${DF}/Century.ttf`],
  ["Lucida Sans Unicode", null, `${DF}/Lucida Sans Unicode.ttf`],
  ["Lucida Sans", null, `${DF}/Lucida Sans.ttf`],
  ["Symbol", null, `${DF}/symbol.ttf`],
  ["Wingdings", null, `${DF}/Wingdings.ttf`],
  ["Courier New", null, `${SUPP}/Courier New.ttf`],
  ["Courier New", "Bold", `${SUPP}/Courier New Bold.ttf`],
  ["Arial Unicode MS", null, `${SUPP}/Arial Unicode.ttf`],
];
if (process.env.REAL_TIMES_DIR) {
  const T = process.env.REAL_TIMES_DIR;
  WORD_FACES.push(
    ["Times", null, `${T}/Times-Regular.ttf`],
    ["Times", "Bold", `${T}/Times-Bold.ttf`],
    ["Times", "Italic", `${T}/Times-Italic.ttf`],
    ["Times", "Bold Italic", `${T}/Times-BoldItalic.ttf`],
  );
}

type Reply = { kind: string; payload?: any };

describe.skipIf(DOCS.length === 0 || !docxPresent)(
  "real-docx measure (headless)",
  () => {
    for (const DOC of DOCS) {
      test(
        `measure ${basename(DOC)}`,
        async () => {
          const bytes = new Uint8Array(readFileSync(DOC));
          const name = basename(DOC);
          const h = await createHeadlessHost({
            resolveFrom: ENGINE_ANCHOR,
            console: process.env.REAL_DEBUG ? console : silent,
          });
          const engine = await DocEngine.boot();
          const t0 = Date.now();
          try {
            engine.loadDocx(bytes);
            const ir = engine.lowered();
            await h.load(engine.skeletonPaged(name));
            h.loadBundle(docBundle);
            await finishStandalone(h.host, engine, ir, bytes, name, (paged) =>
              h.load(paged),
            );
          } finally {
            engine.dispose();
          }
          const send = (m: unknown) =>
            h.host.editor.client.send(m as never) as Promise<Reply>;
          const script = async (s: string) => {
            const r = await send({
              kind: "executeScript",
              payload: { source: s },
            });
            return JSON.parse(r.payload?.output?.[0] ?? "[]");
          };
          if (COMPOSER) {
            const r = await send({
              kind: "mutate",
              payload: {
                op: "setStyleProperty",
                args: {
                  collection: "paragraph",
                  styleId: "ParagraphStyle/docx-Default",
                  path: "paragraphComposer",
                  value: { type: "text", value: COMPOSER },
                },
              },
            });
            expect(r.kind).toBe("mutationApplied");
          }
          if (FONTS === "word") {
            for (const [family, style, file] of WORD_FACES) {
              if (!existsSync(file)) continue;
              await send({
                kind: "registerFont",
                payload: {
                  family,
                  style,
                  bytes: Array.from(readFileSync(file)),
                },
              });
            }
          }
          // Settle: ask for every page until the page count stops moving (the
          // editor's pages are requested as they scroll into view).
          let last = -1;
          for (let i = 0; i < 200; i++) {
            const ps = (await script("paged.pages()")) as Array<{
              selfId: string;
            }>;
            for (const p of ps) {
              await send({
                kind: "requestPage",
                payload: { pageId: p.selfId, lod: "live" },
              });
            }
            if (ps.length === last) break;
            last = ps.length;
          }
          const openMs = Date.now() - t0;
          const pages = (await script("paged.pages()")) as Array<
            Record<string, unknown>
          >;
          const pageIds = pages.map((p) => p.selfId as string);
          const stories = (await script("paged.stories()")) as Array<{
            selfId: string;
          }>;
          const out: unknown[] = [];
          for (const { selfId } of stories) {
            const r = await send({
              kind: "requestStoryContent",
              payload: { storyId: selfId },
            });
            const content: Array<{
              paragraphStyle?: string;
              runs: Array<{ text: string }>;
            }> = r.payload?.content?.paragraphs ?? [];
            const paras: unknown[] = [];
            let off = 0;
            for (let i = 0; i < content.length; i++) {
              const b = (
                await send({
                  kind: "requestParagraphBounds",
                  payload: { storyId: selfId, offset: off },
                })
              ).payload?.bounds as { start: number; end: number } | null;
              if (!b) break;
              const g = await send({
                kind: "requestSelectionGeometry",
                payload: {
                  selection: {
                    storyId: selfId,
                    start: b.start,
                    end: Math.max(b.end, b.start),
                  },
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
                text: content[i].runs.map((x) => x.text).join(""),
                style: content[i].paragraphStyle,
                start: b.start,
                end: b.end,
                pages: [
                  ...new Set(rects.map((x) => pageIds.indexOf(x.pageId))),
                ],
                top: rects.length ? rects[0].topPt : null,
                lines: new Set(
                  rects.map((x) => `${x.pageId}@${Math.round(x.topPt)}`),
                ).size,
                rects: rects.map((x) =>
                  [
                    pageIds.indexOf(x.pageId),
                    x.topPt,
                    x.leftPt,
                    x.widthPt,
                    x.heightPt,
                  ].map((v) => Math.round(v * 100) / 100),
                ),
              });
              if (b.end + 1 <= off) break;
              off = b.end + 1;
            }
            if (process.env.REAL_DEBUG) {
              const fc = await send({
                kind: "requestFrameChain",
                payload: { storyId: selfId },
              });
              console.log(
                selfId,
                "content",
                content.length,
                "walked",
                paras.length,
                "frames",
                JSON.stringify(fc.payload).slice(0, 300),
              );
            }
            out.push({ storyId: selfId, paras });
          }
          const mode = `${FONTS}${COMPOSER ? `-${COMPOSER.replace(/\W+/g, "")}` : ""}`;
          writeFileSync(
            `${OUT}/${basename(DOC, ".docx").replace(/\./g, "_")}.ours.${mode}.json`,
            JSON.stringify(
              { doc: DOC, fontMode: mode, openMs, pages, stories: out },
              null,
              1,
            ),
          );
          console.log(
            `${name}: ${pages.length} pages, ${stories.length} stories, ${openMs} ms`,
          );
          h.dispose();
        },
        30 * 60_000,
      );
    }
  },
);
