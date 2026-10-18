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
