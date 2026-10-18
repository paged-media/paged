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

// contributeTool — register a tool through the contract surface.
//
// Since the B-15 host-side fix (2026-06-06) the HOST derives the
// activation command (`paged.tool.activate.<id>`) and the
// text-suppressed single-key shortcut from the registry for EVERY
// registration path — this helper no longer wires them itself (doing
// so again would double-bind the key). It remains the recommended
// door: it is where future per-tool capability stamping attaches,
// and bundle code stays unchanged when that lands.

import type {
  BundleHost,
  Disposable,
  ToolContribution,
} from "@paged-media/plugin-api";

export function contributeTool(
  host: BundleHost,
  tool: ToolContribution,
): Disposable {
  return host.contribute.tool(tool);
}
