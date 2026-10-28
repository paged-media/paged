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

// Word's first-fit, end to end (ADR 617, engine ADR 1016): the first-fit
// probe document (`docx_conformance::first_fit_docx()`, dumped as
// test/fixtures/first-fit.docx) opened through the bundle's standalone open
// on the REAL engine, every paragraph's lines held against the lines Word 16
// set (docx-conformance/fixtures/first-fit.word.json): the words on each
// line, and the baseline steps of the picture cases under single, 1.5-line
// and at-least spacing.
//
// Word set the probe in Courier New. Where the machine has the face (macOS
// ships it) it is registered and both the words and the line steps are
// compared. Elsewhere JetBrains Mono, which advances every glyph 0.6 em as
// Courier New does 0.6001 em, stands in under Courier New's name: the words
// are compared (except the two cases whose measure is a whole number of the
// stand-in's characters), the heights are not (its ascent is not Courier
// New's).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  docxPresent,
  type OpenedDoc,
  openDoc,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — Word's first-fit lines");

const COURIER = "/System/Library/Fonts/Supplemental/Courier New.ttf";
// FIRST_FIT_STAND_IN=1 takes the stand-in even where the face is installed.
const REAL_FACE = existsSync(COURIER) && !process.env.FIRST_FIT_STAND_IN;
const STAND_IN = fileURLToPath(
  new URL(
    "../../../../../../engine/core/corpus/fonts/JetBrainsMono-VF.ttf",
    import.meta.url,
  ),
);
const ANSWER = JSON.parse(
  readFileSync(
    new URL(
      "../../../../docx-conformance/fixtures/first-fit.word.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  cases: Array<{
    label: string;
    picture: [number, number] | null;
    spacing: { line: number; rule: string } | null;
    word_lines: Array<{
      page: number;
      top_pt: number;
      words: Array<{ t: string }>;
    }>;
  }>;
};
// 468 pt holds 77 Courier New characters (77.99) but 78 of the stand-in's.
const STAND_IN_DIFFERS = new Set(["L01", "L02"]);
// Word positions lines on a grid of about a quarter point (its 11.33 pt
// single lines step 11.25 and 11.5 in the PDF).
const WORD_GRID = 0.3;

type Reply = { kind: string; payload?: any };

/** A laid-out line: its words and its baseline (page index, pt). */
interface Line {
  words: string[];
  page: number;
  baseline: number;
}

describe.skipIf(!docxPresent)(
  "doc headless — Word's first-fit lines @feat:plugin-doc.word-pagination",
  () => {
    let doc: OpenedDoc;
    let paras: Line[][] = [];

    beforeAll(async () => {
      doc = await openDoc("first-fit.docx");
      const send = (m: unknown) =>
        doc.h.host.editor.client.send(m as never) as Promise<Reply>;
      const script = async (s: string) => {
        const r = await send({ kind: "executeScript", payload: { source: s } });
        return JSON.parse(r.payload?.output?.[0] ?? "[]");
      };
      await send({
        kind: "registerFont",
        payload: {
          family: "Courier New",
          style: null,
          bytes: Array.from(readFileSync(REAL_FACE ? COURIER : STAND_IN)),
        },
      });
      // Settle: ask for every page until the count stops moving.
      let last = -1;
      for (let i = 0; i < 50; i++) {
        const ps = (await script("paged.pages()")) as Array<{ selfId: string }>;
        for (const p of ps) {
          await send({
            kind: "requestPage",
            payload: { pageId: p.selfId, lod: "live" },
          });
        }
        if (ps.length === last) break;
        last = ps.length;
      }
      const pageIds = (
        (await script("paged.pages()")) as Array<{ selfId: string }>
      ).map((p) => p.selfId);
      const storyId = doc.opened.storyIds[0]!;
      const content = (
        await send({ kind: "requestStoryContent", payload: { storyId } })
      ).payload?.content?.paragraphs as Array<{
        runs: Array<{ text: string }>;
      }>;
      let off = 0;
      for (let i = 0; i < content.length; i++) {
        const b = (
          await send({
            kind: "requestParagraphBounds",
            payload: { storyId, offset: off },
          })
        ).payload?.bounds as { start: number; end: number };
        const text = content[i]!.runs.map((r) => r.text).join("");
        const bytes = new TextEncoder().encode(text);
        const lines: Line[] = [];
        let at = b.start;
        while (at < b.end) {
          const bounds = async (offset: number) =>
            (
              await send({
                kind: "requestLineBounds",
                payload: { storyId, offset },
              })
            ).payload?.bounds as { lineStart: number; lineEnd: number };
          // Where a line breaks inside a word (after a hyphen, a dash, a
          // split word) its end is the next line's start, and the offset
          // answers for the line before: ask one character further.
          let lb = await bounds(at);
          if (lb.lineStart < at) lb = await bounds(at + 1);
          const end = Math.max(lb.lineEnd, at + 1);
          const g = (
            await send({
              kind: "requestSelectionGeometry",
              payload: { selection: { storyId, start: at, end } },
            })
          ).payload?.rects as Array<{
            pageId: string;
            topPt: number;
            heightPt: number;
          }>;
          // The line's rect is its leading box: the baseline is 0.8 of it
          // down (`LineLayout::ascent_pt`). The previous line ends where
          // this one starts, so its rect comes first: take the last.
          const r = g[g.length - 1]!;
          // A picture's U+FFFC is no word of Word's PDF text.
          const words = new TextDecoder()
            .decode(bytes.slice(at - b.start, end - b.start))
            .split(/\s+/)
            .filter((w) => w && w !== "￼");
          lines.push({
            words,
            page: pageIds.indexOf(r.pageId),
            baseline: r.topPt + 0.8 * r.heightPt,
          });
          // A line ends before the space it breaks at.
          at = end;
          while (at < b.end && bytes[at - b.start] === 0x20) at++;
        }
        paras.push(lines);
        off = b.end + 1;
      }
    }, 120_000);
    afterAll(() => doc?.h.dispose());

    test("one paragraph per case", () => {
      expect(paras).toHaveLength(ANSWER.cases.length);
    });

    test("every paragraph's lines hold Word's words", () => {
      const misses: string[] = [];
      ANSWER.cases.forEach((c, i) => {
        if (!REAL_FACE && STAND_IN_DIFFERS.has(c.label)) return;
        const ours = paras[i]!.map((l) => l.words.join(" "));
        const word = c.word_lines.map((l) => l.words.map((w) => w.t).join(" "));
        if (JSON.stringify(ours) !== JSON.stringify(word)) {
          misses.push(
            `${c.label}: ours ${JSON.stringify(ours)} Word ${JSON.stringify(word)}`,
          );
        }
      });
      expect(misses).toEqual([]);
    });

    // A picture's line, by the steps that its own paragraph's spacing sets:
    // into a picture on a paragraph's 2nd line (P06, P07), out of a
    // picture's line into the next paragraph in the same spacing (P01-P07
    // into P01n-P07n), and a paragraph's text pitch (the n cases). A step
    // INTO a paragraph from one in another spacing is the transition rule,
    // not the picture's (see the ADR 617 amendment).
    test.skipIf(!REAL_FACE)("the picture cases step as Word's lines do", () => {
      const misses: string[] = [];
      const top = (c: (typeof ANSWER.cases)[number], k: number) =>
        c.word_lines[k]!.top_pt;
      ANSWER.cases.forEach((c, i) => {
        if (!/^P0\d/.test(c.label)) return;
        const ours = paras[i]!;
        // Steps inside the paragraph.
        for (let k = 1; k < ours.length && k < c.word_lines.length; k++) {
          const want = top(c, k) - top(c, k - 1);
          const got = ours[k]!.baseline - ours[k - 1]!.baseline;
          if (Math.abs(got - want) > WORD_GRID) {
            misses.push(
              `${c.label} line ${k + 1}: ${got.toFixed(2)} vs Word ${want.toFixed(2)}`,
            );
          }
        }
        // From a picture paragraph's last line into its pitch companion.
        if (c.picture && i + 1 < ANSWER.cases.length) {
          const n = ANSWER.cases[i + 1]!;
          const want = top(n, 0) - top(c, c.word_lines.length - 1);
          const got =
            paras[i + 1]![0]!.baseline - ours[ours.length - 1]!.baseline;
          if (Math.abs(got - want) > WORD_GRID) {
            misses.push(
              `${c.label} -> ${n.label}: ${got.toFixed(2)} vs Word ${want.toFixed(2)}`,
            );
          }
        }
      });
      expect(misses).toEqual([]);
    });
  },
);
