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

// What the constraint evaluation reads from the engine (editor ADR 1233),
// and only what it already reports: one batched `elementGeometry` for every
// member (its page and box), the pages collection (sizes, margins, the
// spine's side), the stories collection (overset), and, for a text frame a
// constraint asks about its lines, `selectionGeometry` over its story (one
// box per laid-out line, each naming its frame). Reads only.

import type {
  CanvasClient,
  ElementGeometryItem,
  ElementId,
  PageSummary,
  StorySummary,
} from "@paged-media/client";

import {
  boxOfGeometry,
  type DocumentFacts,
  type MemberFacts,
  type PageFacts,
} from "./evaluate";
import { memberKey, type Constraint } from "./model";

/** The reads the measurement makes. */
export type MeasureClient = Pick<
  CanvasClient,
  "elementGeometry" | "selectionGeometry"
>;

/** The pages as the evaluation reads them. */
export function pageFactsOf(
  pages: readonly PageSummary[],
): Map<string, PageFacts> {
  const out = new Map<string, PageFacts>();
  pages.forEach((p, i) =>
    out.set(p.selfId, {
      id: p.selfId,
      index: p.index ?? i,
      size: p.sizePt,
      margins: {
        top: p.marginTopPt ?? 0,
        left: p.marginLeftPt ?? 0,
        bottom: p.marginBottomPt ?? 0,
        right: p.marginRightPt ?? 0,
      },
      ...(p.bindingEdge ? { bindingEdge: p.bindingEdge } : {}),
    }),
  );
  return out;
}

/** Every member of `constraints`, once. */
export function membersOf(constraints: readonly Constraint[]): ElementId[] {
  const seen = new Map<string, ElementId>();
  for (const c of constraints)
    for (const m of c.members) seen.set(memberKey(m), m);
  return [...seen.values()];
}

/** The text frames whose lines a constraint asks about. */
export function textFramesToRead(
  constraints: readonly Constraint[],
): Set<string> {
  const out = new Set<string>();
  for (const c of constraints) {
    if (
      c.kind === "max-lines" ||
      (c.kind === "align" && c.params.edge === "baseline")
    )
      for (const m of c.members)
        if (m.kind === "textFrame") out.add(memberKey(m));
  }
  return out;
}

/** The members' geometry: one batched read; a batch the engine refuses (a
 *  stale id among them) is read one by one, so one gone member does not
 *  hide the others. */
export async function readGeometry(
  client: MeasureClient,
  ids: readonly ElementId[],
): Promise<Map<string, ElementGeometryItem>> {
  const out = new Map<string, ElementGeometryItem>();
  if (ids.length === 0) return out;
  const take = (items: readonly ElementGeometryItem[]) => {
    for (const g of items) out.set(memberKey(g.id), g);
  };
  try {
    take(await client.elementGeometry([...ids]));
  } catch {
    for (const id of ids) {
      try {
        take(await client.elementGeometry([id]));
      } catch {
        /* gone: the constraint reads unknown */
      }
    }
  }
  return out;
}

/** A text frame's lines and the foot of its first line, from its story's
 *  laid-out lines (one rect per line, page-local, each naming its frame). */
export async function readLines(
  client: MeasureClient,
  frameId: string,
  storyId: string,
  characterCount: number,
): Promise<{ lines: number; firstLineFoot: number | null } | null> {
  try {
    const rects = await client.selectionGeometry({
      storyId,
      start: 0,
      end: Math.max(characterCount, 1),
    });
    const mine = rects
      .filter((r) => r.frameId === frameId)
      .sort((a, b) => a.topPt - b.topPt);
    const tops = new Set(mine.map((r) => Math.round(r.topPt * 10)));
    const first = mine[0];
    return {
      lines: tops.size,
      firstLineFoot: first ? first.topPt + first.heightPt : null,
    };
  } catch {
    return null;
  }
}

/** The facts of the members of `constraints`. `textOf` limits the line
 *  reads to these frames (the viewport's first; null: every one asked). */
export async function measureFacts(
  client: MeasureClient,
  constraints: readonly Constraint[],
  pages: ReadonlyMap<string, PageFacts>,
  stories: readonly StorySummary[] | null,
  options: {
    geometry?: ReadonlyMap<string, ElementGeometryItem>;
    textOf?: ReadonlySet<string> | null;
  } = {},
): Promise<DocumentFacts> {
  const ids = membersOf(constraints);
  const geometry = options.geometry ?? (await readGeometry(client, ids));
  const storyById = new Map((stories ?? []).map((s) => [s.selfId, s]));
  const wantLines = textFramesToRead(constraints);
  const members = new Map<string, MemberFacts>();
  for (const id of ids) {
    const key = memberKey(id);
    const g = geometry.get(key);
    if (!g || g.bounds.length < 4) continue;
    const f: MemberFacts = {
      pageId: g.pageId ?? null,
      box: boxOfGeometry(g.bounds, g.itemTransform),
    };
    if (id.kind === "textFrame") {
      const story = g.storyId ? storyById.get(g.storyId) : undefined;
      f.overset = story ? Boolean(story.overset) : stories ? false : null;
      if (
        wantLines.has(key) &&
        g.storyId &&
        (!options.textOf || options.textOf.has(key))
      ) {
        const lines = await readLines(
          client,
          String(id.id),
          g.storyId,
          story?.characterCount ?? 0,
        );
        f.lines = lines?.lines ?? null;
        f.firstLineFoot = lines?.firstLineFoot ?? null;
      }
    }
    members.set(key, f);
  }
  return { members, pages };
}
