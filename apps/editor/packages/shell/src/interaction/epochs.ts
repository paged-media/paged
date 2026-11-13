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

// The generations a late answer is checked against (the interaction
// specification, §3.2 "epoch", §4.3 and §18.1). An epoch is a counter
// that only grows; a request records the epochs it was asked under and
// its answer is applied only while they still hold (`UXI-ASY-001`,
// `UXI-ASY-002`, `UXI-OWN-008`).
//
//   doc      a document was loaded, replaced or closed (`UXI-INV-015`)
//   context  an edit context was entered or left
//   input    a new press began: it supersedes every answer an earlier
//            press or click is still waiting for (`UXI-ASY-003`)
//   camera   the camera moved (overlays tag what they drew with it)

export type EpochKind = "doc" | "context" | "input" | "camera";

export interface EpochSnapshot {
  readonly doc: number;
  readonly context: number;
  readonly input: number;
  readonly camera: number;
}

export interface Epochs {
  /** The epochs as they are now. */
  now(): EpochSnapshot;
  /** Advance one epoch; returns its new value. */
  bump(kind: EpochKind): number;
  /** Do the epochs `at` names still hold? `kinds` picks which are
   *  compared (default: doc, context and input; the camera moves too
   *  often to void an answer by itself). */
  holds(at: EpochSnapshot, kinds?: readonly EpochKind[]): boolean;
}

const DEFAULT_KINDS: readonly EpochKind[] = ["doc", "context", "input"];

export function createEpochs(): Epochs {
  let snapshot: EpochSnapshot = { doc: 0, context: 0, input: 0, camera: 0 };
  return {
    now: () => snapshot,
    bump(kind) {
      snapshot = { ...snapshot, [kind]: snapshot[kind] + 1 };
      return snapshot[kind];
    },
    holds(at, kinds = DEFAULT_KINDS) {
      for (const k of kinds) if (at[k] !== snapshot[k]) return false;
      return true;
    },
  };
}
