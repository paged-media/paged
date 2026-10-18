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

// The field lists the slide panels render through the host's schema-driven
// `PropertyField` (object-model design §4): each entry names an object kind
// and the schema paths, in panel order, that one panel shows. The editor
// reads the row (type, range, title) from `host.objects.schema(kind)` and
// sets/gets through `host.objects`, so these lists carry no types of their
// own; a spec holds every path to the kind's schema.

export interface PanelFieldList {
  /** Panel id (the slide panels land with M3: sorter, notes, layouts). */
  panel: string;
  /** Qualified object kind: `plugin:<id>/<kind>`. */
  kind: string;
  /** Schema paths, in display order. */
  fields: readonly string[];
}

const SLIDE = "plugin:media.paged.slide/slide";
const PLACEHOLDER = "plugin:media.paged.slide/placeholder";
const DECK = "plugin:media.paged.slide/deck";

export const SLIDE_PANEL_FIELDS: readonly PanelFieldList[] = [
  { panel: "media.paged.slide.panel.slide", kind: SLIDE, fields: ["index", "layout", "hidden"] },
  // One line per entry: the cockpit object matrix reads `kind: K, fields: [...]` as written.
  // prettier-ignore
  { panel: "media.paged.slide.panel.transition", kind: SLIDE, fields: ["transitionKind", "transitionDirection", "transitionSpeed", "transitionDuration", "advanceOnClick", "advanceAfter"] },
  { panel: "media.paged.slide.panel.notes", kind: SLIDE, fields: ["notes"] },
  { panel: "media.paged.slide.panel.placeholder", kind: PLACEHOLDER, fields: ["type", "index", "content"] },
  { panel: "media.paged.slide.panel.deck", kind: DECK, fields: ["name", "slideWidth", "slideHeight", "slideCount", "fonts"] },
];
