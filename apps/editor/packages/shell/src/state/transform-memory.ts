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

// The last transform of ONE editor (Transform Again's memory). The Rotate,
// Scale and Shear tools (`@paged-media/tools`) write it; Reflect and
// Transform Again (the canvas app) write and read it. It lives in the
// editor's scope, so two editors on a page do not repeat each other's
// transforms.

import { createTransformMemory } from "@paged-media/helpers";

import { scoped } from "./editor-scope";

export const TRANSFORM_MEMORY = scoped("transformMemory", () =>
  createTransformMemory(),
);
