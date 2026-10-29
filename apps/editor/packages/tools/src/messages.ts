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

// The words of the built-in tools that follow the editor's locale (plan
// E10). The older tools' titles are still plain English in
// `built-in-tools.ts`; the tools added since read theirs from here,
// through getters, so the words are looked up when shown.

import { defineMessages } from "@paged-media/strings";

export const MESH_TOOL = defineMessages("tools.mesh", {
  title: "Mesh",
  description:
    "Click inside a shape to add a mesh point; drag a point or its handles; colour the selected points in the Color panel.",
  points: "{count, plural, one {# mesh point} other {# mesh points}}",
});

export const GRADIENT_TOOL = defineMessages("tools.gradient", {
  mode: "Mode",
  linear: "Linear",
  freeformPoints: "Freeform points",
  freeformLines: "Freeform lines",
  spread: "Spread",
  points: "{count, plural, one {# gradient point} other {# gradient points}}",
});
