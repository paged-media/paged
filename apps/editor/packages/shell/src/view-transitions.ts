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

// The editor's view transitions (React 19.3, ADR 240): the transition
// types, and the class maps a <ViewTransition> takes for them. The CSS is
// styles/view-transitions.css (reduced motion turns every animation off).
//
// A boundary animates only for the types it names: every map falls back to
// "none", so a transition started for something else never moves it.

import { addTransitionType, startTransition } from "react";

/** The direction of a move between siblings (tabs, pages, slides): toward
 *  the end of their order or toward the start. */
export type TransitionDirection = "next" | "prev";

/** The transition types the editor's boundaries know. */
export const TRANSITION = {
  next: "paged-next",
  prev: "paged-prev",
} as const;

/** The incoming side of a directional move. */
export const ENTER_DIRECTIONAL = {
  [TRANSITION.next]: "pg-vt-from-end",
  [TRANSITION.prev]: "pg-vt-from-start",
  default: "none",
};

/** The outgoing side of a directional move. */
export const EXIT_DIRECTIONAL = {
  [TRANSITION.next]: "pg-vt-to-start",
  [TRANSITION.prev]: "pg-vt-to-end",
  default: "none",
};

/** A shared element that moves with a directional transition. */
export const SHARE_MOVE = {
  [TRANSITION.next]: "pg-vt-move",
  [TRANSITION.prev]: "pg-vt-move",
  default: "none",
};

/** A list item that appears or goes with any directional transition. */
export const FADE = {
  [TRANSITION.next]: "pg-vt-fade",
  [TRANSITION.prev]: "pg-vt-fade",
  default: "none",
};

/** The direction from one position to another in the same order. */
export function directionOf(from: number, to: number): TransitionDirection {
  return to < from ? "prev" : "next";
}

/** Run `update` as a transition of the given direction: the boundaries it
 *  reveals, hides or moves animate (where the browser has view
 *  transitions; elsewhere the update just lands). */
export function transitionWith(
  direction: TransitionDirection,
  update: () => void,
): void {
  startTransition(() => {
    addTransitionType(TRANSITION[direction]);
    update();
  });
}
