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

// Insert ▸ Shapes (slide ADR 717): any of the 187 DrawingML presets as a
// live preset. The slide engine draws the preset for its box and answers
// the page items for the host's paste door (`pasteElements`): the outline
// and, for a preset with stroke-only details, the detail element, each
// labelled as a live preset, in one undo step. A resize then draws it
// again (live-presets.ts), its adjust handles work (adjust-handles.tsx), and
// export writes it as `a:prstGeom`.

import type {
  BundleHost,
  ElementId,
  MutationInput,
} from "@paged-media/plugin-api";

import type { SlideEngine } from "./engine.js";

/** The Shapes panel (Insert ▸ Shapes). */
export const SHAPES_PANEL_ID = "media.paged.slide.panel.shapes";

/** A new shape's size when none is given: PowerPoint's click-to-insert
 *  shape is 1 in on its short side; this is 1.5 × 1 in. */
export const DEFAULT_SIZE: readonly [number, number] = [108, 72];

let counter = 0;
/** A shape key of the editor's own, so a new shape's elements move
 *  together (`new:<time><n>`). */
export function newShapeKey(): string {
  counter += 1;
  return `new:${Date.now().toString(36)}${counter.toString(36)}`;
}

export interface InsertShapeArgs {
  prst: string;
  pageId: string;
  /** The shape's centre on the page, pt. */
  center: [number, number];
  w?: number;
  h?: number;
}

/** Insert preset `prst` on `pageId`, centred on `center`: the outline
 *  element's id, or null with the reason logged. */
export async function insertShape(
  host: BundleHost,
  engine: SlideEngine,
  args: InsertShapeArgs,
): Promise<ElementId | null> {
  const [w, h] = [args.w ?? DEFAULT_SIZE[0], args.h ?? DEFAULT_SIZE[1]];
  const made = engine.newShape(args.prst, w, h, newShapeKey());
  if (!made) {
    host.log.warn(`paged.slide insert shape: no preset ${args.prst}`);
    return null;
  }
  const out = await host.document.mutate({
    op: "pasteElements",
    args: { snippet: made.snippet, pageId: args.pageId, center: args.center },
  } as MutationInput);
  if (!out.applied) {
    host.log.warn(
      `paged.slide insert shape: the engine refused (${JSON.stringify(out.error)})`,
    );
    return null;
  }
  // The paste mints the copies back to front: the outline first.
  return out.minted?.[0]?.element ?? out.createdId ?? null;
}
