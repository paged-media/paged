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

// LIVE CORNER PRESETS — the eight `setElementProperty` writes that give an
// element one corner style at one uniform radius (the four corner options
// and the four radii of the IDML corner model). One implementation
// (PM-0017): the editor's `paged.corners.*` commands and its polygon
// corner widgets (`live-shape-handles.tsx`) both build through it.

/** The IDML corner-option tokens the engine accepts. `None` clears the
 *  option (the apply layer reads empty text as no corner). */
export type CornerStyleToken =
  | "None"
  | "RoundedCorner"
  | "InverseRoundedCorner"
  | "InsetCorner"
  | "BeveledCorner"
  | "FancyCorner";

/** The kinds whose corners the engine both accepts AND renders. The other
 *  three it accepts (oval, graphic line, group) are storage only: nothing
 *  draws them, so a preset there would change nothing a designer sees. */
export const LIVE_CORNER_KINDS = ["rectangle", "polygon", "textFrame"] as const;

/** Whether a corner preset changes anything on an element of `kind`. */
export function supportsLiveCornerKind(kind: string): boolean {
  return (LIVE_CORNER_KINDS as readonly string[]).includes(kind);
}

const OPTION_PATHS = [
  "frameCornerOptionTopLeft",
  "frameCornerOptionTopRight",
  "frameCornerOptionBottomRight",
  "frameCornerOptionBottomLeft",
] as const;

const RADIUS_PATHS = [
  "frameCornerRadiusTopLeft",
  "frameCornerRadiusTopRight",
  "frameCornerRadiusBottomRight",
  "frameCornerRadiusBottomLeft",
] as const;

/** One wire op, as far as this file builds them. */
interface CornerOp {
  op: "setElementProperty";
  args: { elementId: unknown; path: string; value: unknown };
}

/** The eight writes of one preset on one element: four options (text) and
 *  four radii (length, pt). Callers wrap them in ONE batch for one undo. */
export function cornerPresetOps(
  elementId: unknown,
  style: CornerStyleToken,
  radius: number,
): CornerOp[] {
  const optionText = style === "None" ? "" : style;
  return [
    ...OPTION_PATHS.map((path): CornerOp => ({
      op: "setElementProperty",
      args: { elementId, path, value: { type: "text", value: optionText } },
    })),
    ...RADIUS_PATHS.map((path): CornerOp => ({
      op: "setElementProperty",
      args: { elementId, path, value: { type: "length", value: radius } },
    })),
  ];
}
