// Doc ADRs 611 / 612 — fields, note references and bookmarks in the pour.
// A live Word field's result and a note reference's marker are not poured
// as text: each is inserted after the text, in ascending order, at its place
// in the finished pour, so every style range and later insert keeps the
// offsets the lowering gave it.
import { describe, expect, it } from "bun:test";

import {
  buildStoryBlocks,
  buildTextPour,
  FOOTNOTE_MARKER,
  noteKey,
  withoutNotes,
} from "../src/index.js";
import type { LoweredBlock, LoweredParagraph } from "../src/index.js";

type Op = { op: string; args: Record<string, unknown> };

const footer: LoweredParagraph = {
  paraStyleId: "ParagraphStyle/docx-Footer",
  runs: [
    { text: "Page " },
    {
      text: "3",
      charStyleId: "CharacterStyle/docx-auto-c1",
      field: { code: "PAGE", seq: 0 },
    },
    { text: " of " },
    { text: "1", field: { code: "NUMPAGES", seq: 1 } },
    { text: "2", field: { code: "NUMPAGES", seq: 1 } },
  ],
  sourceIndex: 0,
};

describe("a paragraph with live fields", () => {
  const out = buildTextPour([footer], "docx_m0_f", 0);
  const ops = out.mutations as unknown as Op[];

  it("pours the text without the fields' results", () => {
    expect(ops[0]).toEqual({
      op: "insertText",
      args: { storyId: "docx_m0_f", offset: 0, text: "Page  of ", cell: null },
    });
  });

  it("inserts each field with its result where it stands, in order", () => {
    const fields = ops.filter((o) => o.op === "insertField").map((o) => o.args);
    expect(fields).toEqual([
      {
        storyId: "docx_m0_f",
        offset: 5,
        contentOffset: 5,
        field: { word: { code: "PAGE", result: "3" } },
      },
      {
        storyId: "docx_m0_f",
        offset: 10,
        contentOffset: 10,
        // One field whose result Word wrote in two runs.
        field: { word: { code: "NUMPAGES", result: "12" } },
      },
    ]);
  });

  it("styles a field with its first run's look, after it is inserted", () => {
    const first = ops.findIndex((o) => o.op === "insertField");
    const style = ops.findIndex(
      (o) =>
        o.op === "applyStyle" && o.args.style === "CharacterStyle/docx-auto-c1",
    );
    expect(style).toBeGreaterThan(first);
    expect(ops[style].args).toMatchObject({ start: 5, end: 6 });
  });

  it("measures the finished pour, results included", () => {
    expect(out.length).toBe(12);
    expect(out.byteLength).toBe(12);
  });
});

const withNote: LoweredParagraph = {
  paraStyleId: "ParagraphStyle/p",
  runs: [
    { text: "Before" },
    {
      text: `x${FOOTNOTE_MARKER} after`,
      charStyleId: "CharacterStyle/c",
      note: { id: 2, endnote: false },
    },
  ],
  sourceIndex: 0,
  images: [{ at: 9, widthPt: 10, heightPt: 10, uri: "data:," }],
  bookmarks: ["_Toc1", "_GoBack"],
};
const second: LoweredParagraph = {
  paraStyleId: "ParagraphStyle/p",
  runs: [{ text: "Next" }],
  sourceIndex: 1,
  bookmarks: ["Here"],
};

describe("a note reference inside a run", () => {
  const notes = new Map([[noteKey(false, 2), "The note."]]);
  const out = buildTextPour([withNote, second], "docx_s0", 0, 0, {
    notes,
    paraBase: 0,
  });
  const ops = out.mutations as unknown as Op[];

  it("pours the text around the marker, then inserts the note with its text", () => {
    expect(ops[0].args.text).toBe("Beforex after\nNext");
    expect(ops[1]).toEqual({
      op: "insertFootnote",
      args: { storyId: "docx_s0", offset: 7, paragraph: 0, text: "The note." },
    });
  });

  it("styles the run's text but not the marker", () => {
    const ranges = ops
      .filter((o) => o.op === "applyStyle" && o.args.scope === "character")
      .map((o) => [o.args.start, o.args.end]);
    expect(ranges).toEqual([
      [6, 7],
      [8, 14],
    ]);
  });

  it("names Word's bookmarks as text anchors, not the last-edit one", () => {
    const anchors = ops
      .filter((o) => o.op === "insertTextAnchor")
      .map((o) => o.args);
    expect(anchors).toEqual([
      { storyId: "docx_s0", offset: 0, contentOffset: 0, name: "_Toc1" },
      // After "Beforex<marker> after" (14 chars, 16 bytes) and the break.
      { storyId: "docx_s0", offset: 14, contentOffset: 17, name: "Here" },
    ]);
  });

  it("counts the marker in the pour's length", () => {
    expect(out.length).toBe(18);
  });
});

describe("where notes are not placed", () => {
  it("leaves the reference out and moves what follows it back", () => {
    const [p] = withoutNotes([withNote]);
    expect(p.runs.map((r) => r.text)).toEqual(["Before", "x after"]);
    expect(p.runs[1].note).toBeNull();
    expect(p.images?.[0].at).toBe(8);
  });

  it("is what a pour without the notes' text does", () => {
    const ops = buildTextPour([withNote], "s", 0).mutations as unknown as Op[];
    expect(ops.some((o) => o.op === "insertFootnote")).toBe(false);
    expect(ops[0].args.text).toBe("Beforex after");
  });

  it("is the story pour's default (an inserted document)", () => {
    const blocks: LoweredBlock[] = [{ kind: "paragraph", ...withNote }];
    const steps = buildStoryBlocks(blocks, "s");
    expect(steps[0].kind).toBe("text");
    if (steps[0].kind !== "text") return;
    const ops = steps[0].mutations(0, 0) as unknown as Op[];
    expect(ops.some((o) => o.op === "insertFootnote")).toBe(false);
    const placed = buildStoryBlocks(blocks, "s", {
      notes: new Map([[noteKey(false, 2), "N"]]),
    });
    if (placed[0].kind !== "text") return;
    const withNotes = placed[0].mutations(0, 0) as unknown as Op[];
    expect(withNotes.filter((o) => o.op === "insertFootnote")).toHaveLength(1);
  });
});
