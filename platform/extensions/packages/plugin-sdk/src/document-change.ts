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
//                     without a `mutationApplied`, and the reply does not say
//                     which pages (or whether anything) changed
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
    case "mutationApplied": {
      // Reflow (v38, C-2): only a `resizeFrame` carries it — a content-box
      // change, never a pure transform (§8.5) — so a pagination consumer
      // re-splits on a resize and ignores a move.
      const reflow = msg.payload.reflow;
      return {
        kind: msg.kind,
        pageIds: [...(msg.payload.pageIds ?? [])],
        ...(reflow ? { reflow: { frameId: reflow.frameId, contentBox: reflow.contentBox } } : {}),
      };
    }
    case "undoApplied":
    case "redoApplied":
    case "gestureCommitted":
      return { kind: msg.kind, pageIds: [...(msg.payload.pageIds ?? [])] };
    case "scriptResult":
      // The engine reports neither the pages a script touched nor whether it
      // wrote at all: every page may have changed.
      return { kind: msg.kind, pageIds: [], pagesUnknown: true };
    default:
      return null;
  }
}
