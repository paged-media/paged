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

// The engine catalog, shipped with this package so a consumer does not have
// to install @paged-media/canvas-wasm (its introspect entry alone is 11.5 MB of wasm) to read 140 KB of
// JSON. It is plugin-api's vendored copy, which CI holds in lockstep with
// the engine version the wire types were synced from (publish.yml). A
// separate entry point: the editor loads it on the first AI request, not at
// boot.

import catalog from "../../plugin-api/src/catalog.json";

import type { ApiCatalog } from "./catalog";

const ENGINE_CATALOG = catalog as unknown as ApiCatalog;

export default ENGINE_CATALOG;
