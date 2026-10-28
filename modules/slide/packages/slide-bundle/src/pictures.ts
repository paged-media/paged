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

// Insert ▸ Pictures and icons (slide W4): any picture the engine reads,
// placed on the active slide as a picture frame in one undo step. An SVG
// (an icon) stays vector: the engine draws it as paths, and export writes
// it as PowerPoint does, an `asvg:svgBlip` beside a PNG fallback. A format
// PowerPoint does not open (WebP, PSD, TGA, …) is written as a PNG of the
// frame. Export asks for those PNGs (`rastersNeeded`); the host renders
// them (`render.element`) and the export runs again with them.

import type {
  BundleHost,
  ElementId,
  MutationInput,
} from "@paged-media/plugin-api";
import { bytesToBase64 } from "@paged-media/helpers";

import type { RasterNeed, SlideEngine } from "./engine.js";

/** What Insert ▸ Pictures asks the picker for: every format the engine
 *  reads, by extension and media type. */
export const PICTURE_ACCEPT: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".webp",
  ".svg",
  ".ico",
  ".psd",
  ".tga",
  ".qoi",
  ".avif",
  ".jxl",
  ".hdr",
  ".exr",
  ".dng",
  ".eps",
  "image/*",
];

/** A picture whose header gives no size: 4 × 3 in. */
const FALLBACK_SIZE: readonly [number, number] = [288, 216];

export interface InsertPictureArgs {
  bytes: Uint8Array;
  pageId: string;
  /** The page's size, pt: a picture larger than the slide is scaled to fit
   *  it, as PowerPoint does. */
  pageSize: [number, number];
  /** The picture's centre on the page, pt (default: the page's). */
  center?: [number, number];
  /** Its size, pt (default: its own, at 96 pixels an inch). */
  w?: number;
  h?: number;
}

/** The size a picture is inserted at: its own (96 pixels an inch; an EPS's
 *  bounding box in points), scaled down to fit the slide. */
export function pictureSize(
  info: { format: string; width: number | null; height: number | null },
  page: [number, number],
  w?: number,
  h?: number,
): [number, number] {
  const perPx = info.format === "eps" ? 1 : 0.75;
  let size: [number, number] =
    info.width && info.height
      ? [info.width * perPx, info.height * perPx]
      : [...FALLBACK_SIZE];
  if (w && h) return [w, h];
  if (w) return [w, (w * size[1]) / size[0]];
  if (h) return [(h * size[0]) / size[1], h];
  const k = Math.min(1, page[0] / size[0], page[1] / size[1]);
  size = [size[0] * k, size[1] * k];
  return size;
}

/** Insert the picture `args.bytes` on `args.pageId`: the frame's id, or
 *  null with the reason logged. One undo step. */
export async function insertPicture(
  host: BundleHost,
  engine: SlideEngine,
  args: InsertPictureArgs,
): Promise<ElementId | null> {
  const info = engine.picture(args.bytes);
  if (!info) {
    host.log.warn(
      "paged.slide insert picture: not a picture format the engine reads",
    );
    return null;
  }
  const [w, h] = pictureSize(info, args.pageSize, args.w, args.h);
  const [cx, cy] = args.center ?? [args.pageSize[0] / 2, args.pageSize[1] / 2];
  const bounds: [number, number, number, number] = [
    cy - h / 2,
    cx - w / 2,
    cy + h / 2,
    cx + w / 2,
  ];
  // The pixels inline: a frame with image bytes and no content transform
  // draws them fitted to its bounds.
  const batch = {
    op: "batch",
    args: {
      ops: [
        { op: "insertFrame", args: { pageId: args.pageId, bounds } },
        { op: "bindCreated", args: { handle: "pic" } },
        { op: "replaceImageBytes", args: { elementId: "$h:pic", bytes: [] } },
      ],
    },
  } as MutationInput;
  const out = await host.document.mutateWithBytes(batch, args.bytes);
  if (!out.applied) {
    host.log.warn(
      `paged.slide insert picture: the engine refused (${JSON.stringify(out.error)})`,
    );
    return null;
  }
  const id =
    out.minted?.find((m) => m.handle === "pic")?.element ??
    out.minted?.[0]?.element ??
    out.createdId ??
    null;
  return (id as ElementId | null) ?? null;
}

/** PNGs of the pictures an export asked for, rendered by the host at the
 *  resolution asked, by element id (base64). A picture the host cannot
 *  render is left out (the export then names it). */
export async function renderRasters(
  host: BundleHost,
  needs: readonly RasterNeed[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (needs.length === 0 || !host.supports("render.snapshot@2")) return out;
  for (const n of needs) {
    try {
      const r = await host.render.element(
        { kind: "rectangle", id: n.id } as ElementId,
        { dpi: n.dpi, format: "png", background: "transparent", marginPt: 0 },
      );
      if (r && r.png.length > 0) out[n.id] = bytesToBase64(r.png);
    } catch (err) {
      host.log.warn(
        `paged.slide export: the picture ${n.id} could not be rendered (${String(err)})`,
      );
    }
  }
  return out;
}
