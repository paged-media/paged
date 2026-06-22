/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
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
