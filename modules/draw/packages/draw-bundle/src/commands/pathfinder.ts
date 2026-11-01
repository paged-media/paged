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

// The `pathfinderBoolean` wire builder. The Pathfinder COMMANDS are the
// host's (`paged.pathfinder.*`, the editor's pathfinder-commands.ts;
// PM-0017); this stays because draw's brush tools compose the same op
// (Blob Brush merge, handlers/brush.ts).

import type {
  ElementId,
  Mutation,
  PathfinderKind,
} from "@paged-media/plugin-api";

/** The `pathfinderBoolean{ kept, others, kind }` mutation: `kept` takes
 *  the result and `others` are consumed. One mutation = one undo step. */
export function pathfinderMutationFor(
  kept: ElementId,
  others: ElementId[],
  kind: PathfinderKind,
): Mutation {
  return { op: "pathfinderBoolean", args: { kept, others, kind } };
}
