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

// contributePanel — register a panel through the contract surface.
//
// Since the B-15 host-side fix (2026-06-06) the HOST derives the
// `paged.panel.show.<id>` / `paged.panel.hide.<id>` command pair from
// the registry for every registration path — this helper no longer
// builds bundle-namespaced duplicates. It remains the recommended
// door (future capability stamping), and `host.shell.openPanel`
// stays available for programmatic opens.

import type {
  BundleHost,
  Disposable,
  PanelContribution,
  SchemaPanelContribution,
} from "@paged-media/plugin-api";

export function contributePanel(
  host: BundleHost,
  panel: PanelContribution,
): Disposable {
  return host.contribute.panel(panel);
}

/** Register a DECLARATIVE panel (W3.1, B-01): the host renders the
 *  schema from the catalog and subscribes to this bundle's published
 *  bindings (`host.bindings`) for visibility/enablement. No React
 *  crosses the boundary — the isolate-ready panel form. Same namespace
 *  + capability gate as `contributePanel` (`contributes.panels[]` must
 *  list the id). */
export function contributeSchemaPanel(
  host: BundleHost,
  panel: SchemaPanelContribution,
): Disposable {
  return host.contribute.schemaPanel(panel);
}
