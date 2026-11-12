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

// Engine ADR 1099 — Layer ▸ Place Layers as Frames: the PSD the image
// session opened goes to the host's `document.placePsdLayers` door, which
// places each pixel layer as a frame on the active page — its pixels,
// blend mode, opacities and layer style (as the frame's effect stack,
// drawn by the engine's layer-style evaluator, the one this bundle's
// fold draws its styles with). One undo step in the document; what a
// frame could not carry comes back as losses for the status line.

import type { BundleHost, PsdLayersPlaceResult } from "@paged-media/plugin-api";

/** What the command needs of the session. */
export interface PlaceLayersSession {
  sourcePsd(): Uint8Array | null;
}

/** Why the command did nothing, or the door's answer. */
export type PlaceLayersOutcome =
  | { kind: "no-psd" }
  | { kind: "no-door" }
  | { kind: "placed"; result: PsdLayersPlaceResult };

/** Place the session's PSD layers as frames on the active page. */
export async function placeLayersAsFrames(
  host: BundleHost,
  session: PlaceLayersSession,
): Promise<PlaceLayersOutcome> {
  const bytes = session.sourcePsd();
  if (!bytes) return { kind: "no-psd" };
  if (!host.supports("document.placePsdLayers@1")) return { kind: "no-door" };
  return { kind: "placed", result: await host.document.placePsdLayers(bytes) };
}
