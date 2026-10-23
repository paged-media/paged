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

// SDK Phase 5 / gallery pixel-parity — Text Frame Options, composed
// to the deep1 card (gallery-deep1.jsx `TextFrame`):
//
//   COLUMNS kicker → [⫼ count | gutter] 2-up      LIVE
//   Balance (label-left toggle)                   LIVE
//   INSET SPACING kicker → 4-up T/L/B/R           LIVE
//   Vert. justify (label-left icon segments)      LIVE
//   Auto-size (label-left select)                 LIVE
//   First baseline (label-left select)            LIVE
//
// W2.3 (2026-06-06) — protocol v28 lands the text-frame-preference
// paths (engine gap 13 closed). Every field flips seam→live on its
// `textFrame*` PropertyPath.
//
// TextFrame-ONLY parse fields: the apply arms + read-side only
// expose these on `NodeId::TextFrame`. On Rectangle / Oval / Polygon
// / GraphicLine there is no PropertyEntry, so the binding reads null
// and every control em-dashes — the same kind-specific honesty as
// the W2.2 stroke join/miter/align rows.
//
// Enum-string wires (`Value::Text`): the canvas read-side returns
// the RAW IDML enum string verbatim, so the select/segment option
// `value`s MUST be those exact strings to reflect + round-trip:
//   • Vert. justify → `{Top,Center,Bottom,Justify}Align`
//   • Auto-size     → `Off | HeightOnly | WidthOnly | HeightAndWidth
//                      | HeightAndWidthProportionally`
//   • First baseline→ `AscentOffset | CapHeight | XHeight | EmBoxHeight
//                      | LeadingOffset | FixedHeight`
// An unset field reads back as `Value::Text("")` (the enum's
// Default) — SelectLeaf keeps an empty option visible rather than
// snapping to the first entry.

import type { CompositionNode } from "@paged-media/catalog";
import {
  PAGED_INPUT_BOUNDS,
  PAGED_INPUT_NUMERIC_SCRUB,
  PAGED_INPUT_SELECT,
  PAGED_INPUT_TOGGLE_GROUP,
  PAGED_INPUT_TOGGLE_SWITCH,
  PAGED_LAYOUT_CLUSTER,
  PAGED_LAYOUT_SECTION,
  asPropertyFields,
} from "@paged-media/shell";
import { defineMessages, type Strings } from "@paged-media/strings";

const M = defineMessages("app.textFrameOptionsComposition", {
  off: "Off",
  heightOnly: "Height only",
  widthOnly: "Width only",
  heightWidth: "Height & width",
  proportional: "Proportional",
  ascent: "Ascent",
  capHeight: "Cap height",
  xHeight: "x height",
  emBoxHeight: "Em box height",
  leading: "Leading",
  fixed: "Fixed",
  textFrameOptions: "Text Frame Options",
  columns: "Columns",
  gutter: "gutter",
  balance: "Balance",
  insetSpacing: "Inset spacing",
  vertJustify: "Vert. justify",
  autoSize: "Auto-size",
  firstBaseline: "First baseline",
});

// IDML `<TextFramePreference VerticalJustification="...">` values.
const VERTICAL_JUSTIFY = [
  { value: "TopAlign", label: "ui-align-left" },
  { value: "CenterAlign", label: "ui-align-center" },
  { value: "BottomAlign", label: "ui-align-right" },
  { value: "JustifyAlign", label: "ui-align-justify" },
];

// IDML `<TextFramePreference AutoSizingType="...">` values.
const autoSizing = (strings: Strings) => [
  { value: "Off", label: strings.t(M.off) },
  { value: "HeightOnly", label: strings.t(M.heightOnly) },
  { value: "WidthOnly", label: strings.t(M.widthOnly) },
  { value: "HeightAndWidth", label: strings.t(M.heightWidth) },
  { value: "HeightAndWidthProportionally", label: strings.t(M.proportional) },
];

// IDML `<TextFramePreference FirstBaselineOffset="...">` values.
const firstBaseline = (strings: Strings) => [
  { value: "AscentOffset", label: strings.t(M.ascent) },
  { value: "CapHeight", label: strings.t(M.capHeight) },
  { value: "XHeight", label: strings.t(M.xHeight) },
  { value: "EmBoxHeight", label: strings.t(M.emBoxHeight) },
  { value: "LeadingOffset", label: strings.t(M.leading) },
  { value: "FixedHeight", label: strings.t(M.fixed) },
];

// ADR 323 — every live field is a schema-driven `PropertyField`: the
// type comes from the target's schema row, reads/writes go through
// `host.objects` (one batch = one undo step over a multi-selection), and
// each field offers "Bind to data…" with a binding badge. Seams stay seams.
export function textFrameOptionsComposition(strings: Strings): CompositionNode {
  return asPropertyFields({
    catalogId: PAGED_LAYOUT_SECTION,
    props: { title: strings.t(M.textFrameOptions), heading: false },
    bindings: {},
    children: [
      {
        catalogId: PAGED_LAYOUT_SECTION,
        props: { title: strings.t(M.columns) },
        bindings: {},
        children: [
          {
            catalogId: PAGED_LAYOUT_CLUSTER,
            props: { count: 2 },
            bindings: {},
            children: [
              {
                // LIVE column count (clamped ≥1 + rounded engine-side).
                catalogId: PAGED_INPUT_NUMERIC_SCRUB,
                props: { icon: "ui-cols-2" },
                bindings: {
                  value: {
                    kind: "selectionProperty",
                    scope: "element",
                    path: "textFrameColumnCount",
                  },
                },
              },
              {
                // LIVE column gutter (points).
                catalogId: PAGED_INPUT_NUMERIC_SCRUB,
                props: { prefix: strings.t(M.gutter) },
                bindings: {
                  value: {
                    kind: "selectionProperty",
                    scope: "element",
                    path: "textFrameColumnGutter",
                  },
                },
              },
            ],
          },
          {
            // LIVE balance flag.
            catalogId: PAGED_INPUT_TOGGLE_SWITCH,
            props: { label: strings.t(M.balance), labelPosition: "left" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "element",
                path: "textFrameColumnBalance",
              },
            },
          },
        ],
      },
      {
        catalogId: PAGED_LAYOUT_SECTION,
        props: { title: strings.t(M.insetSpacing) },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_BOUNDS,
            props: { layout: "row4" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "element",
                path: "frameInsetSpacing",
              },
            },
          },
        ],
      },
      {
        // LIVE vertical justification (TextFrame-only → em-dash on
        // other kinds). Glyph segments per the deep1 card.
        catalogId: PAGED_INPUT_TOGGLE_GROUP,
        props: { label: strings.t(M.vertJustify), options: VERTICAL_JUSTIFY },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "textFrameVerticalJustification",
          },
        },
      },
      {
        // LIVE auto-size rule.
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.autoSize),
          placeholder: strings.t(M.off),
          options: autoSizing(strings),
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "textFrameAutoSizing",
          },
        },
      },
      {
        // LIVE first-baseline offset.
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.firstBaseline),
          placeholder: strings.t(M.ascent),
          options: firstBaseline(strings),
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "element",
            path: "textFrameFirstBaseline",
          },
        },
      },
    ],
  });
}
