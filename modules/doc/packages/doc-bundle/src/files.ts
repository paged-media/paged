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

// Doc ADR 616 — the files paged.doc opens and writes, as host glue. The
// engine decides every format by its bytes (docx-js `open_file`): a
// template opens as a new untitled document, a .docm keeps its macros, RTF
// and OpenDocument become a .docx, a .doc is refused. This file only
// reports what the open did, reads the native document for "Save as
// .docx", and pours pasted RTF at the caret.

import type { LoweredDoc, LoweredParagraph } from "@paged-media/doc-host-model";
import {
  buildStyleMutations,
  buildTextPour,
} from "@paged-media/doc-host-model";
import type { BundleHost } from "@paged-media/plugin-api";

import type { DocEngine, OpenReport } from "./engine.js";
import { applyStyleOpsReporting } from "./pour.js";
import { canvasColors } from "./save-cells.js";
import { readStyles, styleColors } from "./save-styles.js";

/** Diagnostics key for what opening the file said. */
export const FILE_DIAGNOSTICS_KEY = "media.paged.doc/file";

/** Extensions the Word importer claims (the engine refuses a .doc). */
export const WORD_EXTENSIONS = [
  ".docx",
  ".dotx",
  ".docm",
  ".dotm",
  ".rtf",
  ".doc",
] as const;

/** MIME types of those. */
export const WORD_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.document.macroEnabled.12",
  "application/vnd.ms-word.template.macroEnabled.12",
  "application/rtf",
  "text/rtf",
  "application/msword",
] as const;

/** Extensions and MIME types of the OpenDocument importer (behind a flag). */
export const ODT_EXTENSIONS = [".odt", ".ott"] as const;
export const ODT_MIME_TYPES = [
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.text-template",
] as const;

/** Publish what the open said (a template, macros, what was left out). */
export function reportOpen(host: BundleHost, report: OpenReport): void {
  host.diagnostics.set(
    FILE_DIAGNOSTICS_KEY,
    report.diagnostics.map((message) => ({
      severity: "info" as const,
      message,
    })),
  );
}

/** Publish a refused file (a .doc, OpenDocument while it is off). */
export function reportRefusal(host: BundleHost, message: string): void {
  host.diagnostics.set(FILE_DIAGNOSTICS_KEY, [
    { severity: "error" as const, message },
  ]);
}

interface StoryRead {
  selfId: string;
  paragraphs: Array<{
    paragraphStyle?: string | null;
    runs: Array<{ text: string; characterStyle?: string | null }>;
  }>;
}

/**
 * "Save as .docx" for a document that did not come from Word: its stories
 * (in the host's order), the styles and colours they use, and the first
 * page, written by the engine as a new package. Null on a host without the
 * story read, or when the document has no text.
 */
export async function nativeDocx(
  host: BundleHost,
  engine: DocEngine,
): Promise<{ bytes: Uint8Array; leftOut: string[] } | null> {
  if (!host.supports("document.readStory@1")) return null;
  const stories = await host.document
    .collection<{ selfId: string }>("stories")
    .catch(() => []);
  const read: StoryRead[] = [];
  for (const s of stories) {
    const c = (await host.document.storyContent(s.selfId)) as StoryRead | null;
    if (c && c.paragraphs.length > 0) read.push(c);
  }
  if (read.length === 0) return null;
  const tokens = new Set<string>();
  for (const s of read)
    for (const p of s.paragraphs) {
      if (p.paragraphStyle) tokens.add(p.paragraphStyle);
      for (const r of p.runs)
        if (r.characterStyle) tokens.add(r.characterStyle);
    }
  const styles = await readStyles(host, [...tokens]);
  const colors = await canvasColors(
    host,
    read.flatMap((s) => s.paragraphs),
    [],
    styleColors(styles),
  );
  const pages = await host.document
    .collection<{
      sizePt?: [number, number];
      marginTopPt?: number;
      marginLeftPt?: number;
      marginBottomPt?: number;
      marginRightPt?: number;
    }>("pages")
    .catch(() => []);
  const first = pages[0];
  const page = first?.sizePt
    ? {
        widthPt: first.sizePt[0],
        heightPt: first.sizePt[1],
        marginTopPt: first.marginTopPt,
        marginLeftPt: first.marginLeftPt,
        marginBottomPt: first.marginBottomPt,
        marginRightPt: first.marginRightPt,
      }
    : undefined;
  const bytes = engine.nativeDocx({ stories: read, styles, colors, page });
  return { bytes, leftOut: engine.lastSaveSkips() };
}

/** The contiguous-character offset of content offset `bytes` (run bytes
 *  plus one `\n` per paragraph boundary) in a story's paragraphs. */
export function characterOffset(story: StoryRead, bytes: number): number {
  const encoder = new TextEncoder();
  let b = 0;
  let c = 0;
  story.paragraphs.forEach((p, i) => {
    const text = (i > 0 ? "\n" : "") + p.runs.map((r) => r.text).join("");
    for (const ch of text) {
      if (b >= bytes) return;
      b += encoder.encode(ch).length;
      c += ch.length;
    }
  });
  return c;
}

/**
 * Pour the paragraphs of a lowered RTF (pasted) at the caret: its styles
 * created, its text inserted, paragraph and character styles applied.
 * Returns the number of paragraphs inserted; 0 when there is no caret.
 */
export async function pasteLowered(
  host: BundleHost,
  ir: LoweredDoc,
): Promise<number> {
  const caret = host.text.caret();
  if (!caret) return 0;
  const story = (await host.document.storyContent(
    caret.storyId,
  )) as StoryRead | null;
  if (!story) return 0;
  const paragraphs = ir.story.blocks.flatMap((b) =>
    b.kind === "paragraph" ? [b as LoweredParagraph] : [],
  );
  if (paragraphs.length === 0) return 0;
  await applyStyleOpsReporting(host, buildStyleMutations(ir));
  const pour = buildTextPour(
    paragraphs,
    caret.storyId,
    caret.offset,
    characterOffset(story, caret.offset),
  );
  const ops = [...pour.mutations, ...pour.carets];
  const res = await host.document.mutate({
    op: "batch",
    args: { ops },
  } as never);
  return res.applied ? paragraphs.length : 0;
}
