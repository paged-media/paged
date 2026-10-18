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

// "Which face is under this point?" — the ONE lookup both region
// machines run (Shape Builder, Live Paint), on every pointer event, over
// the cached planar arrangement.
//
// It used to be a loop in each machine calling `pointInAnchorPath` per
// face, which re-flattened that face's curves on every call: one hover
// move over a 256-face arrangement sampled every cubic of every face,
// and the next move did it all again. The arrangement does not change
// between moves — it is installed once per gesture scope — so the
// flattening is done THEN (`prepareRegions`, from `setRegions`), and a
// move tests the pointer against rings that already exist, skipping
// every face whose bounding box does not contain it.
//
// The answer is the one the loop gave: the FIRST face, in installed
// order, that contains the point under the even-odd rule
// (`pointInFlatPath` is `pointInAnchorPath` minus the flatten).

import {
  flattenAnchorPath,
  pointInFlatPath,
  type FlatAnchorPath,
  type Vec2,
} from "@paged-media/draw-geometry";

import type { RegionFace } from "./shape-builder-machine";

/** An arrangement prepared for lookups: each face's id beside its
 *  flattened outline, in the order the faces were installed. */
export interface PreparedRegions {
  readonly ids: readonly string[];
  readonly outlines: readonly FlatAnchorPath[];
}

/** Flatten every face ONCE. The faces are read here and not kept: a
 *  host that edits its face list afterwards must install it again
 *  (`setRegions`), which is what the handlers already do. */
export function prepareRegions(faces: readonly RegionFace[]): PreparedRegions {
  return {
    ids: faces.map((face) => face.id),
    outlines: faces.map((face) =>
      flattenAnchorPath(face.anchors, face.subpathStarts ?? []),
    ),
  };
}

/** The id of the first face containing `point`, or null. */
export function regionAt(regions: PreparedRegions, point: Vec2): string | null {
  const { ids, outlines } = regions;
  for (let i = 0; i < outlines.length; i++) {
    if (pointInFlatPath(point, outlines[i])) return ids[i];
  }
  return null;
}
