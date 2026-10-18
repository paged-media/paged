/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// WHAT COUNTS AS A DOCUMENT CHANGE (ADR 327) — the one place that decides.
//
// The engine answers a committed change to the document's content with one
// of five replies, and each is one step in the document's history:
//
//   mutationApplied   a `mutate` (a bundle's write, a panel field, a command)
//   undoApplied       an undo
//   redoApplied       a redo
//   gestureCommitted  a canvas gesture (a frame dragged, resized, rotated by
//                     its handles) committed on the engine — not a mutation
//   scriptResult      a `paged.*` script finished; it wrote through the model
//                     without a `mutationApplied`
//
// Since engine 0.71.13 (core ADR 159) two of those replies say more, and
// this file keys off PRESENCE, never off a version: a gesture that resized
// one frame carries its `reflow`; a script reply counts its own committed
// `writes` (0: it only read, so it is no change) and names the `pageIds`
// those writes changed. A reply without them is an older engine: the script
// is then a change on pages it does not name (`pagesUnknown`).
//
// `document.onDidChange`, the parent index and the core object model all
// follow the same set, so nothing the host derives from the document can be
// fresher or staler than what a bundle is told. The editor's client counts
// the same replies as edits.

import type { DocumentChangeEvent, PagedEditor } from "@paged-media/plugin-api";

/** A message on the editor client's broadcast. */
export type ClientMessage = Parameters<Parameters<PagedEditor["client"]["subscribe"]>[0]>[0];

/** The bundle-facing event for a reply that committed a change to the
 *  document, or `null` for every other message. */
export function documentChangeOf(msg: ClientMessage): DocumentChangeEvent | null {
  switch (msg.kind) {
    case "mutationApplied":
    case "gestureCommitted":
      // Reflow (v38, C-2): a `resizeFrame`, and since 0.71.13 a gesture that
      // resized ONE frame by its handles, carry it — a content-box change,
      // never a pure transform (§8.5) — so a pagination consumer re-splits
      // on a resize and ignores a move.
      return {
        kind: msg.kind,
        pageIds: [...(msg.payload.pageIds ?? [])],
        ...reflowOf(msg.payload.reflow),
      };
    case "undoApplied":
    case "redoApplied":
      return { kind: msg.kind, pageIds: [...(msg.payload.pageIds ?? [])] };
    case "scriptResult": {
      const { writes, pageIds } = msg.payload;
      // The script committed nothing of its own: it only read. (Writes the
      // host made answering it were `mutationApplied`s of their own.)
      if (writes === 0) return null;
      // The pages its writes changed; empty is a write no page draws (a
      // label), which still changed the document.
      if (typeof writes === "number" && Array.isArray(pageIds)) {
        return { kind: msg.kind, pageIds: [...pageIds] };
      }
      // An older engine (or no document): neither the pages nor whether it
      // wrote is known, so every page may have changed.
      return { kind: msg.kind, pageIds: [], pagesUnknown: true };
    }
    default:
      return null;
  }
}

function reflowOf(
  reflow: { frameId: string; contentBox: [number, number, number, number] } | null | undefined,
): Pick<DocumentChangeEvent, "reflow"> {
  return reflow ? { reflow: { frameId: reflow.frameId, contentBox: reflow.contentBox } } : {};
}
