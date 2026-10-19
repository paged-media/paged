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

// `@paged-media/plugin-sdk/api` — the extension contract, type-only
// (PM-0008, amendment 3). An extension takes its types from here and its
// values from `@paged-media/plugin-sdk` (and the BundleHost its activate()
// receives), so plugin-sdk is its one dependency. In the workspace this
// re-exports the private `@paged-media/plugin-api`, the contract's source;
// the published package carries that package's declarations in `dist/api/`
// (scripts/inline-api.mjs), so it depends on nothing private.

export type * from "@paged-media/plugin-api";
