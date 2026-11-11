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

// `paged.insert.star` — Illustrator's Star: Radius 1, Radius 2, points and
// rotation, centred on the current page (or at a typed centre).
//
// WHY THIS LIVES IN THE EDITOR AND NOT IN A PLUGIN. A star is a polygon the
// engine already draws (engine ADR 1047: `frameShapeSides` +
// `frameShapeStarInset`), the Polygon tool draws one by drag, and the
// Transform panel and the canvas widgets edit it. paged.draw carried a
// parametrised Insert star… beside them (PM-0017: one implementation).
//
//  1. RUN BARE (the menu row, the palette) the command opens the Star
//     dialog; run with a payload (`radius1`, `radius2`, `points`,
//     `rotationDeg`, optionally `cx`, `cy` page-local pt and a `page` id) it
//     inserts. The dialog's OK runs the same command.
//  2. THE WRITE IS `starMutationFor` (`@paged-media/vector-geometry`): a LIVE star
//     (one batch: the polygon on Radius 1, its points, its inset) where the
//     engine draws it, a plain closed path otherwise (turned, or Radius 2
//     the larger). It wears the drawing tools' graphic default and is
//     selected, like every insert (`mutateGraphicAndSelect`).

import {
  scopeOf,
  type CommandContribution,
  type MenuItemContribution,
  type PagedEditor,
} from "@paged-media/shell";
import type { Mutation } from "@paged-media/client";
import { starMutationFor, starParamsFrom } from "@paged-media/vector-geometry";
import { mutateGraphicAndSelect } from "@paged-media/tools";
import { defineMessages, t } from "@paged-media/strings";

import {
  blockedFor,
  currentPageTarget,
  insertApplies,
  outcomeOf,
  refused,
  refusedTap,
  REFUSED,
  type InsertOutcome,
  type InsertReport,
} from "./insert-commands";
import { layoutPages } from "./ui/layout";
import { openStarDialog } from "./panels/star-dialog";

const M = defineMessages("app.starCommands", {
  title: "Insert: Star…",
  degenerate: "a star needs a radius larger than 0.",
});

export const PAGED_INSERT_STAR = "paged.insert.star";

const VERB = "Insert star";

/** Whether a payload carries any star parameter (so the command inserts
 *  rather than opening the dialog). */
export function hasStarParams(payload: unknown): boolean {
  const p = (payload ?? {}) as Record<string, unknown>;
  return ["radius1", "radius2", "points", "rotationDeg", "cx", "cy"].some(
    (k) => k in p,
  );
}

/** Insert a star: centred on the current page unless the payload names a
 *  page and a centre. */
export async function insertStar(
  paged: PagedEditor,
  report: InsertReport,
  payload?: Record<string, unknown>,
): Promise<InsertOutcome> {
  if (blockedFor(paged, report, VERB)) return REFUSED;
  const target = currentPageTarget(paged);
  if (!target) return REFUSED;
  // A named page: its id and its size (the centre default is its centre).
  let pageId = target.pageId;
  let rect = target.rect;
  const named = typeof payload?.page === "string" ? payload.page : null;
  const handle = paged.document.handle;
  if (named && handle) {
    const i = handle.pageIds.indexOf(named as never);
    const rects = layoutPages(handle.pageSizesPt, handle.pageOriginsPt);
    if (i >= 0 && rects[i]) {
      pageId = handle.pageIds[i]!;
      rect = rects[i]!;
    }
  }
  const params = starParamsFrom(payload, {
    cx: rect.w / 2,
    cy: rect.h / 2,
    radius1: 50,
    radius2: 25,
    points: 5,
    rotationDeg: 0,
  });
  const mutation = starMutationFor(pageId, params);
  if (!mutation) {
    report("error", refused(VERB, t(M.degenerate)));
    return REFUSED;
  }
  const reply = await mutateGraphicAndSelect(
    paged,
    mutation as unknown as Mutation,
    "insertStar",
    refusedTap(report, VERB),
  );
  return outcomeOf(reply);
}

/** Gated like every insert: a document, at its root. */
export function buildStarCommands(
  report: InsertReport,
  clear: () => void,
): CommandContribution[] {
  return [
    {
      id: PAGED_INSERT_STAR,
      get title() {
        return t(M.title);
      },
      category: "Insert",
      when: insertApplies,
      handler: (paged, payload) => {
        if (!hasStarParams(payload)) {
          openStarDialog(scopeOf(paged));
          return undefined;
        }
        clear();
        return insertStar(
          paged as PagedEditor,
          report,
          payload as Record<string, unknown>,
        );
      },
    },
  ];
}

/** Object > Insert star…, beside the other inserts. */
export const STAR_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "Object/Insert star…",
    command: PAGED_INSERT_STAR,
    icon: "tool-polygon",
    order: 5.5,
    group: "insert",
    when: insertApplies,
  },
];
