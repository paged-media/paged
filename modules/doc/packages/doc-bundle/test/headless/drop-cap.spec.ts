// Word's drop caps (doc ADR 624) on the real engine, held against what Word
// laid for `docx_conformance::drop_cap_docx()` (docx-conformance/fixtures/
// drop-cap.word.json, scripts/word-drop-cap-probe.sh): the cap's lines carve
// the paragraph's first lines, the lines after them run flush, and the 2-line
// cap indents the lines beside it as Word does (Calibri 11 pt, the face Word
// used; where the machine has no Calibri only the carve is checked).
// The known differences are asserted too, so a change that closes one shows:
// the 3-line cap's size and indent (the engine sizes a cap by its own rule),
// and a following paragraph, which Word wraps beside a cap taller than its own
// paragraph.

import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  docxPresent,
  type OpenedDoc,
  openDoc,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — Word's drop caps");

const CALIBRI = [
  "/Applications/Microsoft Word.app/Contents/Resources/DFonts/Calibri.ttf",
  "/System/Library/Fonts/Supplemental/Calibri.ttf",
].find((p) => existsSync(p));
const WORD = JSON.parse(
  readFileSync(
    new URL(
      "../../../../docx-conformance/fixtures/drop-cap.word.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { lines: Array<{ x0: number; text: string }> };

type Reply = { kind: string; payload?: any };
interface Line {
  text: string;
  x: number;
}

describe.skipIf(!docxPresent)(
  "doc headless — Word's drop caps @feat:plugin-doc.drop-caps",
  () => {
    let doc: OpenedDoc;
    const paras: Line[][] = [];

    beforeAll(async () => {
      doc = await openDoc("drop-cap.docx");
      const send = (m: unknown) =>
        doc.h.host.editor.client.send(m as never) as Promise<Reply>;
      const script = async (s: string) => {
        const r = await send({ kind: "executeScript", payload: { source: s } });
        return JSON.parse(r.payload?.output?.[0] ?? "[]");
      };
      if (CALIBRI) {
        await send({
          kind: "registerFont",
          payload: {
            family: "Calibri",
            style: null,
            bytes: Array.from(readFileSync(CALIBRI)),
          },
        });
      }
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
      const storyId = doc.opened.storyIds[0]!;
      const content = (
        await send({ kind: "requestStoryContent", payload: { storyId } })
      ).payload?.content?.paragraphs as Array<{
        runs: Array<{ text: string }>;
      }>;
      let off = 0;
      for (const para of content) {
        const text = para.runs.map((r) => r.text).join("");
        const b = (
          await send({
            kind: "requestParagraphBounds",
            payload: { storyId, offset: off },
          })
        ).payload?.bounds as { start: number; end: number };
        // Where a line's first character stands: the one after the cap
        // (line 1) and the "my" the lines break at (line 2). The engine's
        // line bounds leave the cap's characters out, so the lines are not
        // walked.
        const capChars = /^(P\d)/.test(text)
          ? 0
          : text.startsWith("Th")
            ? 2
            : 1;
        const starts = /^(P\d)/.test(text)
          ? [0]
          : [0, text.indexOf("my box") - capChars];
        const lines: Line[] = [];
        for (const at of starts) {
          const rects = (
            await send({
              kind: "requestSelectionGeometry",
              payload: {
                selection: {
                  storyId,
                  start: b.start + at,
                  end: b.start + at + 1,
                },
              },
            })
          ).payload?.rects as Array<{ leftPt: number }>;
          lines.push({ text: text.slice(at, at + 12), x: rects[0]!.leftPt });
        }
        paras.push(lines);
        off = b.end + 1;
      }
    }, 120_000);
    afterAll(() => doc?.h.dispose());

    // Paragraphs: 0 P0, 1 cap T (3 lines), 2 P2, 3 cap Th (2 lines), 4 P4,
    // 5 cap T (margin), 6 P6.
    test("a cap's lines are carved, the paragraphs around it are not", () => {
      expect(paras).toHaveLength(7);
      for (const i of [0, 2, 4, 6]) expect(paras[i]![0]!.x).toBeCloseTo(72, 0);
      for (const i of [1, 3, 5]) {
        for (const l of paras[i]!) expect(l.x).toBeGreaterThan(80);
      }
    });

    test.skipIf(!CALIBRI)(
      "the 2-line cap indents its lines as Word's does, within 1 pt",
      () => {
        const word = WORD.lines.filter((l) => /^(e quick|my box)/.test(l.text));
        expect(word).toHaveLength(2);
        paras[3]!.forEach((l, k) => {
          expect(Math.abs(l.x - word[k]!.x0)).toBeLessThan(1);
        });
      },
    );

    // Known differences (doc ADR 624): the 3-line cap is the engine's size,
    // wider than Word's by about 2 pt, so the line breaks one word earlier;
    // Word keeps P2 beside the cap, the engine does not.
    test.skipIf(!CALIBRI)(
      "known differences: the 3-line cap indents 2 pt more than Word's, P2 is not beside it",
      () => {
        const wordX = WORD.lines.find((l) => l.text.startsWith("he quick"))!.x0;
        expect(paras[1]![0]!.x - wordX).toBeGreaterThan(1);
        expect(paras[1]![0]!.x - wordX).toBeLessThan(3);
        const wordP2 = WORD.lines.find((l) => l.text.startsWith("P2"))!.x0;
        expect(wordP2).toBeGreaterThan(90);
        expect(paras[2]![0]!.x).toBeCloseTo(72, 0);
      },
    );
  },
);
