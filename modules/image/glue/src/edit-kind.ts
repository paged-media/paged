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

// What an edit changes, said where it is made (image ADR 487; the UX
// strategy's §7.2: "non-destructive changes should be obvious"). Four
// kinds of edit look alike in a raster editor and are not alike at all:
//
//   pixels      a brush, a filter, a fill on a pixel layer REWRITES its
//               pixels (undo is the way back);
//   adjustment  an adjustment, fill or type layer, or a smart object's
//               smart filters, change nothing underneath: they can be
//               edited or removed any time;
//   mask        painting the mask changes WHERE a layer shows, not its
//               pixels;
//   placement   moving, scaling or rotating the picture inside its frame
//               (the frame's Content level) changes how the page shows the
//               image, never the image.
//
// The layers panel badges each row with its kind; the context toolbar
// names what the next edit will change. Pure: labels and rules only.

import { defineMessages } from "@paged-media/strings";

import type { LayerInfo } from "./engine";

export type EditKind = "pixels" | "adjustment" | "mask" | "placement";

export const EDIT_KIND = defineMessages("image.editKind", {
  pixels: "Pixels",
  pixelsHint: "Edits here rewrite this layer's pixels; Undo is the way back.",
  adjustment: "Adjustment",
  adjustmentHint:
    "Non-destructive: changes nothing beneath it; edit or remove it any time.",
  smart: "Smart object",
  smartHint:
    "Non-destructive: the source is kept; scaling and smart filters can be undone any time.",
  fill: "Fill",
  fillHint:
    "Non-destructive: a colour, gradient or pattern you can edit any time.",
  type: "Type",
  typeHint: "Non-destructive: live text, rendered to pixels when it changes.",
  mask: "Mask",
  maskHint: "Painting the mask changes where the layer shows, not its pixels.",
  placement: "Placement",
  placementHint:
    "Moves, scales or rotates the picture inside its frame; the image's pixels are not changed.",
  editing: "Editing: {what}",
  nonDestructive: "non-destructive",
});

/** A layer row's badge: its kind's label and hint (message keys), and
 *  whether edits to it rewrite pixels. */
export function layerBadge(layer: Pick<LayerInfo, "kind">): {
  kind: LayerInfo["kind"];
  label: string;
  hint: string;
  destructive: boolean;
} {
  switch (layer.kind) {
    case "adjustment":
      return {
        kind: layer.kind,
        label: EDIT_KIND.adjustment,
        hint: EDIT_KIND.adjustmentHint,
        destructive: false,
      };
    case "smart":
      return {
        kind: layer.kind,
        label: EDIT_KIND.smart,
        hint: EDIT_KIND.smartHint,
        destructive: false,
      };
    case "fill":
      return {
        kind: layer.kind,
        label: EDIT_KIND.fill,
        hint: EDIT_KIND.fillHint,
        destructive: false,
      };
    case "type":
      return {
        kind: layer.kind,
        label: EDIT_KIND.type,
        hint: EDIT_KIND.typeHint,
        destructive: false,
      };
    default:
      return {
        kind: "pixels",
        label: EDIT_KIND.pixels,
        hint: EDIT_KIND.pixelsHint,
        destructive: true,
      };
  }
}

/** What the next edit inside the image changes: the active layer's
 *  pixels, its mask (the edit target), or — on an adjustment, smart,
 *  fill or type layer — nothing destructive. */
export function editKindOf(
  active: Pick<LayerInfo, "kind"> | null | undefined,
  editTarget: "pixels" | "mask",
): EditKind {
  if (editTarget === "mask") return "mask";
  if (!active || active.kind === "pixels") return "pixels";
  return "adjustment";
}

/** The label and hint of an edit kind (message keys). */
export function editKindLabel(kind: EditKind): { label: string; hint: string } {
  switch (kind) {
    case "pixels":
      return { label: EDIT_KIND.pixels, hint: EDIT_KIND.pixelsHint };
    case "adjustment":
      return { label: EDIT_KIND.adjustment, hint: EDIT_KIND.adjustmentHint };
    case "mask":
      return { label: EDIT_KIND.mask, hint: EDIT_KIND.maskHint };
    case "placement":
      return { label: EDIT_KIND.placement, hint: EDIT_KIND.placementHint };
  }
}
