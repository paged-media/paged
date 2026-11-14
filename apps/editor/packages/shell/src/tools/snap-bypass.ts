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

// The one snapping bypass (the interaction specification's `UXI-SNP-005`;
// editor ADR 1226, IC8): while the platform's
// primary modifier is held — Cmd on macOS, Ctrl elsewhere — a drag or a
// point-placing tool ignores the snap targets, and letting it go snaps
// again without moving the anchor. Before, a move read Ctrl and the Pen
// and Direct Selection read Cmd.

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Is the snapping bypass held? (`cmd` is the Meta key, `ctrl` Control.) */
export function snapBypassHeld(modifiers: {
  cmd?: boolean;
  ctrl?: boolean;
}): boolean {
  return IS_MAC ? modifiers.cmd === true : modifiers.ctrl === true;
}
