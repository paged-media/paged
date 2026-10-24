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

// RASTERIZE — Object ▸ Rasterize… (Illustrator's Rasterize): the selection
// becomes ONE image frame of its pixels at a chosen resolution, over a
// transparent or white ground, and the vector objects go.
//
// THE PIXELS ARE THE ENGINE'S. `rasterizeElements` (plugin-sdk, over
// `render.snapshot@2`, extensions ADR 338) draws exactly the selected items
// — their effects, blend modes, text and placed images, in their stacking
// order, everything else on the page left out — cropped to what they draw
// (a stroke and a shadow reach past the geometric bounds; the crop follows
// them). No second renderer lives here.
//
// ONE BATCH, ONE UNDO: `insertFrame` over the drawn region, `bindCreated`,
// `placeImage` with the PNG as a `data:` URI fitted to the frame (the
// region and the image have the same aspect by construction, so the fit
// is exact), then the originals: every selected group dissolved (outermost
// first) and every leaf deleted. Inserts go before deletes (the batch
// ordering rule, `minted.spec.ts`).
//
// DELIBERATE DIFFERENCE FROM ILLUSTRATOR: the image lands at the FRONT of
// its layer, not at the topmost original's slot. The `reorderElement`
// index is spread-wide and the tree read does not say where that slot is
// in its terms; guessing would put the image at a wrong depth silently.
//
// REFUSED, with the reason in the log (the panel shows it): an empty
// selection, items on more than one page or on the pasteboard (a snapshot
// is a page's), a selection that draws nothing, and a host without
// `render.snapshot@2`.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import { rasterizeElements } from "@paged-media/plugin-sdk";

import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "./batch-handles";
import { bindMinted, mutateMinting } from "./minted";
import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";

const M = defineMessages("draw.rasterize", {
  title: "Object: Rasterize",
});

export const RASTERIZE_COMMAND_ID = "media.paged.draw.command.rasterize";

/** The host feature the pixels come through. */
export const RASTERIZE_FEATURE = "render.snapshot@2";

export type RasterizeBackground = "transparent" | "paper";
export const RASTERIZE_BACKGROUNDS: readonly RasterizeBackground[] = [
  "transparent",
  "paper",
];

/** The two parameters, Illustrator's Resolution and Background. */
export interface RasterizeParams {
  /** Pixels per inch, 1 to 2400. */
  ppi: number;
  background: RasterizeBackground;
}

/** Illustrator's "High (300 ppi)" on a transparent ground. */
export const RASTERIZE_DEFAULTS: RasterizeParams = {
  ppi: 300,
  background: "transparent",
};

export const MIN_RASTERIZE_PPI = 1;
export const MAX_RASTERIZE_PPI = 2400;

/** Whatever `raw` is, as complete parameters: a ppi clamped to 1–2400
 *  (rounded to a whole number), anything unreadable its default. Pure. */
export function rasterizeParamsFrom(raw: unknown): RasterizeParams {
  const r =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const ppi =
    typeof r.ppi === "number" && Number.isFinite(r.ppi)
      ? Math.min(
          MAX_RASTERIZE_PPI,
          Math.max(MIN_RASTERIZE_PPI, Math.round(r.ppi)),
        )
      : RASTERIZE_DEFAULTS.ppi;
  const background = RASTERIZE_BACKGROUNDS.includes(
    r.background as RasterizeBackground,
  )
    ? (r.background as RasterizeBackground)
    : RASTERIZE_DEFAULTS.background;
  return { ppi, background };
}

/** The handle the image frame is bound to inside the batch. */
const RASTER_HANDLE = "raster";

/** `bytes` as a `data:image/png;base64,` URI (chunked: a large PNG would
 *  overflow `String.fromCharCode`'s argument list). Pure. */
export function pngDataUri(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/** What the batch removes: groups to dissolve (outermost first) and the
 *  leaves to delete, read off the scene tree. An item inside a selected
 *  group is covered by the group. Pure. */
export function removalOf(
  roots: readonly SceneTreeNode[],
  selected: readonly ElementId[],
): { groups: string[]; leaves: string[] } {
  const wanted = new Set(
    selected
      .filter((id) => typeof id.id === "string")
      .map((id) => String(id.id)),
  );
  const groups: string[] = [];
  const leaves: string[] = [];
  const take = (node: SceneTreeNode): void => {
    const id = node.id;
    if (id && typeof id.id === "string") {
      if (id.kind === "group") groups.push(id.id);
      else leaves.push(id.id);
    }
    for (const c of node.children ?? []) take(c);
  };
  const walk = (nodes: readonly SceneTreeNode[]): void => {
    for (const node of nodes) {
      const id = node.id;
      if (id && typeof id.id === "string" && wanted.has(id.id)) {
        take(node);
        continue;
      }
      walk(node.children ?? []);
    }
  };
  walk(roots);
  return { groups, leaves };
}

/** THE ONE BATCH (module header). Exported so the spec asserts the wire
 *  shape. */
export function rasterizeBatchFor(args: {
  pageId: string;
  bounds: [number, number, number, number];
  png: Uint8Array;
  remove: { groups: readonly string[]; leaves: readonly string[] };
}): Mutation {
  const ops: Mutation[] = [
    { op: "insertFrame", args: { pageId: args.pageId, bounds: args.bounds } },
    bindCreatedMutationFor(RASTER_HANDLE),
    {
      op: "placeImage",
      args: {
        elementId: handleElementId(RASTER_HANDLE, "rectangle").id,
        uri: pngDataUri(args.png),
        fit: "FitContentToFrame",
      },
    },
  ];
  for (const groupId of args.remove.groups) {
    ops.push({ op: "dissolveGroup", args: { groupId } });
  }
  for (const frameId of args.remove.leaves) {
    ops.push({ op: "deleteFrame", args: { frameId } });
  }
  return batchMutationFor(ops);
}

/** Rasterize the selection with `params`. Answers the new image frame, or
 *  null when nothing was changed (the reason is logged). */
export async function applyRasterize(
  host: BundleHost,
  params?: Partial<RasterizeParams>,
): Promise<ElementId | null> {
  const { ppi, background } = rasterizeParamsFrom(params);
  const selected = host.selection
    .get()
    .filter((id) => typeof id.id === "string");
  if (selected.length === 0) {
    host.log.warn(
      `${RASTERIZE_COMMAND_ID}: select the objects to rasterize first`,
    );
    return null;
  }
  if (!host.supports(RASTERIZE_FEATURE)) {
    host.log.warn(
      `${RASTERIZE_COMMAND_ID}: this editor cannot draw objects to pixels (${RASTERIZE_FEATURE})`,
    );
    return null;
  }
  const pixels = await rasterizeElements(host, selected, {
    ppi,
    background,
    format: "png",
  });
  if (!pixels) {
    host.log.warn(
      `${RASTERIZE_COMMAND_ID}: the selection could not be drawn — it must be on one page (not the pasteboard) and draw something`,
    );
    return null;
  }
  const remove = removalOf(await host.document.tree(), selected);
  const batch = rasterizeBatchFor({
    pageId: pixels.pageId,
    bounds: pixels.bounds,
    png: pixels.png,
    remove,
  });
  const minting = await mutateMinting(host, batch);
  if (!minting.outcome.applied) {
    host.log.warn(
      `${RASTERIZE_COMMAND_ID} rejected by engine: ${JSON.stringify(minting.outcome.error)}`,
    );
    return null;
  }
  const image = bindMinted(minting, batch)?.byHandle.get(RASTER_HANDLE) ?? null;
  if (image) await host.selection.set([image]);
  host.log.info(
    `${RASTERIZE_COMMAND_ID}: ${selected.length} object(s) → ${pixels.widthPx}×${pixels.heightPx} px at ${ppi} ppi`,
  );
  return image;
}

/** Register the bare command: run with a payload it rasterizes with it,
 *  run bare (the palette, a keybinding) with the last-used values. */
export function contributeRasterizeCommand(
  host: BundleHost,
  lastUsed: () => RasterizeParams = () => RASTERIZE_DEFAULTS,
): Disposable {
  const sub = registerCommand(host, {
    id: RASTERIZE_COMMAND_ID,
    title: M.title,
    category: "Image",
    handler: (_paged, payload) =>
      applyRasterize(host, (payload as Partial<RasterizeParams>) ?? lastUsed()),
  });
  return { dispose: () => sub.dispose() };
}
