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

import type { PagedBundle } from "@paged-media/plugin-api";

/**
 * Identity helper that pins a bundle to the `PagedBundle` contract
 * with full inference — the `defineConfig` idiom. Exists so bundle
 * authors get contract errors at the definition site, not at the
 * host's load site.
 */
export function defineBundle(bundle: PagedBundle): PagedBundle {
  return bundle;
}
