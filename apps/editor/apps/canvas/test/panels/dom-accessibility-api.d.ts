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

// dom-accessibility-api ships its declarations, but its package.json
// `exports` does not name them, so module resolution under `exports`
// cannot find them. The two functions the lane uses, as the package
// declares them (dist/index.d.ts).
declare module "dom-accessibility-api" {
  export function computeAccessibleName(
    root: Element,
    options?: Record<string, unknown>,
  ): string;
  export function getRole(element: Element): string | null;
}
