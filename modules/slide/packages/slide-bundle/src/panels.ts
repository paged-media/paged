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

import type {
  PanelSchema,
  PropertyFieldAddress,
} from "@paged-media/plugin-api";
import { propertyRows } from "@paged-media/plugin-sdk";
import { t } from "@paged-media/strings";

import { PANELS } from "./messages.js";
import { SLIDE_PANEL_FIELDS, type PanelFieldList } from "./panel-fields.js";

const DECK = "plugin:media.paged.slide/deck";

/** Each panel's title, a message key. */
const TITLES: Record<string, string> = {
  "media.paged.slide.panel.slide": PANELS.slide,
  "media.paged.slide.panel.transition": PANELS.transition,
  "media.paged.slide.panel.notes": PANELS.notes,
  "media.paged.slide.panel.placeholder": PANELS.placeholder,
  "media.paged.slide.panel.deck": PANELS.deck,
};

/** The address a list's rows edit. */
export function addressFor(kind: string): PropertyFieldAddress {
  return kind === DECK ? DECK : "selection";
}

function panelOf(list: PanelFieldList): PanelSchema {
  return {
    id: list.panel,
    title: t(TITLES[list.panel] ?? list.panel),
    icon: "panel-pages",
    defaultDock: "right",
    sections: [
      { rows: propertyRows(list.kind, list.fields, addressFor(list.kind)) },
    ],
  };
}

/** One schema panel per field list, in declaration order, titled in the
 *  editor's language when they are registered. */
export const slidePanels = (): readonly PanelSchema[] =>
  SLIDE_PANEL_FIELDS.map(panelOf);
