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
