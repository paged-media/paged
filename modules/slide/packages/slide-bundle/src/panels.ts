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

// ADR 323 (object-model design §4 "Panels") — SLIDE_PANEL_FIELDS as schema
// panels of PROPERTY ROWS: the host renders each row with its one
// schema-driven `PropertyField` over `host.objects` (widget from the
// slide / placeholder / deck schema row, one undo step per commit, "Bind to
// data…" on every field). The bundle declares fields, never widgets.
//
// Address forms:
//   · slide       — "selection" scoped to the kind: the slide the selected
//                   item sits on (`<item> > slide`);
//   · placeholder — "selection" scoped to the kind: the selected frame, when
//                   it is a placeholder (`<item> > placeholder`);
//   · deck        — the selector `plugin:media.paged.slide/deck` (one per
//                   document, doc-hosted).

import type { PanelSchema, PropertyFieldAddress } from "@paged-media/plugin-api";
import { propertyRows } from "@paged-media/plugin-sdk";

import { SLIDE_PANEL_FIELDS, type PanelFieldList } from "./panel-fields.js";

const DECK = "plugin:media.paged.slide/deck";

const TITLES: Record<string, string> = {
  "media.paged.slide.panel.slide": "Slide",
  "media.paged.slide.panel.transition": "Transition",
  "media.paged.slide.panel.notes": "Speaker notes",
  "media.paged.slide.panel.placeholder": "Placeholder",
  "media.paged.slide.panel.deck": "Deck",
};

/** The address a list's rows edit. */
export function addressFor(kind: string): PropertyFieldAddress {
  return kind === DECK ? DECK : "selection";
}

function panelOf(list: PanelFieldList): PanelSchema {
  return {
    id: list.panel,
    title: TITLES[list.panel] ?? list.panel,
    icon: "panel-pages",
    defaultDock: "right",
    sections: [{ rows: propertyRows(list.kind, list.fields, addressFor(list.kind)) }],
  };
}

/** One schema panel per field list, in declaration order. */
export const SLIDE_PANELS: readonly PanelSchema[] = SLIDE_PANEL_FIELDS.map(panelOf);
