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

// OVALS IN THE PLANAR ARRANGEMENT — asked through stand-ins of their curve.
//
// THE ENGINE GAP, named: an oval carries no path in the engine. `pathAnchors`
// answers no geometry for one (core `paged-canvas` `path_anchors`:
// `ElementId::Oval(_) => None`), and the arrangement's per-element lookup
// falls back to the oval's BOUNDING BOX (core `paged-mutate`
// `apply/planar_ops.rs` `locate`, the Oval arm: `path_or_bounds(&[], &[],
// f.bounds)`, "a follow-up emits the proper four-arc ellipse"). So the Shape
// Builder merged two ovals as two rectangles. The fix belongs in core — both
// doors should answer an oval with its four-arc ellipse — and until it lands
// the plugin derives the curve itself (`ovalToPath`, the same κ ellipse the
// renderer draws).
//
// HOW THE CURVE REACHES THE ARRANGEMENT. The arrangement door takes element
// ids, not geometry, so — exactly the Knife's probe (`commands/knife.ts`) —
// at COMMIT each oval gets a STAND-IN path of its curve (inserted in ONE
// batch, unpainted, in the oval's own space and transform), the arrangement
// is asked over the input list with each oval replaced by its stand-in, and
// the probe is WITHDRAWN with `document.undo()`; the build that follows is a
// new mutation, which also clears the probe off the redo stack — the reason
// the probe runs at commit and never while hovering (a hover that ended
// without a build would leave Redo re-inserting the stand-ins). The user's
// history gains exactly the build. The undo is GUARDED like the Knife's: if
// the stand-ins are still there afterwards, something else landed between
// the insert and the undo and that is what was undone — it is re-done at once
// and the stand-ins are deleted by a mutation of their own (logged: an extra
// undo step the user did not ask for, rather than a lost edit).
//
// THE STAND-IN STORES WHAT THE OVAL STORES: its curve in the oval's own
// (inner) space and the oval's STORED transform, which is spread space
// (`../page-origin.ts`). `insertPath` adds the page's origin to the anchors
// it is given, so the curve is pinned afterwards with `framePath` and
// `frameBounds` (`insertRawPathOps`, the Shape Builder's own piece insert);
// `elementGeometry` answers the transform in the oval's PAGE space, so the
// page's origin goes back onto it before it is written. Inserted as read,
// the stand-in sits beside the oval on any page that does not start at its
// spread's origin.
//
// The cost, named: over a selection with an oval in it the Shape Builder
// cannot ask the engine about faces while the pointer HOVERS (it would answer
// for the box), so no face is highlighted there — the gesture's own line is
// drawn instead, and the faces it crossed are resolved at release against
// the stand-in arrangement. A hover highlight needs the engine to answer for
// an oval's curve.
//
// What the arrangement then answers indexes the CALLER's list (the order is
// kept), and its faces are the ovals' real regions. Nothing the commit sends
// asks the engine about an oval's geometry again: an oval is never rewritten
// in place (it has no path to rewrite), its pieces are inserted and it is
// deleted (`planShapeBuild`'s `canRewrite`).

import type { BundleHost, ElementId, MutationInput } from "@paged-media/plugin-api";
import { ovalToPath, type Affine } from "@paged-media/draw-geometry";

import { bindMinted, mutateMinting } from "../commands/minted";
import { insertRawPathOps } from "../commands/shape-build";
import { batchMutationFor, handleElementId } from "../commands/v59-wire";
import { pageOriginOf, SPREAD_ORIGIN, storedTransformOf, type PageOrigin } from "../page-origin";

/** A live stand-in probe: the ids to ask the arrangement about (the
 *  caller's order, each oval replaced by its stand-in), and the withdrawal
 *  of the stand-ins. */
export interface StandInProbe {
  ids: ElementId[];
  release(): Promise<void>;
}

/** Whether `ids` holds an input the engine reads as its bounding box. */
export const hasOval = (ids: readonly ElementId[]): boolean => ids.some((id) => id.kind === "oval");

const standInHandle = (k: number): string => `sb-oval-${k}`;

/** The probe batch: one unpainted stand-in path per oval, in the oval's own
 *  space and STORED transform (module header). Null when an oval's geometry
 *  cannot be read (off the page, or a degenerate box). PURE over what
 *  `elementGeometry` answered: `itemTransform` in the oval's page space,
 *  `pageOrigin` that page's origin in its spread (absent = `[0, 0]`). */
export function ovalStandInBatchFor(
  ovals: readonly {
    pageId: string | null | undefined;
    bounds: readonly [number, number, number, number];
    itemTransform?: Affine | null;
    pageOrigin?: PageOrigin | null;
  }[],
): MutationInput | null {
  const ops: MutationInput[] = [];
  for (const [k, g] of ovals.entries()) {
    if (!g.pageId) return null;
    const table = ovalToPath(g.bounds);
    if (table.anchors.length === 0) return null;
    const stored = storedTransformOf(g.itemTransform, g.pageOrigin ?? SPREAD_ORIGIN);
    const handle = standInHandle(k);
    ops.push(
      ...insertRawPathOps(g.pageId, table, handle, stored),
      // Unpainted: a probe that is on the page for one round trip must not
      // flash a 1 pt black outline (`insertPath`'s default stroke).
      {
        op: "setElementProperty",
        args: { elementId: handleElementId(handle), path: "frameStrokeColor", value: { type: "colorRef", value: null } },
      },
      {
        op: "setElementProperty",
        args: { elementId: handleElementId(handle), path: "frameFillColor", value: { type: "colorRef", value: null } },
      },
    );
  }
  return ops.length > 0 ? batchMutationFor(ops) : null;
}

/** Put a stand-in for every oval of `ids` in the document and answer the
 *  list to ask the arrangement about, with the withdrawal (module header).
 *  A list with no oval is answered as it is, with nothing to withdraw. Null
 *  when the stand-ins could not be made — the caller asks nothing. */
export async function ovalStandIns(
  host: BundleHost,
  ids: readonly ElementId[],
  label: string,
): Promise<StandInProbe | null> {
  const at = ids.flatMap((id, i) => (id.kind === "oval" ? [i] : []));
  if (at.length === 0) return { ids: [...ids], release: async () => {} };
  let geom: Awaited<ReturnType<BundleHost["document"]["elementGeometry"]>>;
  try {
    geom = await host.document.elementGeometry(at.map((i) => ids[i]!));
  } catch {
    return null;
  }
  if (geom.length !== at.length) return null;
  const probe = ovalStandInBatchFor(
    geom.map((g) => ({
      pageId: g.pageId,
      bounds: g.bounds as [number, number, number, number],
      itemTransform: (g.itemTransform ?? null) as Affine | null,
      pageOrigin: pageOriginOf(g),
    })),
  );
  if (!probe) return null;
  const made = await mutateMinting(host, probe);
  if (!made.outcome.applied) {
    host.log.warn(`${label}: the oval stand-ins were refused: ${JSON.stringify(made.outcome.error)}`);
    return null;
  }
  const named = bindMinted(made, probe);
  const standIns = at.map((_, k) => named?.byHandle.get(standInHandle(k)) ?? null);
  if (standIns.some((s) => s === null)) {
    // Applied, but the stand-ins cannot be named: take them back out.
    await host.document.undo();
    return null;
  }
  const out = [...ids];
  at.forEach((i, k) => {
    out[i] = standIns[k]!;
  });
  return {
    ids: out,
    async release() {
      await host.document.undo();
      const lingering: ElementId[] = [];
      for (const s of standIns) {
        if (await host.document.pathAnchors(s!).catch(() => null)) lingering.push(s!);
      }
      if (lingering.length === 0) return;
      // Something else was undone instead: put it back, remove the probe.
      await host.document.redo();
      await host.document.mutate(
        batchMutationFor(lingering.map((s) => ({ op: "deleteFrame", args: { frameId: String(s.id) } }))),
      );
      host.log.warn(
        `${label}: another change landed while the ovals were being measured — it was kept, ` +
          "and the measuring paths were removed by a step of their own",
      );
    },
  };
}
