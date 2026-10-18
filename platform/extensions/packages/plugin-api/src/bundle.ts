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

// The bundle lifecycle — the single seam that makes a plugin an
// out-of-repo artifact. In v0 the host calls `activate` in-process
// (via `@paged-media/plugin-sdk`'s `loadBundle`); the end state
// fulfills the SAME `BundleHost` interface across a worker/isolate
// RPC boundary, so bundle source never changes when isolation lands.

import type { BundleHost, Disposable } from "./host.js";
import type { PluginManifest } from "./manifest.js";

/** Returned by `activate`. The host tracks every facade registration
 *  independently, so this handle only needs to release what the
 *  bundle allocated OUTSIDE the host (timers, caches) — returning a
 *  no-op disposer is legitimate. */
export type BundleHandle = Disposable;

/** A loadable plugin bundle: serializable identity + the activation
 *  entry point. `defineBundle()` in `@paged-media/plugin-sdk` is the
 *  ergonomic constructor. */
export interface PagedBundle {
  manifest: PluginManifest;
  activate(host: BundleHost): BundleHandle;
}
