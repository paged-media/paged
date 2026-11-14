/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The targeted fixes of a publication issue (editor ADR 1223): what the
// engine offers for it, each with what it will do said before it runs
// (its preview) and, for a document change, one undo step. A picture's
// link is relinked to a file the user picks (engine ADR 1308); where the
// engine has no operation, the fix is the panel that handles it, never a
// button that pretends.

import type { ElementId, PageSummary } from "@paged-media/client";
import type { PagedEditor, PublicationIssue } from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import { relinkFromPicker } from "./relink";
import { moveFixWords, CONSTRAINT_WORDS } from "./constraints/describe";
import type { Box } from "./constraints/evaluate";
import { applyMoveFix } from "./constraints/fixes";
import { constraintStateOf } from "./constraints/store";

const M = defineMessages("app.issueFixes", {
  expandFrame: "Expand frame",
  expandFramePreview: "Extends the frame {grow} pt down, to the bottom margin.",
  showStories: "Show in Stories",
  relink: "Relink…",
  relinkPreview:
    "Choose the picture's file: the frame, its fitting and the picture's size stay. One undo step.",
  openLinks: "Open Links",
  openLinksPreview: "See every link in the Links panel.",
  openFonts: "Find font",
  openFontsPreview: "Add or replace the font in the Fonts panel.",
  openPreflight: "Open Preflight",
  openReport: "Open the compatibility report",
  openData: "Open Data",
});

/** One fix: a label, what it will do, and how. */
export interface IssueFix {
  id: string;
  label: string;
  /** What it will do, said before it runs. */
  preview?: string;
  /** Where it would put what it moves or grows, page-local: drawn on the
   *  canvas while the fix has the pointer or the focus (editor ADR 1233). */
  ghosts?: ReadonlyArray<{ pageId: string; box: Box }>;
  /** A document change (one undo step), a panel to open, or advice only
   *  (what the user has to do; the editor has no change to offer). */
  run:
    | { kind: "mutate"; apply: (paged: PagedEditor) => Promise<boolean> }
    | { kind: "panel"; panel: string }
    | { kind: "note" };
}

/** How far a frame can grow down: to its page's bottom margin, for a frame
 *  that is not rotated or skewed. Null when there is no room or no page. */
export async function expandFramePlan(
  paged: PagedEditor,
  frame: ElementId,
): Promise<{
  bounds: [number, number, number, number];
  grow: number;
  /** The frame as it would be, page-local `[x, y, w, h]`, and its page. */
  pageId: string;
  box: Box;
} | null> {
  const [g] = await paged.client.elementGeometry([frame]);
  if (!g?.pageId || g.bounds.length < 4) return null;
  const [a, b, c, d, tx, ty] = (g.itemTransform ?? [
    1, 0, 0, 1, 0, 0,
  ]) as number[];
  if (
    Math.abs(a! - 1) > 1e-6 ||
    Math.abs(d! - 1) > 1e-6 ||
    Math.abs(b!) > 1e-6 ||
    Math.abs(c!) > 1e-6
  )
    return null;
  const pages = await paged.client.collection<PageSummary>("pages");
  const page = pages.find((p) => p.selfId === g.pageId);
  if (!page) return null;
  const [top, left, bottom, right] = g.bounds as [
    number,
    number,
    number,
    number,
  ];
  const limit = page.sizePt[1] - (page.marginBottomPt ?? 0) - (ty ?? 0);
  const grow = Math.round((limit - bottom) * 100) / 100;
  if (grow < 0.5) return null;
  return {
    bounds: [top, left, limit, right],
    grow,
    pageId: g.pageId,
    box: [left + (tx ?? 0), top + (ty ?? 0), right - left, limit - top],
  };
}

/** The Expand frame fix of an overset frame, planned. */
async function expandFrameFix(
  paged: PagedEditor,
  frame: ElementId,
): Promise<IssueFix | null> {
  const plan = await expandFramePlan(paged, frame).catch(() => null);
  if (!plan) return null;
  return {
    id: "expand-frame",
    label: t(M.expandFrame),
    preview: t(M.expandFramePreview, { grow: plan.grow }),
    ghosts: [{ pageId: plan.pageId, box: plan.box }],
    run: {
      kind: "mutate",
      apply: async (p) => {
        const reply = await p.client.mutate({
          op: "resizeFrame",
          args: { frameId: frame.id as string, bounds: plan.bounds },
        });
        return reply.kind === "mutationApplied";
      },
    },
  };
}

/** A design constraint's fixes (editor ADR 1233): the moves its evaluation
 *  planned, Expand frame for text that must fit, or what the user has to
 *  do when only other words or other type would make it hold. */
async function constraintFixes(
  paged: PagedEditor,
  issue: PublicationIssue,
): Promise<IssueFix[]> {
  const id = issue.id.replace(/^constraint:/, "");
  const { constraints, results } = constraintStateOf(paged.scope);
  const c = constraints.find((x) => x.id === id);
  const plan = results.get(id)?.fix;
  if (!c || !plan) return [];
  switch (plan.kind) {
    case "move": {
      if (plan.moves.length === 0) return [];
      const words = moveFixWords(c, plan);
      return [
        {
          id: "constraint-move",
          label: words.label,
          preview: words.preview,
          ghosts: plan.ghosts,
          run: { kind: "mutate", apply: (p) => applyMoveFix(p, plan) },
        },
      ];
    }
    case "expand-frame": {
      const fix = await expandFrameFix(paged, plan.member);
      return fix ? [fix] : [];
    }
    case "edit-text":
      return [
        {
          id: "constraint-edit-text",
          label: t(CONSTRAINT_WORDS.fixEditText),
          preview: t(CONSTRAINT_WORDS.fixEditTextPreview),
          run: { kind: "note" },
        },
      ];
  }
}

/** The fixes of `issue`. Async: a fix that changes the document is
 *  planned first, so its preview says exactly what it will do. */
export async function fixesOf(
  paged: PagedEditor,
  issue: PublicationIssue,
): Promise<IssueFix[]> {
  switch (issue.kind) {
    case "overset": {
      const out: IssueFix[] = [];
      const frame = issue.element;
      if (frame && typeof frame.id === "string") {
        const fix = await expandFrameFix(paged, frame);
        if (fix) out.push(fix);
      }
      out.push({
        id: "show-stories",
        label: t(M.showStories),
        run: { kind: "panel", panel: "paged.stories" },
      });
      return out;
    }
    case "missing-link":
    case "low-res":
    case "color-space": {
      const out: IssueFix[] = [];
      const frame = issue.element;
      // A picture is relinked in place (engine ADR 1308).
      if (frame && typeof frame.id === "string") {
        const id = frame.id;
        out.push({
          id: "relink",
          label: t(M.relink),
          preview: t(M.relinkPreview),
          run: { kind: "mutate", apply: (p) => relinkFromPicker(p, id) },
        });
      }
      out.push({
        id: "open-links",
        label: t(M.openLinks),
        preview: t(M.openLinksPreview),
        run: { kind: "panel", panel: "paged.links" },
      });
      return out;
    }
    case "missing-font":
      return [
        {
          id: "open-fonts",
          label: t(M.openFonts),
          preview: t(M.openFontsPreview),
          run: { kind: "panel", panel: "paged.fonts" },
        },
      ];
    case "output-standard":
      return [
        {
          id: "open-preflight",
          label: t(M.openPreflight),
          run: { kind: "panel", panel: "paged.preflight" },
        },
      ];
    case "import-loss":
      return [
        {
          id: "open-report",
          label: t(M.openReport),
          run: { kind: "panel", panel: "paged.import-report" },
        },
      ];
    case "constraint":
      return constraintFixes(paged, issue);
    case "missing-data":
      return [
        {
          id: "open-data",
          label: t(M.openData),
          run: { kind: "panel", panel: "paged.data" },
        },
      ];
    default:
      return [];
  }
}
