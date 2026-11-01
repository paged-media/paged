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

// THE GRAPHIC DEFAULT — the paint a drawing TOOL gives the shape it makes.
//
// The decision and the batch builders are the shared ones
// (`@paged-media/helpers`, PM-0017: the editor's drawing tools use the very
// same code). This file keeps only what is a bundle's own: the two reads,
// through `BundleHost` (`document.meta` and the raw style read), for the
// tools that mint a shape from a gesture or a command (Curvature, Shaper,
// Star/Flare, Perspective). Commands, panels and importers keep their
// inserts as they are, and so do the brushes: a Paintbrush / Blob Brush
// sweep is a filled shape that already paints itself (`./brush.ts`).
//
// Measured on engine 0.71.8: `insertPath` (and `insertLine`) already fall
// back to a 1 pt `Color/Black` stroke when the document has no stroke
// default, so in a File > New document a Curvature or Pencil path was
// never invisible. What the tool adds is the DOCUMENT's own
// `[Normal Graphics Frame]` — a document that styles it differently gets
// that paint — and independence from the engine's fallback.

import {
  NORMAL_GRAPHICS_FRAME_STYLE,
  graphicPaintFromStyle,
  resolveGraphicPaint,
  type GraphicPaint,
} from "@paged-media/helpers";
import type { BundleHost } from "@paged-media/plugin-api";

import { rawStyleProperties } from "../raw-wire";

export {
  INDESIGN_GRAPHIC_PAINT,
  NORMAL_GRAPHICS_FRAME_STYLE,
  graphicPaintOps,
  withGraphicPaint,
  type GraphicPaint,
} from "@paged-media/helpers";

/** The document's own `[Normal Graphics Frame]`, when it has one. */
async function normalGraphicsFramePaint(
  host: BundleHost,
): Promise<GraphicPaint | null> {
  const style = await rawStyleProperties(
    host,
    "object",
    NORMAL_GRAPHICS_FRAME_STYLE,
  );
  return style ? graphicPaintFromStyle(style) : null;
}

/**
 * The paint a drawing tool gives its new shape, or `null` when the
 * document has defaults of its own (the engine paints the shape with
 * them; adding ours would override the user's choice).
 */
export async function graphicPaintFor(
  host: BundleHost,
): Promise<GraphicPaint | null> {
  const [meta, style] = await Promise.all([
    host.document.meta().catch(() => null),
    normalGraphicsFramePaint(host).catch(() => null),
  ]);
  return resolveGraphicPaint(meta, style);
}
