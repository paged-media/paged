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

// SDK Phase 3 / gallery pixel-parity — Stroke panel, composed to
// the deep1 card (gallery-deep1.jsx `Stroke`): all label-left rows.
//
//   Weight  metric "1 pt"                       LIVE
//   Color   swatch                              LIVE
//   Type    select "Solid"                      LIVE  (W2.2)
//   Cap     segments                            LIVE
//   Join    icon segments                       LIVE  (W2.2, Rect-only)
//   Miter   metric "4"                          LIVE  (W2.2, Rect-only)
//   Align   segments Center/Inside/Outside      LIVE  (W2.2, Rect-only)
//   Gap     swatch + tint metric                LIVE  (W2.2)
//   Dashes & arrows (collapsed): dash pattern + start/end arrowheads
//
// W2.2 (2026-06-06) — protocol v28 lands the stroke-detail paths
// (engine gap 17 closed bar dash-array + arrowheads). Every detail
// field flips seam→live on its `frameStroke*` PropertyPath.
//
// Enum-string wires (`Value::Text`): the canvas read-side returns
// the RAW IDML reference / enum string, so the select/segment option
// `value`s MUST be those exact strings to reflect + round-trip:
//   • Type      → `StrokeStyle/$ID/{Solid,Dashed,Dotted}` (the
//                 built-in StrokeType refs the renderer maps to a
//                 dash pattern; Striped/Wavy only exist for custom
//                 `<StrokeStyle>` definitions, not the built-in $ID
//                 names, so they're out of the static list).
//   • Join      → `{Miter,Round,Bevel}EndJoin`
//   • Alignment → `{Center,Inside,Outside}Alignment`
// Join / Miter / Alignment are Rectangle-only parse fields (the apply
// arm + read-side only expose them on Rectangle) — they em-dash on
// TextFrame / Oval / Polygon / GraphicLine, the same kind-specific
// honesty as the existing end-cap row.
//
// Dashes & arrows are live on `frameStrokeDashArray` and the two
// `frameStroke*Arrowhead` paths (they were seams until those paths
// reached the wire; paged.draw's "Vector stroke" panel carried them
// meanwhile, and is merged into this one).

import type { CompositionNode } from "@paged-media/catalog";
import {
  PAGED_INPUT_COLOR_SWATCH,
  PAGED_INPUT_LENGTH,
  PAGED_INPUT_NUMERIC_SCRUB,
  PAGED_INPUT_SELECT,
  PAGED_INPUT_TOGGLE_GROUP,
  PAGED_LAYOUT_SECTION,
  asPropertyFields,
} from "@paged-media/shell";
import { defineMessages, type Strings } from "@paged-media/strings";

const M = defineMessages("app.strokeComposition", {
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
  none: "None",
  simple: "Simple",
  triangle: "Triangle",
  circle: "Circle",
  bar: "Bar",
  stroke: "Stroke",
  weight: "Weight",
  color: "Color",
  type: "Type",
  cap: "Cap",
  join: "Join",
  miter: "Miter",
  align: "Align",
  center: "Center",
  inside: "Inside",
  outside: "Outside",
  gapColor: "Gap color",
  gapTint: "Gap tint",
  dashesArrows: "Dashes & arrows",
  dashPattern: "Dash pattern",
  start: "Start",
  end: "End",
});

// Built-in IDML StrokeType references. The canvas read-side returns
// the full `StrokeStyle/$ID/...` ref; an out-of-list custom stroke
// still renders via SelectLeaf's pass-through option.
const strokeTypes = (strings: Strings) => [
  { value: "StrokeStyle/$ID/Solid", label: strings.t(M.solid) },
  { value: "StrokeStyle/$ID/Dashed", label: strings.t(M.dashed) },
  { value: "StrokeStyle/$ID/Dotted", label: strings.t(M.dotted) },
];

// ADR 323 — every live field is a schema-driven `PropertyField`: the
// type comes from the target's schema row, reads/writes go through
// `host.objects` (one batch = one undo step over a multi-selection), and
// each field offers "Bind to data…" with a binding badge. Seams stay seams.
/** Core's `frameStroke*Arrowhead` enum, with words for its members. */
const arrowheadOptions = (strings: Strings) => [
  { value: "None", label: strings.t(M.none) },
  { value: "SimpleArrowHead", label: strings.t(M.simple) },
  { value: "TriangleArrowHead", label: strings.t(M.triangle) },
  { value: "CircleSolidArrowHead", label: strings.t(M.circle) },
  { value: "BarArrowHead", label: strings.t(M.bar) },
];

export function strokeComposition(strings: Strings): CompositionNode {
  return asPropertyFields({
    catalogId: PAGED_LAYOUT_SECTION,
    props: { title: strings.t(M.stroke), heading: false },
    bindings: {},
    children: [
      {
        catalogId: PAGED_INPUT_LENGTH,
        props: { label: strings.t(M.weight), icon: "ui-size" },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeWeight",
          },
        },
      },
      {
        catalogId: PAGED_INPUT_COLOR_SWATCH,
        props: { label: strings.t(M.color) },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeColor",
          },
        },
      },
      {
        // LIVE stroke-type (built-in StrokeStyle refs → dash pattern).
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.type),
          placeholder: strings.t(M.solid),
          options: strokeTypes(strings),
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeType",
          },
        },
      },
      {
        // LIVE end-cap (TextFrame raises UnsupportedProperty →
        // em-dash group).
        catalogId: PAGED_INPUT_TOGGLE_GROUP,
        props: {
          label: strings.t(M.cap),
          options: [
            { value: "ButtEndCap", label: "—" },
            { value: "RoundEndCap", label: "○" },
            { value: "ProjectingEndCap", label: "□" },
          ],
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeEndCap",
          },
        },
      },
      {
        // LIVE end-join (Rectangle-only parse field → em-dash on
        // other kinds). Glyph stand-ins per the deep1 card.
        catalogId: PAGED_INPUT_TOGGLE_GROUP,
        props: {
          label: strings.t(M.join),
          options: [
            { value: "MiterEndJoin", label: "tool-polygon" },
            { value: "RoundEndJoin", label: "tool-ellipse" },
            { value: "BevelEndJoin", label: "tool-rectangle" },
          ],
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeJoin",
          },
        },
      },
      {
        // LIVE miter limit (Rectangle-only).
        catalogId: PAGED_INPUT_NUMERIC_SCRUB,
        props: { label: strings.t(M.miter) },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeMiterLimit",
          },
        },
      },
      {
        // LIVE stroke-to-path alignment (Rectangle-only).
        catalogId: PAGED_INPUT_TOGGLE_GROUP,
        props: {
          label: strings.t(M.align),
          options: [
            { value: "CenterAlignment", label: strings.t(M.center) },
            { value: "InsideAlignment", label: strings.t(M.inside) },
            { value: "OutsideAlignment", label: strings.t(M.outside) },
          ],
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeAlignment",
          },
        },
      },
      {
        // LIVE gap colour + tint (the colour painted between dashes /
        // stripes). Mirrors the frameStrokeColor swatch binding.
        catalogId: PAGED_INPUT_COLOR_SWATCH,
        props: { label: strings.t(M.gapColor) },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeGapColor",
          },
        },
      },
      {
        catalogId: PAGED_INPUT_NUMERIC_SCRUB,
        props: { label: strings.t(M.gapTint), suffix: "%" },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "frameStrokeGapTint",
          },
        },
      },
      {
        // Dashes and arrowheads, on the core paths paged.draw's separate
        // "Vector stroke" panel used to carry (the two panels are merged
        // here). The dash pattern is a list (dash, gap, dash, gap … in pt):
        // its PropertyField renders the schema's list editor. Arrowheads
        // apply to lines and open paths; core refuses them elsewhere.
        catalogId: PAGED_LAYOUT_SECTION,
        props: {
          title: strings.t(M.dashesArrows),
          collapsible: true,
          defaultOpen: false,
        },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: {
              label: strings.t(M.dashPattern),
              labelPosition: "stack",
              suffix: "pt",
            },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "element",
                path: "frameStrokeDashArray",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_SELECT,
            props: {
              label: strings.t(M.start),
              labelPosition: "stack",
              options: arrowheadOptions(strings),
            },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "element",
                path: "frameStrokeStartArrowhead",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_SELECT,
            props: {
              label: strings.t(M.end),
              labelPosition: "stack",
              options: arrowheadOptions(strings),
            },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "element",
                path: "frameStrokeEndArrowhead",
              },
            },
          },
        ],
      },
    ],
  });
}
