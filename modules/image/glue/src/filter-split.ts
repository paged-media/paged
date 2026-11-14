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

// The filter dialog's before/after SPLIT (image ADR 487; the UX
// strategy's §7.2): the frame shows the image as it was left of a line and
// with the filter right of it, the line moved by the dialog's split
// slider. Both halves are what the frame shows (the display adjustments
// applied) at the preview's resolution; the split is a view, never the
// document. Pure arithmetic: the composite and the line's shapes.

import { defineMessages } from "@paged-media/strings";

import type { FitTransform } from "./frame-fit";

/** The split's words: the two halves' names on the canvas, the dialog's
 *  control, and what the frame shows of the filter while it renders. */
export const FILTER_SPLIT = defineMessages("image.filterSplit", {
  before: "Before",
  after: "After",
  split: "Split view",
  splitTitle:
    "Show the image without the filter left of a line and with it right of the line; drag the slider to move the line",
  splitPosition: "Split position",
  draft:
    "Draft preview — a reduced copy; the full image follows when the values rest",
  rendering: "Rendering at full resolution…",
  full: "Full resolution",
  beforeShowing: "Showing the image without the filter",
});

/** `before` left of `split` (a fraction of the width, 0–1), `after` from
 *  it on: RGBA8 rows of `width` × `height`. */
export function composeSplit(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
  height: number,
  split: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const cut = Math.max(0, Math.min(width, Math.round(split * width)));
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    if (cut > 0) out.set(before.subarray(row, row + cut * 4), row);
    if (cut < width)
      out.set(after.subarray(row + cut * 4, row + width * 4), row + cut * 4);
  }
  return out;
}

/** The split line over the frame (page-local pt), with the two halves
 *  named beside it: what `host.overlay.layer` draws. */
export function splitShapes(
  fit: FitTransform,
  imageWidth: number,
  imageHeight: number,
  split: number,
  labels: { before: string; after: string },
): Array<Record<string, unknown>> {
  const x =
    fit.originX + Math.max(0, Math.min(1, split)) * imageWidth * fit.scale;
  const top = fit.originY;
  const bottom = fit.originY + imageHeight * fit.scale;
  const labelY = top + Math.min(14, (bottom - top) / 2);
  return [
    {
      pageId: fit.pageId,
      points: [
        [x, top],
        [x, bottom],
      ],
    },
    {
      kind: "text",
      pageId: fit.pageId,
      x: x - 4,
      y: labelY,
      text: labels.before,
      size: 11,
      anchor: "end",
      background: true,
    },
    {
      kind: "text",
      pageId: fit.pageId,
      x: x + 4,
      y: labelY,
      text: labels.after,
      size: 11,
      anchor: "start",
      background: true,
    },
  ];
}
