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

// Save-back of Word's document structure (doc ADRs 610–612): what the
// bundle reads back beyond the body for the engine's `save_edited_structure`
// — every master header/footer story with the part it shows, the engine's
// footnotes and endnotes in document order, and the body stories' text
// anchors (Word's bookmarks), addressed in the merged body read-back.

import { readTextBoxes } from "./page-items.js";
import type { CellContent } from "./save-cells.js";
import type { BundleHost } from "@paged-media/plugin-api";
import type { LoweredDoc, StoryContentLike } from "@paged-media/doc-host-model";

/** One read-back story (`storyContent`), with the text anchors the engine
 *  reports on a Word document's stories (engine ADR 1022). */
type StoryRead = StoryContentLike & {
  textAnchors?: Array<{ name: string; paragraph: number; offset: number }>;
};

/** A note as the engine's `footnotes` / `endnotes` collections list it. */
interface NoteRead {
  storyId: string;
  offset: number;
  text: string;
}

/** What `save_edited_structure` takes beside the body (docx-export
 *  `structure::StructureIn`). */
export interface StructureRead {
  headers: Array<{ part: number; content: StoryContentLike }>;
  footnotes: Array<{ text: string }>;
  endnotes: Array<{ text: string }>;
  anchors: Array<{ name: string; paragraph: number; offset: number }>;
  /** Doc ADR 614 — the text boxes' stories, by page item. */
  textBoxes?: Array<{ item: string; content: unknown }>;
  /** Doc ADR 623 — the pictures of the read-back paragraphs with the
   *  placement of each in its frame (a crop), for `docx-export`'s
   *  `crop::save_crops`. */
  pictures?: PicturesRead;
}

/** One picture of a read-back paragraph (the engine's `PictureContent`). */
export interface PictureRead {
  frameId: string;
  offset: number;
  placement?: [number, number, number, number, number, number];
  /** Engine ADR 1037 — the picture's filter stack, written back as its
   *  blip's picture effects (`docx-export`, `dml_native::picture`). */
  adjustments?: unknown[];
}

/** The pictures per read-back paragraph (the merged body's, in order) and
 *  per paragraph of each native table cell read with its paragraphs. */
export interface PicturesRead {
  body: PictureRead[][];
  cells: Array<{ block: number; cell: number; paragraphs: PictureRead[][] }>;
}

/** The pictures a read-back paragraph lists (none on a host that does not
 *  read them). */
function picturesOfParagraph(p: unknown): PictureRead[] {
  const list = (p as { pictures?: unknown } | null)?.pictures;
  return Array.isArray(list) ? (list as PictureRead[]) : [];
}

/** Doc ADR 623 — the pictures of the stories read back (trailing empty
 *  paragraphs dropped as the merged body drops them) and of the cells. */
export function readPictures(
  contents: readonly StoryContentLike[],
  pouredParagraphs: readonly number[],
  cells: readonly CellContent[],
): PicturesRead {
  const body: PictureRead[][] = [];
  contents.forEach((c, k) => {
    for (const p of c.paragraphs.slice(0, kept(c, pouredParagraphs[k])))
      body.push(picturesOfParagraph(p));
  });
  return {
    body,
    cells: cells
      .filter((c) => (c.paragraphs ?? []).length > 0)
      .map((c) => ({
        block: c.block,
        cell: c.cell,
        paragraphs: (c.paragraphs ?? []).map(picturesOfParagraph),
      })),
  };
}

/** The paragraphs `mergeSectionContents` keeps of each story: its trailing
 *  empty paragraphs past the ones poured are dropped. */
function kept(c: StoryContentLike, poured: number | undefined): number {
  const ps = c.paragraphs;
  let n = ps.length;
  const expected = poured ?? n;
  while (n > expected && ps[n - 1].runs.every((r) => r.text === "")) n -= 1;
  return n;
}

/** The engine's notes of one kind in document order: the body stories in
 *  order, then each story's reference offsets. Notes elsewhere (a master
 *  story) are not the document's. */
function inOrder(
  notes: readonly NoteRead[],
  storyIds: readonly string[],
): Array<{ text: string }> {
  return notes
    .filter((n) => storyIds.includes(n.storyId))
    .slice()
    .sort(
      (a, b) =>
        storyIds.indexOf(a.storyId) - storyIds.indexOf(b.storyId) ||
        a.offset - b.offset,
    )
    .map((n) => ({ text: n.text }));
}

async function collection(
  host: BundleHost,
  name: "footnotes" | "endnotes",
): Promise<NoteRead[]> {
  try {
    return (await host.document.collection(name)) as unknown as NoteRead[];
  } catch {
    return [];
  }
}

/**
 * Read what the structure save-back needs. `contents` are the body stories
 * read back (in `storyIds` order) and `pouredParagraphs` what the pour put
 * in each, as `mergeSectionContents` took them.
 */
export async function readStructure(
  host: BundleHost,
  ir: LoweredDoc,
  storyIds: readonly string[],
  contents: readonly StoryContentLike[],
  pouredParagraphs: readonly number[],
  cells: readonly CellContent[] = [],
): Promise<StructureRead> {
  const headers: StructureRead["headers"] = [];
  const readStory = host.document.storyContent;
  for (const m of ir.masters ?? []) {
    for (const f of [m.header, m.footer]) {
      if (!f) continue;
      const content = (await readStory.call(
        host.document,
        f.storyId,
      )) as StoryContentLike | null;
      if (content) headers.push({ part: f.part, content });
    }
  }
  const anchors: StructureRead["anchors"] = [];
  let base = 0;
  contents.forEach((c, k) => {
    for (const a of (c as StoryRead).textAnchors ?? []) {
      anchors.push({
        name: a.name,
        paragraph: base + a.paragraph,
        offset: a.offset,
      });
    }
    base += kept(c, pouredParagraphs[k]);
  });
  return {
    headers,
    footnotes: inOrder(await collection(host, "footnotes"), storyIds),
    endnotes: inOrder(await collection(host, "endnotes"), storyIds),
    anchors,
    textBoxes: await readTextBoxes(host, ir),
    pictures: readPictures(contents, pouredParagraphs, cells),
  };
}
