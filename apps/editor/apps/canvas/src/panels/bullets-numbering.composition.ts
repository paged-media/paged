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

// W2.4 (2026-06-06) — Bullets & Numbering panel, composed to the
// gallery "Bullets & Numbering" card's top rows. Protocol v28 lands
// the list-authoring text paths (`paragraphListType` +
// `paragraphBulletCharacter` + `paragraphNumberingFormat`), so the
// list-type segment flips seam→live here.
//
// List type rides the declarative toggle group: `ToggleGroupLeaf`
// reads/writes a `Value::Text`, and the engine carries the IDML enum
// string verbatim (`NoList` / `BulletList` / `NumberedList`). The
// bullet glyph + numbering-format fields are free text (no catalog
// leaf emits a bare text field), so they are hand-wired in
// bullets-panel.tsx over the same content-scope bindings.
//
// Content-scope bindings; the apply layer rounds the StoryRange to
// whole paragraphs (list type is a paragraph attribute). The list
// definition / level / restart / position rows from the gallery wait
// on a list-definition surface on the paragraph model and stay honest
// seams in the panel.

import type { CompositionNode } from "@paged-media/catalog";
import {
  PAGED_INPUT_TOGGLE_GROUP,
  PAGED_LAYOUT_SECTION,
  asPropertyFields,
} from "@paged-media/shell";
import { defineMessages, type Strings } from "@paged-media/strings";

const M = defineMessages("app.bulletsNumberingComposition", {
  bulletsNumbering: "Bullets & numbering",
  listType: "List type",
  none: "None",
  bullet: "Bullet",
  number: "Number",
});

// ADR 323 — every live field is a schema-driven `PropertyField`: the
// type comes from the target's schema row, reads/writes go through
// `host.objects` (one batch = one undo step over a multi-selection), and
// each field offers "Bind to data…" with a binding badge. Seams stay seams.
export function bulletsNumberingComposition(strings: Strings): CompositionNode {
  return asPropertyFields({
    catalogId: PAGED_LAYOUT_SECTION,
    props: { title: strings.t(M.bulletsNumbering), heading: false },
    bindings: {},
    children: [
      {
        catalogId: PAGED_INPUT_TOGGLE_GROUP,
        props: {
          label: strings.t(M.listType),
          options: [
            { value: "NoList", label: strings.t(M.none) },
            { value: "BulletList", label: strings.t(M.bullet) },
            { value: "NumberedList", label: strings.t(M.number) },
          ],
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "paragraphListType",
          },
        },
      },
    ],
  });
}
