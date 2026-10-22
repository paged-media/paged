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

// Where the host serves a copy of the package's `dist/` (`assetBase`), once
// per page: the first editor's config sets it. Read by the package entry
// (the engine's wasm, the default faces) and, through the build, by
// paged.data's engine loader (its `bin/`, vite.config.lib.ts).

let base: string | null = null;

export function setAssetBase(url: string | undefined): void {
  if (!url) return;
  base = url.endsWith("/") ? url : `${url}/`;
}

/** The host's `assetBase`, ending in `/`, or null. */
export function assetBase(): string | null {
  return base;
}
