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

// The Color Guide: the harmony of the selection's fill colour under a rule,
// and a grid of variations of each harmony colour (shades to tints, warm to
// cool, vivid to muted). Clicking a chip paints the selection's fill with it
// (Alt-click: its stroke) through a swatch named for the colour's hex value,
// found or created, in ONE batch: one undo step.
//
// WHY THIS LIVES IN THE EDITOR AND NOT IN A PLUGIN. Swatches, fills and the
// colour wheel are the host's; paged.draw carried a Color Guide panel of its
// own beside the host's Color Wheel (PM-0017). The colour maths (`harmonyOf`,
// `variationsOf`) is `@paged-media/vector-geometry`'s, which the Recolor
// Artwork panel shares; this file is the reads and the write.
//
//  1. THE BASE is the first selected item's own fill, as the document shows
//     it (`requestColorPreview`); a gradient or no fill has none, and the
//     panel says to select an object with a fill colour.
//  2. A CHIP'S SWATCH is looked up by its hex name first, so painting twice
//     with one colour does not grow the document.
//  3. THE ENGINE'S REFUSAL is returned in words.

import type { CanvasClient, ElementId, Mutation } from "@paged-media/client";
import {
  parseCssColor,
  rgbToHex,
  type Rgb,
} from "@paged-media/vector-geometry";
import { refusalText } from "@paged-media/panel-kit";

type Reads = Pick<CanvasClient, "elementProperties" | "send" | "collection">;
type Writes = Pick<CanvasClient, "mutate" | "collection">;

const isUsable = (ref: unknown): ref is string =>
  typeof ref === "string" &&
  ref !== "" &&
  ref !== "Swatch/None" &&
  !ref.startsWith("Gradient/");

/** The first selected item's fill colour, as shown, or null. */
export async function readGuideBase(
  client: Reads,
  selection: readonly ElementId[],
): Promise<Rgb | null> {
  const first = selection[0];
  if (!first) return null;
  const props = await client.elementProperties(first).catch(() => null);
  const fill = props?.entries.find(
    (e: { path: string }) => e.path === "frameFillColor",
  )?.value;
  const ref =
    fill && typeof fill === "object" && "value" in fill
      ? (fill as { value: unknown }).value
      : null;
  if (!isUsable(ref)) return null;
  try {
    const reply = await client.send({
      kind: "requestColorPreview",
      payload: { swatchId: ref },
    } as never);
    const r = reply as {
      kind?: string;
      payload?: { result?: { rgbHex?: string } | null };
    };
    if (r.kind !== "colorPreviewReply") return null;
    return parseCssColor(r.payload?.result?.rgbHex ?? "") ?? null;
  } catch {
    return null;
  }
}

/** Paint the selection's fill (or stroke) with `rgb`. Answers the engine's
 *  refusal in words, or null. Nothing selected sends nothing. */
export async function applyGuideColor(
  client: Writes,
  selection: readonly ElementId[],
  rgb: Rgb,
  stroke: boolean,
): Promise<string | null> {
  if (selection.length === 0) return null;
  const hex = rgbToHex(rgb);
  const swatches = await client
    .collection<{ selfId: string; name: string }>("swatches")
    .catch(() => [] as readonly { selfId: string; name: string }[]);
  const existing = swatches.find((s) => s.name === hex);
  const ref = existing?.selfId ?? `Color/guide-${hex.replace("#", "")}`;
  const ops: Mutation[] = [];
  if (!existing) {
    ops.push({
      op: "createSwatch",
      args: {
        spec: {
          selfId: ref,
          name: hex,
          space: "RGB",
          value: [rgb[0], rgb[1], rgb[2]],
        },
      },
    } as Mutation);
  }
  const path = stroke ? "frameStrokeColor" : "frameFillColor";
  for (const elementId of selection)
    ops.push({
      op: "setElementProperty",
      args: { elementId, path, value: { type: "colorRef", value: ref } },
    } as Mutation);
  const reply = await client.mutate({ op: "batch", args: { ops } });
  if (reply.kind !== "mutationFailed") return null;
  return refusalText(reply.payload.error, "Color guide");
}
