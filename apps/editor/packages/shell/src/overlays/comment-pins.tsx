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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Editor ADR 291 — View ▸ Show data markers: which frames the document's
// data is placed in, and whether each is in step with the data.

// Engine ADR 1055 — a pin on the canvas for every comment thread that is not on
// a text range: a speech-bubble marker with the author's initials at the
// thread's place on its page (a page point, an item's corner, a page used as a
// module's address). Click one and the Comments panel opens on that thread.
// A resolved thread is faint; an orphaned one (its target deleted) has no place
// and no pin. Overlay chrome: it never prints or exports.
//
// Text comments keep the margin band (editor ADR 300); every other anchor, in
// every module, gets its pin here, so no module draws its own.

import type { CommentSummary } from "@paged-media/client";

import { useCockpitActions } from "../cockpit/cockpit-state-context";
import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useCollection } from "../catalog/use-collection";
import {
  focusThread,
  getFocusedThread,
  subscribeFocusedThread,
} from "../state/comment-focus";
import { useEditorScope } from "../state/editor-scope";
import { useSyncExternalStore } from "react";

/** The Comments panel's id. */
export const COMMENTS_PANEL = "paged.comments";

/** One pin to draw. */
export interface CommentPin {
  /** The thread's id. */
  id: string;
  page: string;
  /** Points from the page's top-left. */
  at: [number, number];
  initials: string;
  resolved: boolean;
  replies: number;
}

/** Where a module's address of an item points (`contribute.commentAnchor`,
 *  extensions ADR 1101): the shared registry the canvas injects into every
 *  bundle host. */
export interface CommentAnchorLookup {
  resolve(item: string, address: string): { rect?: number[] } | null;
  /** The address selected in `item` now (a sheet's active cell). */
  selected?(item: string): string | null;
  onDidChange(listener: () => void): { dispose(): void };
}

let lookup: CommentAnchorLookup | null = null;
let lookupVersion = 0;
const lookupListeners = new Set<() => void>();
let lookupSubscription: { dispose(): void } | null = null;

/** The canvas hands over the registry once, at mount. */
export function setCommentAnchorLookup(next: CommentAnchorLookup | null) {
  lookupSubscription?.dispose();
  lookup = next;
  lookupSubscription =
    next?.onDidChange(() => {
      lookupVersion += 1;
      for (const l of [...lookupListeners]) l();
    }) ?? null;
  lookupVersion += 1;
  for (const l of [...lookupListeners]) l();
}

/** The address the owning module has selected in `item` (a sheet frame's
 *  active cell, `Sheet1!B3`), for the Comments panel's "New comment"; null
 *  when no module has one. Read at the moment of the click: a module's cell
 *  selection moves without a document change. */
export function selectedCommentAddress(item: string): string | null {
  try {
    return lookup?.selected?.(item) ?? null;
  } catch {
    return null;
  }
}

const subscribeLookup = (l: () => void) => {
  lookupListeners.add(l);
  return () => void lookupListeners.delete(l);
};

/** The pins of a `comments` collection: one per document thread that stands
 *  on a page, in the engine's order. A `cell` thread stands at its cell when
 *  the owning module can say where the address is, else at its item's
 *  top-left. */
export function pinsOf(
  rows: readonly CommentSummary[],
  resolve: CommentAnchorLookup["resolve"] | null = null,
): CommentPin[] {
  const replies = new Map<string, number>();
  for (const r of rows) {
    if (r.parentId) replies.set(r.parentId, (replies.get(r.parentId) ?? 0) + 1);
  }
  const pins: CommentPin[] = [];
  for (const r of rows) {
    if (r.parentId || !r.threadId || r.orphaned || !r.page || !r.at) continue;
    let at: [number, number] = [r.at[0], r.at[1]];
    const anchor = r.anchor;
    if (resolve && anchor?.kind === "cell") {
      const rect = resolve(anchor.item, anchor.address)?.rect;
      if (rect && rect.length >= 2) at = [at[0] + rect[0]!, at[1] + rect[1]!];
    }
    pins.push({
      id: r.id,
      page: r.page,
      at,
      initials: initialsOf(r),
      resolved: r.resolved,
      replies: replies.get(r.id) ?? 0,
    });
  }
  return pins;
}

/** Up to two upper-case initials: the comment's own, else the name's. */
export function initialsOf(
  c: Pick<CommentSummary, "author" | "initials">,
): string {
  if (c.initials) return c.initials.slice(0, 3);
  const words = (c.author ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function CommentPinsRender(props: OverlayProps) {
  const rows = useCollection<CommentSummary>("comments");
  const scope = useEditorScope();
  const actions = useCockpitActions();
  const focused = useSyncExternalStore(
    (l) => subscribeFocusedThread(scope, l),
    () => getFocusedThread(scope),
    () => null,
  );
  useSyncExternalStore(
    subscribeLookup,
    () => lookupVersion,
    () => 0,
  );
  const pins = pinsOf(
    rows ?? [],
    lookup ? (i, a) => lookup!.resolve(i, a) : null,
  );
  const inv = 1 / props.camera.scale;

  return (
    <g data-comment-pins={pins.length > 0 ? "ready" : "empty"}>
      {pins.map((pin) => {
        const pr = props.pageRects.get(pin.page as never);
        if (!pr) return null;
        return (
          <g
            key={pin.id}
            data-comment-pin={pin.id}
            data-resolved={pin.resolved ? "true" : undefined}
            data-focused={focused === pin.id ? "true" : undefined}
            transform={`translate(${pr.x + pin.at[0]}, ${pr.y + pin.at[1]}) scale(${inv})`}
            opacity={pin.resolved ? 0.45 : 1}
            style={{ cursor: "pointer", pointerEvents: "all" }}
            onPointerDown={(e) => {
              // Win the pointer before the canvas starts a marquee.
              e.preventDefault();
              e.stopPropagation();
              focusThread(scope, pin.id);
              actions.openPanel?.(COMMENTS_PANEL);
            }}
          >
            <path
              d="M0 0 a10 10 0 1 1 7 9.5 L2 14 L2.5 9.5 A10 10 0 0 1 0 0 z"
              transform="translate(0,-18)"
              fill="var(--status-review)"
              stroke={focused === pin.id ? "var(--overlay-selection)" : "white"}
              strokeWidth={focused === pin.id ? 2 : 1.25}
            />
            <text
              x={8}
              y={-9}
              textAnchor="middle"
              fontSize={8}
              fontWeight={600}
              fontFamily="var(--font-sans)"
              fill="white"
              pointerEvents="none"
            >
              {pin.initials}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export const commentPinsContribution: OverlayContribution = {
  id: "paged.overlay.commentPins",
  render: CommentPinsRender,
  // Above the data markers (55), under the selection chrome (z 100).
  z: 60,
};
