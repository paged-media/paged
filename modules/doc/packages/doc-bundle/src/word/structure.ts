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

// Word's document structure in the `wordDocument` context (doc ADRs 611 /
// 612, editor ADR 301): breaks, notes, fields, cross-references, the table
// of contents, bookmarks and index entries, each ONE engine mutation (engine
// ADR 1022) at the caret; and the headers and footers of a Word document
// opened as the document, edited in place on the page (contract C6,
// extensions ADR 349): a double-click in a page's header or footer band
// enters its master's story, and the sub-context bar offers Different
// first page, Different odd & even, Link to previous and the page number,
// page count and date fields.

import type { LoweredDoc } from "@paged-media/doc-host-model";
import type {
  BundleHost,
  SubContextHit,
  SubContextSpec,
  TextSelection,
} from "@paged-media/plugin-api";

/** What the bundle knows of an open Word document's structure: its
 *  section stories, the masters the skeleton wrote and what each section's
 *  pages take. `null` for a document not opened from Word in this
 *  session. */
export interface WordStructure {
  /** Section stories in order, with their pages' masters and start. */
  sections: Array<{
    storyId: string;
    /** The story's authored page (where the section opens). */
    pageId: string;
    master?: string;
    firstMaster?: string;
    evenMaster?: string;
    sectionStart?: "newPage" | "oddPage" | "evenPage";
  }>;
  /** Every master with its header and footer frames. */
  masters: Array<{
    id: string;
    name: string;
    pageSizePt: [number, number];
    header?: StructureFrame;
    footer?: StructureFrame;
  }>;
  /** The page's margins (top, bottom), for the header and footer bands. */
  margins: { top: number; bottom: number };
}

/** The structure of a Word document opened as the document, from the
 *  lowering it was poured from and its section stories (the skeleton's
 *  `docx_p{k}` pages); `null` when it has no masters. */
export function structureOf(
  ir: LoweredDoc,
  storyIds: readonly string[],
): WordStructure | null {
  const masters = ir.masters ?? [];
  if (masters.length === 0) return null;
  const frame = (f: NonNullable<(typeof masters)[number]["header"]>) => ({
    storyId: f.storyId,
    frameId: f.frameId,
    bounds: f.bounds,
  });
  const sections: WordStructure["sections"] = [];
  for (const s of ir.sections ?? [ir.section]) {
    const k = s.story ?? 0;
    if (sections[k] !== undefined || storyIds[k] === undefined) continue;
    sections[k] = {
      storyId: storyIds[k]!,
      pageId: `docx_p${k}`,
      master: s.masters?.master,
      firstMaster: s.masters?.firstMaster,
      evenMaster: s.masters?.evenMaster,
      sectionStart: s.sectionStart,
    };
  }
  const first = (ir.sections ?? [ir.section])[0] ?? ir.section;
  return {
    sections: sections.filter((s) => s !== undefined),
    masters: masters.map((m) => ({
      id: m.id,
      name: m.name,
      pageSizePt: [m.pageWidthPt, m.pageHeightPt],
      ...(m.header ? { header: frame(m.header) } : {}),
      ...(m.footer ? { footer: frame(m.footer) } : {}),
    })),
    margins: { top: first.marginTopPt, bottom: first.marginBottomPt },
  };
}

export interface StructureFrame {
  storyId: string;
  frameId: string;
  /** `[top, left, bottom, right]`, page points. */
  bounds: [number, number, number, number];
}

/** The commands this module runs (ids under the Word command prefix). */
export const STRUCTURE_COMMANDS = [
  "pageBreak",
  "sectionNextPage",
  "sectionOddPage",
  "sectionEvenPage",
  "sectionContinuous",
  "footnote",
  "endnote",
  "updateFields",
  "toggleFieldCodes",
  "insertToc",
  "updateToc",
  "insertPageNumber",
  "insertPageCount",
  "insertDate",
  "editHeader",
  "editFooter",
  "closeHeaderFooter",
  "differentFirstPage",
  "differentOddEven",
  "linkToPrevious",
] as const;
export type StructureCommandName = (typeof STRUCTURE_COMMANDS)[number];

/** The commands the header/footer bar shows (editor ADR 301). */
export const HEADER_BAR_COMMANDS: readonly StructureCommandName[] = [
  "differentFirstPage",
  "differentOddEven",
  "linkToPrevious",
  "insertPageNumber",
  "insertPageCount",
  "insertDate",
  "closeHeaderFooter",
];

type Outcome = { applied: boolean; error?: string };

async function mutate(host: BundleHost, m: unknown): Promise<Outcome> {
  const out = await host.document.mutate(m as never);
  return out.applied
    ? { applied: true }
    : { applied: false, error: describe(out.error) };
}

function describe(error: unknown): string {
  if (error == null) return "refused";
  if (typeof error === "string") return error;
  const e = error as { reason?: unknown; message?: unknown };
  if (typeof e.reason === "string") return e.reason;
  if (typeof e.message === "string") return e.message;
  return JSON.stringify(error);
}

/** The caret or selection, in content (`insertText`) offsets. */
function caret(host: BundleHost): TextSelection | null {
  return host.text?.selection() ?? null;
}

/** Word's DATE field as Word for Mac inserts it from Insert ▸ Date. */
export const DATE_FIELD = 'DATE \\@ "MMMM d, yyyy"';

/** The host's clock as `updateFields` takes it (the engine reads none). */
export function now(): string {
  return new Date().toISOString();
}

/** Insert a Word field at the caret: the engine computes its result
 *  (engine ADR 1022 `insertField { word }`). */
export async function insertWordField(
  host: BundleHost,
  code: string,
): Promise<Outcome> {
  const sel = caret(host);
  if (!sel) return { applied: false, error: "no caret" };
  const out = await mutate(host, {
    op: "insertField",
    args: {
      storyId: sel.storyId,
      offset: 0,
      contentOffset: sel.start,
      field: { word: { code } },
    },
  });
  // A date shows its code until F9 gives it the clock: give it now.
  if (out.applied && /^\s*(DATE|TIME)\b/i.test(code)) {
    await mutate(host, {
      op: "updateFields",
      args: { storyId: sel.storyId, offset: null, now: now() },
    });
  }
  return out;
}

/** A paragraph break at the caret whose new paragraph starts over as
 *  `rule` says (a page, an odd or even page; `null`: continuous). */
async function breakAtCaret(
  host: BundleHost,
  rule: string | null,
): Promise<Outcome> {
  const sel = caret(host);
  if (!sel) return { applied: false, error: "no caret" };
  const chars = await host.text.characterRange();
  if (!chars) return { applied: false, error: "no caret" };
  const ops: unknown[] = [
    {
      op: "insertText",
      args: { storyId: sel.storyId, offset: sel.start, text: "\n", cell: null },
    },
  ];
  if (rule) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: {
          kind: "storyRange",
          id: { story_id: sel.storyId, start: chars.start, end: chars.start },
        },
        path: "paragraphStartParagraph",
        value: { type: "text", value: rule },
      },
    });
  }
  return mutate(host, { op: "batch", args: { ops } });
}

/** A footnote or an endnote at the caret, with `text` (Word puts the caret
 *  in the new note; the engine's note is not a story the caret can enter,
 *  so its text comes from the References panel). */
export async function insertNote(
  host: BundleHost,
  endnote: boolean,
  text = "",
): Promise<Outcome> {
  const chars = await host.text.characterRange();
  if (!chars) return { applied: false, error: "no caret" };
  return mutate(host, {
    op: endnote ? "insertEndnote" : "insertFootnote",
    args: { storyId: chars.storyId, offset: chars.end, text },
  });
}

/** The heading styles of the document, level by level (Word's `heading
 *  1`… by name, as the lowering names them). */
export async function headingLevels(
  host: BundleHost,
  levels = 3,
): Promise<Array<{ style: string; level: number }>> {
  const styles = (await host.document.collection("paragraphStyles")) as Array<{
    selfId: string;
    name?: string;
  }>;
  const out: Array<{ style: string; level: number }> = [];
  for (let level = 1; level <= levels; level++) {
    const want = `heading ${level}`;
    const s = styles.find(
      (x) =>
        (x.name ?? "").toLowerCase() === want ||
        x.selfId.toLowerCase().endsWith(`heading${level}`),
    );
    if (s) out.push({ style: s.selfId, level });
  }
  return out;
}

/** Insert a table of contents at the caret from the heading styles (Word's
 *  References ▸ Table of Contents, `TOC \o "1-3"`). */
export async function insertToc(host: BundleHost): Promise<Outcome> {
  const sel = caret(host);
  if (!sel) return { applied: false, error: "no caret" };
  const levels = await headingLevels(host);
  if (levels.length === 0) {
    return { applied: false, error: "the document has no heading styles" };
  }
  return mutate(host, {
    op: "insertTableOfContents",
    args: {
      storyId: sel.storyId,
      offset: 0,
      contentOffset: sel.start,
      levels,
      title: "Contents",
    },
  });
}

/** A text destination (Word's bookmark) named `name` at the caret. */
export async function insertBookmark(
  host: BundleHost,
  name: string,
): Promise<Outcome> {
  const sel = caret(host);
  if (!sel) return { applied: false, error: "no caret" };
  return mutate(host, {
    op: "insertTextAnchor",
    args: { storyId: sel.storyId, offset: 0, contentOffset: sel.start, name },
  });
}

/** A cross-reference at the caret to a bookmark, or to a paragraph (a
 *  heading) of a story. */
export async function insertCrossReference(
  host: BundleHost,
  target: { bookmark: string } | { storyId: string; paragraph: number },
  referTo: "text" | "pageNumber" | "aboveBelow" = "text",
): Promise<Outcome> {
  const sel = caret(host);
  if (!sel) return { applied: false, error: "no caret" };
  return mutate(host, {
    op: "insertCrossReference",
    args: {
      storyId: sel.storyId,
      offset: 0,
      contentOffset: sel.start,
      target,
      referTo,
      hyperlink: true,
    },
  });
}

/** An index entry (Word's Mark Entry) for `topic` at the caret. */
export async function insertIndexEntry(
  host: BundleHost,
  topic: string[],
): Promise<Outcome> {
  const sel = caret(host);
  if (!sel) return { applied: false, error: "no caret" };
  return mutate(host, {
    op: "insertIndexMarker",
    args: { storyId: sel.storyId, offset: 0, contentOffset: sel.start, topic },
  });
}

/** Whether the document shows field codes (`documentShowFieldCodes`). */
async function showingFieldCodes(host: BundleHost): Promise<boolean> {
  try {
    const v = (await host.objects.get("doc", "documentShowFieldCodes")) as {
      value?: unknown;
    } | null;
    return v?.value === true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- headers, footers

/** Which section a page belongs to: the last section whose story opens at
 *  or before it (its authored page, or the blank page put in front). */
export function sectionOfPage(
  structure: WordStructure,
  pageIds: readonly string[],
  pageId: string,
): number {
  const at = pageIds.indexOf(pageId);
  let k = 0;
  structure.sections.forEach((s, i) => {
    const opens = pageIds.indexOf(s.pageId);
    if (opens >= 0 && opens <= at) k = i;
  });
  return k;
}

/** The header or footer band a page point falls in (Word: above the top
 *  margin, below the bottom margin). */
export function bandAt(
  structure: WordStructure,
  heightPt: number,
  y: number,
): "header" | "footer" | null {
  if (y <= structure.margins.top) return "header";
  if (y >= heightPt - structure.margins.bottom) return "footer";
  return null;
}

/** The label Word gives the band (`First Page Header -Section 2-`). */
export function bandLabel(
  kind: "header" | "footer",
  which: "first" | "even" | "odd" | "default",
  section: number,
): string {
  const what = kind === "header" ? "Header" : "Footer";
  const prefix =
    which === "first"
      ? "First Page "
      : which === "even"
        ? "Even Page "
        : which === "odd"
          ? "Odd Page "
          : "";
  return `${prefix}${what} -Section ${section + 1}-`;
}

/** Resolve a page double-click to the header or footer it lands in
 *  (editor ADR 301): the master the page shows, its frame in the band. */
export async function resolveHeaderFooter(
  host: BundleHost,
  structure: WordStructure | null,
  hit: SubContextHit,
  commandIds: readonly string[],
): Promise<SubContextSpec | null> {
  if (!structure) return null;
  const pages = (await host.document.collection("pages")) as Array<{
    selfId: string;
    sizePt?: [number, number];
    appliedMaster?: string | null;
  }>;
  const page = pages.find((p) => p.selfId === hit.pageId);
  if (!page) return null;
  const height = page.sizePt?.[1] ?? 792;
  const kind = bandAt(structure, height, hit.pagePoint[1]);
  if (!kind) return null;
  const master = structure.masters.find((m) => m.id === page.appliedMaster);
  const frame = master?.[kind];
  if (!master || !frame) return null;
  const k = sectionOfPage(
    structure,
    pages.map((p) => p.selfId),
    page.selfId,
  );
  const s = structure.sections[k];
  const which =
    s?.firstMaster === master.id
      ? "first"
      : s?.evenMaster === master.id
        ? "even"
        : s?.evenMaster
          ? "odd"
          : "default";
  return {
    kind,
    pageId: page.selfId,
    storyId: frame.storyId,
    frameId: frame.frameId,
    masterId: master.id,
    bounds: frame.bounds,
    label: bandLabel(kind, which, k),
    commands: commandIds,
  };
}

/** The grow rule of section `k` as the structure now says. */
function growRule(structure: WordStructure, k: number): unknown {
  const s = structure.sections[k]!;
  return {
    op: "setFlowGrowRule",
    args: {
      storyId: s.storyId,
      grow: true,
      maxPages: null,
      copyFrameOptions: true,
      ...(s.master ? { master: s.master } : {}),
      ...(s.firstMaster ? { firstMaster: s.firstMaster } : {}),
      ...(s.evenMaster ? { evenMaster: s.evenMaster } : {}),
      ...(s.sectionStart && s.sectionStart !== "newPage"
        ? { sectionStart: s.sectionStart }
        : {}),
    },
  };
}

/** A new master like `like` with empty header and footer frames where it
 *  has them (Word: a new first-page or even-page header starts empty).
 *  Returns its id; the frames' stories are found when they are edited. */
async function blankMasterLike(
  host: BundleHost,
  structure: WordStructure,
  like: string,
  name: string,
): Promise<string | null> {
  const base = structure.masters.find((m) => m.id === like);
  if (!base) return null;
  const id = `docx_m${structure.masters.length}`;
  const ops: unknown[] = [
    {
      op: "createMaster",
      args: {
        master: id,
        name,
        widthPt: base.pageSizePt[0],
        heightPt: base.pageSizePt[1],
      },
    },
  ];
  const made = await mutate(host, { op: "batch", args: { ops } });
  if (!made.applied) return null;
  const pages = (await host.document.collection("masterPages")) as Array<{
    selfId: string;
    masterId?: string;
    spreadId?: string;
  }>;
  const page = pages.find((p) => p.masterId === id || p.spreadId === id);
  const entry: WordStructure["masters"][number] = {
    id,
    name,
    pageSizePt: base.pageSizePt,
  };
  for (const kind of ["header", "footer"] as const) {
    const f = base[kind];
    if (!f || !page) continue;
    const out = await host.document.mutate({
      op: "onMaster",
      args: {
        master: id,
        mutation: {
          op: "insertTextFrame",
          args: { pageId: page.selfId, bounds: f.bounds },
        },
      },
    } as never);
    const created = out.applied ? out.createdId : null;
    const frameId = created && created.kind === "textFrame" ? created.id : null;
    if (!frameId) continue;
    const storyId = (await frameStory(host, frameId)) ?? "";
    entry[kind] = { storyId, frameId, bounds: f.bounds };
  }
  structure.masters.push(entry);
  return id;
}

/** The story a text frame holds, through the object model. */
async function frameStory(
  host: BundleHost,
  frameId: string,
): Promise<string | null> {
  try {
    const v = (await host.objects.get(`frame:${frameId}`, "story")) as {
      value?: unknown;
    } | null;
    return typeof v?.value === "string" ? v.value : null;
  } catch {
    return null;
  }
}

/** The section the open sub-context edits (its page's section). */
async function subContextSection(
  host: BundleHost,
  structure: WordStructure,
): Promise<number | null> {
  const sub = host.shell.subContext?.();
  if (!sub) return null;
  const pages = (await host.document.collection("pages")) as Array<{
    selfId: string;
  }>;
  return sectionOfPage(
    structure,
    pages.map((p) => p.selfId),
    sub.pageId,
  );
}

/** Toggle the section's different first page (Word's `w:titlePg`). */
async function toggleFirstPage(
  host: BundleHost,
  structure: WordStructure,
  k: number,
): Promise<Outcome> {
  const s = structure.sections[k];
  if (!s) return { applied: false, error: "no section" };
  if (s.firstMaster) {
    s.firstMaster = undefined;
  } else {
    const like = s.master;
    if (!like) return { applied: false, error: "the section has no master" };
    const id = await blankMasterLike(
      host,
      structure,
      like,
      `Section ${k + 1} First Page`,
    );
    if (!id) return { applied: false, error: "no master made" };
    s.firstMaster = id;
  }
  return mutate(host, growRule(structure, k));
}

/** Toggle different odd and even pages (Word's `w:evenAndOddHeaders`,
 *  document-wide). */
async function toggleOddEven(
  host: BundleHost,
  structure: WordStructure,
): Promise<Outcome> {
  const on = structure.sections.some((s) => s.evenMaster);
  const ops: unknown[] = [];
  for (const [k, s] of structure.sections.entries()) {
    if (on) {
      s.evenMaster = undefined;
    } else if (s.master) {
      // A section linked to the previous one shares its even master.
      const prev = structure.sections[k - 1];
      s.evenMaster =
        prev && prev.master === s.master && prev.evenMaster
          ? prev.evenMaster
          : ((await blankMasterLike(
              host,
              structure,
              s.master,
              `Section ${k + 1} Even Page`,
            )) ?? undefined);
    }
    ops.push(growRule(structure, k));
  }
  return mutate(host, { op: "batch", args: { ops } });
}

/** Toggle Link to Previous for the section's pages (Word: the section shows
 *  the previous section's headers and footers). Unlinking gives it a copy
 *  to edit apart; linking takes the previous section's masters. */
async function toggleLink(
  host: BundleHost,
  structure: WordStructure,
  k: number,
): Promise<Outcome> {
  const s = structure.sections[k];
  const prev = structure.sections[k - 1];
  if (!s || !prev) {
    return { applied: false, error: "the first section has no previous one" };
  }
  const linked = s.master === prev.master;
  if (linked) {
    const id = await blankMasterLike(
      host,
      structure,
      prev.master!,
      `Section ${k + 1}`,
    );
    if (!id) return { applied: false, error: "no master made" };
    s.master = id;
  } else {
    s.master = prev.master;
    s.evenMaster = prev.evenMaster;
  }
  return mutate(host, growRule(structure, k));
}

/** Enter a header or footer of the page the viewport shows (Word's Insert
 *  ▸ Header ▸ Edit Header). */
async function editBand(
  host: BundleHost,
  structure: WordStructure | null,
  kind: "header" | "footer",
  commandIds: readonly string[],
): Promise<Outcome> {
  if (!structure) return { applied: false, error: "not a Word document" };
  const pageId = host.viewport?.activePage?.() ?? null;
  const pages = (await host.document.collection("pages")) as Array<{
    selfId: string;
    sizePt?: [number, number];
  }>;
  const page = pages.find((p) => p.selfId === pageId) ?? pages[0];
  if (!page) return { applied: false };
  const h = page.sizePt?.[1] ?? 792;
  const y = kind === "header" ? 1 : h - 1;
  const spec = await resolveHeaderFooter(
    host,
    structure,
    { editContext: "wordDocument", pageId: page.selfId, pagePoint: [1, y] },
    commandIds,
  );
  if (!spec) return { applied: false, error: `the page has no ${kind}` };
  return { applied: host.shell.enterSubContext(spec) };
}

/** Run one structure command. */
export async function runStructureCommand(
  host: BundleHost,
  name: StructureCommandName,
  structure: () => WordStructure | null,
  barCommandIds: readonly string[],
): Promise<Outcome> {
  switch (name) {
    case "pageBreak":
      return breakAtCaret(host, "NextPage");
    case "sectionNextPage":
      return breakAtCaret(host, "NextPage");
    case "sectionOddPage":
      return breakAtCaret(host, "NextOddPage");
    case "sectionEvenPage":
      return breakAtCaret(host, "NextEvenPage");
    case "sectionContinuous":
      return breakAtCaret(host, null);
    case "footnote":
      return insertNote(host, false);
    case "endnote":
      return insertNote(host, true);
    case "updateFields": {
      // F9: the fields of the story the caret is in, else every field.
      const sel = caret(host);
      return mutate(host, {
        op: "updateFields",
        args: { storyId: sel?.storyId ?? null, offset: null, now: now() },
      });
    }
    case "toggleFieldCodes": {
      const on = await showingFieldCodes(host);
      return mutate(host, {
        op: "set",
        args: {
          address: "doc",
          path: "documentShowFieldCodes",
          value: { type: "bool", value: !on },
        },
      });
    }
    case "insertToc":
      return insertToc(host);
    case "updateToc": {
      const sel = caret(host);
      if (!sel) return { applied: false, error: "no caret" };
      return mutate(host, {
        op: "updateTableOfContents",
        args: { storyId: sel.storyId },
      });
    }
    case "insertPageNumber":
      return insertWordField(host, "PAGE");
    case "insertPageCount":
      return insertWordField(host, "NUMPAGES");
    case "insertDate":
      return insertWordField(host, DATE_FIELD);
    case "editHeader":
      return editBand(host, structure(), "header", barCommandIds);
    case "editFooter":
      return editBand(host, structure(), "footer", barCommandIds);
    case "closeHeaderFooter":
      return { applied: host.shell.exitSubContext?.() ?? false };
    case "differentFirstPage":
    case "differentOddEven":
    case "linkToPrevious": {
      const s = structure();
      if (!s) return { applied: false, error: "not a Word document" };
      if (name === "differentOddEven") return toggleOddEven(host, s);
      const k = (await subContextSection(host, s)) ?? 0;
      return name === "differentFirstPage"
        ? toggleFirstPage(host, s, k)
        : toggleLink(host, s, k);
    }
  }
}
