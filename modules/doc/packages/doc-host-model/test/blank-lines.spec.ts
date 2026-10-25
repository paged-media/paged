// Word blank lines and plain line breaks (core 65cf615 / ab383b1).
//
// - A blank line (an empty Word paragraph) is styled with a CARET — an
//   `applyStyle` paragraph range with start === end, which names the empty
//   paragraph(s) at that contiguous offset. The story plan applies every
//   caret in a final step, once all paragraphs exist, so blank lines that
//   share an offset (consecutive ones, or ones on either side of a table)
//   still agree when the caret meets them.
// - A plain `<w:br/>` is U+2028 in the run text: one char in the contiguous
//   style space, three bytes in insertText's.
import { describe, expect, it } from "bun:test";

import { buildStoryBlocks, buildTextPour, endsEmpty } from "../src/index.js";
import type { LoweredBlock, LoweredParagraph } from "../src/index.js";

type Op = { op: string; args: Record<string, unknown> };

const para = (style: string, text: string): LoweredBlock => ({
  kind: "paragraph",
  paraStyleId: style,
  runs: text ? [{ text, charStyleId: "CharacterStyle/c" }] : [],
  sourceIndex: 0,
});
const table: LoweredBlock = {
  kind: "table",
  rows: 1,
  cols: 1,
  columnWidthsPt: [],
  cells: [],
};

/** Run a story plan the way `pourSteps` does (a table's step moves the
 *  insertText end by its `textLength`, after the break it may insert). */
function run(blocks: LoweredBlock[]): Op[][] {
  let style = 0;
  let text = 0;
  return buildStoryBlocks(blocks, "s").map((step) => {
    if (step.kind === "table") {
      const ops = [step.insert as unknown as Op];
      if (step.breakBefore)
        ops.unshift({
          op: "insertText",
          args: { storyId: "s", offset: text, text: "\n", cell: null },
        });
      text += step.textLength;
      return ops;
    }
    const ops = step.mutations(text, style) as unknown as Op[];
    style += step.length;
    text += step.byteLength;
    return ops;
  });
}

const paraStyles = (ops: Op[]) =>
  ops
    .filter((o) => o.op === "applyStyle" && o.args.scope === "paragraph")
    .map((o) => [o.args.start, o.args.end, o.args.style]);

/** Carets with the native paragraph each names (core wire v65). */
const carets = (ops: Op[]) =>
  ops
    .filter((o) => o.op === "applyStyle" && o.args.scope === "paragraph")
    .map((o) => [o.args.start, o.args.style, o.args.paragraph]);

describe("blank lines", () => {
  it("are styled by a caret each, after the text, naming their paragraph", () => {
    const steps = run([
      para("ParagraphStyle/a", "ab"),
      para("ParagraphStyle/blank", ""),
      para("ParagraphStyle/blank", ""),
      para("ParagraphStyle/b", "cd"),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0][0].args.text).toBe("ab\n\n\ncd");
    // The text step carries only the non-empty paragraphs' ranges ...
    expect(paraStyles(steps[0])).toEqual([
      [0, 2, "ParagraphStyle/a"],
      [2, 4, "ParagraphStyle/b"],
    ]);
    // ... and the final step one caret per blank line. Both stand at
    // offset 2 (an empty paragraph has no characters); each names its own
    // paragraph, and no non-empty range carries an address.
    expect(carets(steps[1])).toEqual([
      [2, "ParagraphStyle/blank", 1],
      [2, "ParagraphStyle/blank", 2],
    ]);
    expect(steps[0].every((o) => o.args.paragraph === undefined)).toBe(true);
    // No character-scope op ever has an empty range.
    for (const o of steps.flat()) {
      if (o.op === "applyStyle" && o.args.scope === "character") {
        expect(o.args.end).toBeGreaterThan(o.args.start as number);
      }
    }
  });

  it("on either side of a table share an offset and name different paragraphs", () => {
    const steps = run([
      para("ParagraphStyle/a", "ab"),
      para("ParagraphStyle/x", ""),
      table,
      para("ParagraphStyle/y", ""),
      para("ParagraphStyle/b", "cd"),
    ]);
    expect(steps.map((s) => s.map((o) => o.op))).toEqual([
      ["insertText", "applyStyle", "applyStyle"],
      // x's blank line is empty, so insertTable would take it: a paragraph
      // is made for the table first, at the story's end ("ab\n" = 3).
      ["insertText", "insertTable"],
      ["insertText", "applyStyle", "applyStyle"],
      ["applyStyle", "applyStyle"],
    ]);
    expect(steps[1][0].args).toMatchObject({ offset: 3, text: "\n" });
    // The text after the table starts a paragraph after the table's: one
    // break past the table's paragraph (3 + 1), then its own.
    expect(steps[2][0].args).toMatchObject({ offset: 4, text: "\n\ncd" });
    // "ab" is paragraph 0, x's blank line 1, the table 2, y's blank line 3
    // and "cd" 4. In order: an engine without the address styles every
    // blank line at the offset, and y then wins.
    expect(carets(steps[3])).toEqual([
      [2, "ParagraphStyle/x", 1],
      [2, "ParagraphStyle/y", 3],
    ]);
  });

  it("tables back to back, and one that opens the story, each take one paragraph", () => {
    const steps = buildStoryBlocks(
      [
        table,
        para("ParagraphStyle/a", "ab"),
        table,
        table,
        para("ParagraphStyle/b", "cd"),
      ],
      "s",
    );
    expect(
      steps.map((s) =>
        s.kind === "table"
          ? ["table", s.breakBefore, s.textLength]
          : ["text", s.byteLength],
      ),
    ).toEqual([
      ["table", false, 0], // the fresh story's paragraph
      ["text", 3], // "\nab": a paragraph after the table's
      ["table", false, 1], // "ab" is not empty: insertTable adds one
      ["table", false, 1], // nor is a table's paragraph
      ["text", 3],
    ]);
    const ops = run([
      table,
      para("ParagraphStyle/a", "ab"),
      table,
      table,
      para("ParagraphStyle/b", "cd"),
    ]);
    // "ab" at 1 (past the table's paragraph), "cd" at 1 + 2 + 1 + 1 + 1.
    expect(ops[1][0].args).toMatchObject({ offset: 0, text: "\nab" });
    expect(ops[4][0].args).toMatchObject({ offset: 5, text: "\ncd" });
    expect(paraStyles(ops[1])).toEqual([[0, 2, "ParagraphStyle/a"]]);
    expect(paraStyles(ops[4])).toEqual([[2, 4, "ParagraphStyle/b"]]);
  });

  it("endsEmpty: what insertTable would take as the table's paragraph", () => {
    const of = (b: LoweredBlock) => endsEmpty(b as LoweredParagraph);
    expect(of(para("ParagraphStyle/a", ""))).toBe(true);
    expect(of(para("ParagraphStyle/a", "x"))).toBe(false);
    const withBreakAtEnd = {
      ...(para("ParagraphStyle/a", "x") as LoweredParagraph),
      segments: [{ at: 1 }],
    };
    expect(endsEmpty(withBreakAtEnd)).toBe(true);
    const picture = {
      ...(para("ParagraphStyle/a", "") as LoweredParagraph),
      images: [{ at: 0, widthPt: 1, heightPt: 1, uri: "x" }],
    };
    expect(endsEmpty(picture)).toBe(false);
  });

  it("a story with no blank line has no caret step", () => {
    expect(run([para("ParagraphStyle/a", "ab")])).toHaveLength(1);
  });

  it("buildTextPour still inlines carets unless asked to defer them", () => {
    const paras = [
      para("ParagraphStyle/a", "ab"),
      para("ParagraphStyle/blank", ""),
    ] as LoweredParagraph[];
    const inline = buildTextPour(paras, "s", 0);
    expect(paraStyles(inline.mutations as unknown as Op[])).toContainEqual([
      2,
      2,
      "ParagraphStyle/blank",
    ]);
    const deferred = buildTextPour(paras, "s", 0, 0, { deferCarets: true });
    expect(paraStyles(deferred.mutations as unknown as Op[])).toEqual([
      [0, 2, "ParagraphStyle/a"],
    ]);
    expect(deferred.carets).toHaveLength(1);
  });
});

describe("plain line breaks (U+2028)", () => {
  const br: LoweredParagraph = {
    paraStyleId: "ParagraphStyle/p",
    runs: [
      { text: "L02a\u2028L02b", charStyleId: "CharacterStyle/c" },
      { text: "\u2028\u2028x", charStyleId: "CharacterStyle/d" },
    ],
    sourceIndex: 0,
  };
  const next: LoweredParagraph = {
    paraStyleId: "ParagraphStyle/q",
    runs: [{ text: "n" }],
    sourceIndex: 1,
  };
  const out = buildTextPour([br, next], "s", 10, 4);
  const ops = out.mutations as unknown as Op[];

  it("stay in the inserted text, inside ONE paragraph", () => {
    expect(ops[0].args.text).toBe("L02a\u2028L02b\u2028\u2028x\nn");
    expect((ops[0].args.text as string).split("\n")).toHaveLength(2);
  });

  it("count one char in the style space and three bytes in the text space", () => {
    expect(paraStyles(ops)).toEqual([
      [4, 16, "ParagraphStyle/p"],
      [16, 17, "ParagraphStyle/q"],
    ]);
    const chr = ops
      .filter((o) => o.op === "applyStyle" && o.args.scope === "character")
      .map((o) => [o.args.start, o.args.end]);
    expect(chr).toEqual([
      [4, 13],
      [13, 16],
    ]);
    expect(out.length).toBe(13);
    // 4 + 3 + 4 + 3 + 3 + 1 bytes, the separator, "n".
    expect(out.byteLength).toBe(18 + 1 + 1);
  });
});
