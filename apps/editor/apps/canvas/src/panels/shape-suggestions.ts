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

// Shape intelligence (the UX strategy's §7.1; paged.draw ADR 370): for one
// selected path, the operations that mean something for THAT shape, as
// quick actions. Only operations the editor already has: the host's
// rounded corners, paged.draw's offset path, simplify and repeats, and
// smoothing every corner point (one batch of the engine's point ops). A
// suggestion is shown only when its command is registered and the shape
// gives it something to do; a click runs it as the menu would, one undo
// step.

import {
  isCornerAnchor,
  type AnchorTriple,
} from "@paged-media/vector-geometry";

/** The shape as the engine reports it (`pathAnchors`, inner space). */
export interface ShapeFacts {
  kind: string;
  anchors: ReadonlyArray<{
    anchor: readonly [number, number];
    left: readonly [number, number];
    right: readonly [number, number];
  }>;
  subpathOpen?: readonly boolean[];
}

export type ShapeSuggestionId =
  "roundCorners" | "smooth" | "simplify" | "offset" | "repeat" | "mirror";

export interface ShapeSuggestion {
  id: ShapeSuggestionId;
  /** The command it runs; `null` for one the panel sends itself
   *  (`smooth`: the engine's point ops). */
  command: string | null;
}

export const ROUND_CORNERS_COMMAND = "paged.corners.rounded";
export const OFFSET_PATH_COMMAND = "media.paged.draw.command.offsetPath";
export const SIMPLIFY_PATH_COMMAND = "media.paged.draw.command.simplifyPath";
export const RADIAL_REPEAT_COMMAND =
  "media.paged.draw.command.makeRadialRepeat";
export const MIRROR_REPEAT_COMMAND =
  "media.paged.draw.command.makeMirrorRepeat";

/** The element kinds that are paths the suggestions apply to. */
const PATH_KINDS = new Set(["polygon", "rectangle", "graphicLine"]);
/** Anchors from which a path is dense enough to simplify. */
export const SIMPLIFY_FROM_ANCHORS = 12;

/** Is the shape complex enough to suggest anything: a path of three or
 *  more anchors, or one with a curve (a rectangle only once it has one). */
export function isComplexShape(shape: ShapeFacts): boolean {
  if (!PATH_KINDS.has(shape.kind)) return false;
  const curved = shape.anchors.some((a) => !isCornerAnchor(a as AnchorTriple));
  // A plain rectangle is not a complex shape; one whose points were
  // edited into curves is.
  if (shape.kind === "rectangle") return curved;
  return shape.anchors.length >= 3 || curved;
}

/** The suggestions for `shape`, in the order shown; `has(command)` says
 *  whether the editor offers that command (a profile can leave one out). */
export function suggestShapeActions(
  shape: ShapeFacts,
  has: (command: string) => boolean,
): ShapeSuggestion[] {
  if (!isComplexShape(shape)) return [];
  const n = shape.anchors.length;
  const corners = shape.anchors.filter((a) =>
    isCornerAnchor(a as AnchorTriple),
  ).length;
  const open = shape.subpathOpen ?? [];
  const closed = open.length === 0 || open.some((o) => !o);
  const out: ShapeSuggestion[] = [];
  const offer = (id: ShapeSuggestionId, command: string | null) => {
    if (command === null || has(command)) out.push({ id, command });
  };
  // Corners to round: a closed shape with at least two of them.
  if (closed && corners >= 2) offer("roundCorners", ROUND_CORNERS_COMMAND);
  // Corner points to smooth: three or more.
  if (corners >= 3 && shape.kind !== "rectangle") offer("smooth", null);
  // Dense paths (a traced or freehand shape) simplify.
  if (n >= SIMPLIFY_FROM_ANCHORS) offer("simplify", SIMPLIFY_PATH_COMMAND);
  // A closed outline offsets into a parallel one.
  if (closed) offer("offset", OFFSET_PATH_COMMAND);
  offer("repeat", RADIAL_REPEAT_COMMAND);
  offer("mirror", MIRROR_REPEAT_COMMAND);
  return out;
}

/** The ops of "Smooth": every corner anchor becomes a smooth point. */
export function smoothCornerOps(
  shape: ShapeFacts,
): Array<{ op: "pathPointCurveType"; index: number; smooth: true }> {
  return shape.anchors.flatMap((a, index) =>
    isCornerAnchor(a as AnchorTriple)
      ? [{ op: "pathPointCurveType" as const, index, smooth: true as const }]
      : [],
  );
}
