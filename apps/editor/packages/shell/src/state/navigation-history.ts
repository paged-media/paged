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

// Navigation history (interaction contract UXI-CAM-016; the redesign
// strategy's §4.2; editor ADR "Navigation history and one current page"):
// Back and Forward through the places an EXPLICIT navigation left — a fit,
// a page key, a click in the Pages, Structure or Issues lens, a search,
// comment, preflight or problem jump, Go to page. A free pan or zoom (the
// wheel, the Hand, the zoom field, a preset) is not a navigation: it moves
// the camera inside the place the user is, and Back returns from where the
// last navigation started, wherever the user has wandered since.
//
// It works like a browser's: a navigation from A pushes A and forgets the
// forward entries; Back from the live camera C returns the last entry and
// keeps C for Forward; Forward does the reverse. The entries are cameras
// (scale, translation, rotation), never a selection: going back moves the
// view, not what is selected (D-15), and never the document.
//
// One per editor (it lives in the editor's camera context), emptied when
// the document changes: a camera of another document points nowhere.

import type { Camera } from "@paged-media/client";

/** How many places Back remembers. */
export const NAVIGATION_HISTORY_LIMIT = 50;

/** What the Back and Forward controls show. */
export interface NavigationHistoryState {
  /** Places Back can return to. */
  readonly back: number;
  /** Places Forward can return to. */
  readonly forward: number;
}

export interface NavigationHistory {
  /** An explicit navigation from `from` (to `to`, when known): `from`
   *  becomes the place Back returns to. Nothing is recorded when the
   *  navigation does not move the view. */
  record(from: Camera, to?: Camera): void;
  /** The place to go back to from `current` (which Forward then keeps),
   *  or null when there is none. */
  back(current: Camera): Camera | null;
  /** The place to go forward to from `current`, or null. */
  forward(current: Camera): Camera | null;
  /** Forget every place (a document change). */
  clear(): void;
  /** The counts, the same object until they change (for
   *  `useSyncExternalStore`). */
  state(): NavigationHistoryState;
  subscribe(listener: () => void): () => void;
}

/** Two cameras that show the same view: the same zoom to a part in ten
 *  thousand, the same place to half a screen pixel, the same turn. */
export function sameView(a: Camera, b: Camera): boolean {
  return (
    Math.abs(a.scale - b.scale) <= Math.abs(a.scale) * 1e-4 &&
    Math.abs(a.tx - b.tx) <= 0.5 &&
    Math.abs(a.ty - b.ty) <= 0.5 &&
    Math.abs((a.rotation ?? 0) - (b.rotation ?? 0)) <= 1e-6
  );
}

const copy = (c: Camera): Camera => ({
  scale: c.scale,
  tx: c.tx,
  ty: c.ty,
  rotation: c.rotation ?? 0,
});

export function createNavigationHistory(
  limit = NAVIGATION_HISTORY_LIMIT,
): NavigationHistory {
  const backStack: Camera[] = [];
  const forwardStack: Camera[] = [];
  const listeners = new Set<() => void>();
  let snapshot: NavigationHistoryState = { back: 0, forward: 0 };

  const changed = () => {
    if (
      snapshot.back === backStack.length &&
      snapshot.forward === forwardStack.length
    )
      return;
    snapshot = { back: backStack.length, forward: forwardStack.length };
    for (const l of [...listeners]) l();
  };

  return {
    record(from, to) {
      if (to && sameView(from, to)) return;
      const top = backStack[backStack.length - 1];
      if (!top || !sameView(top, from)) {
        backStack.push(copy(from));
        if (backStack.length > limit) backStack.shift();
      }
      forwardStack.length = 0;
      changed();
    },
    back(current) {
      // Skip entries that are where the user already is (a navigation
      // whose target was the view it started from, recorded before the
      // target was known).
      while (backStack.length > 0) {
        const to = backStack.pop()!;
        if (sameView(to, current)) continue;
        forwardStack.push(copy(current));
        changed();
        return to;
      }
      changed();
      return null;
    },
    forward(current) {
      while (forwardStack.length > 0) {
        const to = forwardStack.pop()!;
        if (sameView(to, current)) continue;
        backStack.push(copy(current));
        changed();
        return to;
      }
      changed();
      return null;
    },
    clear() {
      backStack.length = 0;
      forwardStack.length = 0;
      changed();
    },
    state: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
