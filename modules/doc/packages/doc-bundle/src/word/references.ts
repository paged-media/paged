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

// The References panel's actions (doc ADR 612) over the host: each is one
// engine mutation at the caret (`structure.ts`), or, for the page setup,
// one batch on the caret's section page and its frame — generated pages
// take the page's size, margins and frame options from it (ADR 026).

import type { BundleHost } from "@paged-media/plugin-api";

import type {
  PageSetup,
  ReferencesActions,
  ReferenceTarget,
} from "../panels/references-panel.js";
import {
  insertBookmark,
  insertCrossReference,
  insertIndexEntry,
  insertNote,
  insertWordField,
} from "./structure.js";

interface Content {
  paragraphs: Array<{ paragraphStyle?: string; runs: Array<{ text: string }> }>;
  textAnchors?: Array<{ name: string }>;
}

/** Word's heading styles by name (`heading 1`…), as the lowering names
 *  their tokens (`ParagraphStyle/docx-Heading1`). */
function isHeading(style: string | undefined): boolean {
  return /heading\s?\d$/i.test(style ?? "");
}

/** The references actions for the stories `docStories` names. */
export function referencesActions(
  host: BundleHost,
  docStories: () => Promise<string[]>,
): ReferencesActions {
  const ok = (p: Promise<{ applied: boolean }>) => p.then((r) => r.applied);
  return {
    insertBookmark: (name) => ok(insertBookmark(host, name)),
    insertField: (code) => ok(insertWordField(host, code)),
    insertIndexEntry: (topic) => ok(insertIndexEntry(host, topic)),
    insertNote: (endnote, text) => ok(insertNote(host, endnote, text)),
    insertCrossReference: (target, referTo) =>
      ok(insertCrossReference(host, target, referTo)),
    async targets() {
      const out: ReferenceTarget[] = [];
      const bookmarks: ReferenceTarget[] = [];
      for (const storyId of await docStories()) {
        const c = (await host.document.storyContent(
          storyId,
        )) as unknown as Content | null;
        if (!c) continue;
        c.paragraphs.forEach((p, paragraph) => {
          if (!isHeading(p.paragraphStyle)) return;
          const text = p.runs.map((r) => r.text).join("");
          if (text.trim() === "") return;
          out.push({ label: text, target: { storyId, paragraph } });
        });
        // Word lists its own hidden bookmarks (`_Toc…`, `_Ref…`) only on
        // request; the headings stand for them here.
        for (const a of c.textAnchors ?? []) {
          if (!a.name.startsWith("_")) {
            bookmarks.push({ label: a.name, target: { bookmark: a.name } });
          }
        }
      }
      return [...bookmarks, ...out];
    },
    async pageSetup() {
      const sel = host.text?.selection();
      const stories = await docStories();
      const k = Math.max(0, sel ? stories.indexOf(sel.storyId) : 0);
      const pages = (await host.document.collection("pages")) as Array<{
        selfId: string;
        sizePt?: [number, number];
        marginTopPt?: number;
        marginBottomPt?: number;
        marginLeftPt?: number;
        marginRightPt?: number;
        columnCount?: number;
      }>;
      const page = pages.find((p) => p.selfId === `docx_p${k}`);
      if (!page?.sizePt) return null;
      return {
        widthPt: page.sizePt[0],
        heightPt: page.sizePt[1],
        marginTopPt: page.marginTopPt ?? 72,
        marginBottomPt: page.marginBottomPt ?? 72,
        marginLeftPt: page.marginLeftPt ?? 72,
        marginRightPt: page.marginRightPt ?? 72,
        columns: page.columnCount ?? 1,
      };
    },
    async applyPageSetup(s: PageSetup) {
      const sel = host.text?.selection();
      const stories = await docStories();
      const k = Math.max(0, sel ? stories.indexOf(sel.storyId) : 0);
      return (
        await host.document.mutate({
          op: "batch",
          args: { ops: pageSetupOps(`docx_p${k}`, `docx_f${k}`, s) },
        } as never)
      ).applied;
    },
  };
}

/** The writes of a page setup on a Word section's page and its frame:
 *  the page's size and margins, the frame on the new margin box with the
 *  columns. */
export function pageSetupOps(
  pageId: string,
  frameId: string,
  s: PageSetup,
): unknown[] {
  const len = (value: number) => ({ type: "length", value });
  const page = (path: string, value: number) => ({
    op: "set",
    args: { address: `page:${pageId}`, path, value: len(value) },
  });
  const columns = Math.max(1, Math.round(s.columns));
  return [
    {
      op: "resizePage",
      args: { pageId, bounds: [0, 0, s.heightPt, s.widthPt] },
    },
    page("pageMarginTop", s.marginTopPt),
    page("pageMarginBottom", s.marginBottomPt),
    page("pageMarginLeft", s.marginLeftPt),
    page("pageMarginRight", s.marginRightPt),
    page("pageColumnCount", columns),
    {
      op: "resizeFrame",
      args: {
        frameId,
        bounds: [
          s.marginTopPt,
          s.marginLeftPt,
          s.heightPt - s.marginBottomPt,
          s.widthPt - s.marginRightPt,
        ],
      },
    },
    {
      op: "set",
      args: {
        address: `frame:${frameId}`,
        path: "textFrameColumnCount",
        value: len(columns),
      },
    },
  ];
}
