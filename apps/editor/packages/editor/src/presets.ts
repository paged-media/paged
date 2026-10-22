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

// `@paged-media/editor/presets` (docs/adr/PM-0013): the editor's presets,
// as data, for host-side tooling (a profile editor, a check of a stored
// profile). A preset is used by its id: `createEditor(el, { profile: id })`.

import type { EditorProfile } from "./types.js";
import * as presets from "virtual:paged-editor/presets";

export type { EditorProfile } from "./types.js";

/** Every preset by id (`full`, `template-fill`, `viewer`, `solo:<name>`, …). */
export const PRESETS: Readonly<Record<string, EditorProfile>> = presets.PRESETS;
