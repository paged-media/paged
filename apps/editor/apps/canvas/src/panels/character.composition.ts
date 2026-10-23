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

// SDK Phase 3 / gallery pixel-parity — Character panel, composed
// to the deep1 card (gallery-deep1.jsx `Character`):
//
//   Family            (stacked label + select)            LIVE (bespoke)
//   [Style ▾ | 11 pt] (2-up: select + size metric)        LIVE | LIVE
//   [16 pt  | 0    ]  (2-up: leading + tracking metrics)  LIVE
//   [Metrics| 0 pt ]  (2-up: kerning + baseline metrics)  LIVE
//   [H 100 | V 100 | 0°] (3-up: scale + skew)             LIVE
//   Case              (label-left segments ab/AB/Ab)      LIVE
//   Position          (label-left icon segments)          LIVE
//   Underline / Strikethru / Ligatures (check rows)       LIVE
//   Language          (label-left select)                 LIVE
//   Fill              (label-left swatch — live extra;
//                      the card hosts fill in Properties)  LIVE
//   OPENTYPE          (bespoke chips in character-panel)  seam
//
// W2.1 (2026-06-06) — protocol v28 lands the character formatting
// paths (gaps 5/11 closed). Every field flips seam→live except
// Family (rendered bespoke in character-panel.tsx — the `fonts`
// collection rows key on `family`, not the `{selfId,name}` shape
// the catalog CollectionSelect leaf expects) and the OpenType chip
// row (the opaque `characterOtfFeatures` tag string has no chip
// mapping — see character-panel.tsx). Content-scope bindings; the
// binding hook maps the selection to a StoryRange.

import type { CompositionNode } from "@paged-media/catalog";
import type { PropertyPath } from "@paged-media/client";
import {
  PAGED_INPUT_COLOR_SWATCH,
  PAGED_INPUT_LENGTH,
  PAGED_INPUT_NUMERIC_SCRUB,
  PAGED_INPUT_SELECT,
  PAGED_INPUT_TOGGLE_GROUP,
  PAGED_INPUT_TOGGLE_SWITCH,
  PAGED_LAYOUT_CLUSTER,
  PAGED_LAYOUT_SECTION,
  asPropertyFields,
} from "@paged-media/shell";
import { defineMessages, type Strings } from "@paged-media/strings";

const M = defineMessages("app.characterComposition", {
  metrics: "Metrics",
  optical: "Optical",
  none: "None",
  englishUsa: "English: USA",
  englishUk: "English: UK",
  german: "German",
  french: "French",
  spanish: "Spanish",
  italian: "Italian",
  character: "Character",
  auto: "Auto",
  case: "Case",
  position: "Position",
  underline: "Underline",
  strikethrough: "Strikethrough",
  ligatures: "Ligatures",
  noBreak: "No break",
  language: "Language",
  fill: "Fill",
  hScale: "H scale",
  vScale: "V scale",
  skew: "Skew",
});

// Common IDML FontStyle face names — a static write surface (no
// per-family face listing on the wire yet). An out-of-list current
// value still renders via SelectLeaf's pass-through option.
const FONT_STYLES = [
  { value: "Regular", label: "Regular" },
  { value: "Italic", label: "Italic" },
  { value: "Bold", label: "Bold" },
  { value: "Bold Italic", label: "Bold Italic" },
  { value: "Light", label: "Light" },
  { value: "Medium", label: "Medium" },
  { value: "Semibold", label: "Semibold" },
];

// IDML KerningMethod enum strings.
const kerningMethods = (strings: Strings) => [
  { value: "Metrics", label: strings.t(M.metrics) },
  { value: "Optical", label: strings.t(M.optical) },
  { value: "None", label: strings.t(M.none) },
];

// A pragmatic short list of IDML AppliedLanguage names; an
// out-of-list current value renders via the pass-through option.
const languages = (strings: Strings) => [
  { value: "$ID/English: USA", label: strings.t(M.englishUsa) },
  { value: "$ID/English: UK", label: strings.t(M.englishUk) },
  { value: "$ID/German", label: strings.t(M.german) },
  { value: "$ID/French", label: strings.t(M.french) },
  { value: "$ID/Spanish", label: strings.t(M.spanish) },
  { value: "$ID/Italian", label: strings.t(M.italian) },
];

// ADR 323 — every live field is a schema-driven `PropertyField`: the
// type comes from the target's schema row, reads/writes go through
// `host.objects` (one batch = one undo step over a multi-selection), and
// each field offers "Bind to data…" with a binding badge. Seams stay seams.
export function characterComposition(strings: Strings): CompositionNode {
  return asPropertyFields({
    catalogId: PAGED_LAYOUT_SECTION,
    props: { title: strings.t(M.character), heading: false },
    bindings: {},
    children: [
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: { count: 2 },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_SELECT,
            props: { placeholder: "—", options: FONT_STYLES },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterFontStyle",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-size" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterFontSize",
              },
            },
          },
        ],
      },
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: { count: 2 },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_LENGTH,
            // Unset leading is Auto (R3, PN-21), not 0 pt.
            props: { icon: "ui-leading", unsetText: strings.t(M.auto) },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterLeading",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: { icon: "ui-tracking" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterTracking",
              },
            },
          },
        ],
      },
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: { count: 2 },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_SELECT,
            props: { icon: "ui-kerning", options: kerningMethods(strings) },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterKerningMethod",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-size" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterBaselineShift",
              },
            },
          },
        ],
      },
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: {
          count: 3,
          sublabels: [
            strings.t(M.hScale),
            strings.t(M.vScale),
            strings.t(M.skew),
          ],
        },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: { suffix: "%" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterHorizontalScale",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: { suffix: "%" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterVerticalScale",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: { suffix: "°" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "characterSkew",
              },
            },
          },
        ],
      },
      {
        catalogId: PAGED_INPUT_TOGGLE_GROUP,
        props: {
          label: strings.t(M.case),
          options: [
            { value: "Normal", label: "ab" },
            { value: "AllCaps", label: "AB" },
            { value: "SmallCaps", label: "Ab" },
          ],
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "characterCase",
          },
        },
      },
      {
        catalogId: PAGED_INPUT_TOGGLE_GROUP,
        props: {
          label: strings.t(M.position),
          options: [
            { value: "Normal", label: "ui-minus" },
            { value: "Superscript", label: "ui-size" },
            { value: "Subscript", label: "ui-leading" },
          ],
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "characterPosition",
          },
        },
      },
      {
        catalogId: PAGED_INPUT_TOGGLE_SWITCH,
        props: { label: strings.t(M.underline) },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "characterUnderline",
          },
        },
      },
      {
        catalogId: PAGED_INPUT_TOGGLE_SWITCH,
        props: { label: strings.t(M.strikethrough) },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "characterStrikethru",
          },
        },
      },
      {
        catalogId: PAGED_INPUT_TOGGLE_SWITCH,
        props: { label: strings.t(M.ligatures) },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "characterLigatures",
          },
        },
      },
      {
        // InDesign's Character panel menu ▸ No Break. Laid out ahead of the
        // pinned engine (core ADR 153): shown once the schema and the
        // running engine report the path; the pinned wire's `PropertyPath`
        // union does not name it yet, hence the cast.
        catalogId: PAGED_INPUT_TOGGLE_SWITCH,
        props: { label: strings.t(M.noBreak), hideUnreported: true },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "characterNoBreak" as PropertyPath,
          },
        },
      },
      {
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.language),
          placeholder: "—",
          options: languages(strings),
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "characterLanguage",
          },
        },
      },
      {
        // LIVE extra beyond the card (the card hosts fill in the
        // Properties inspector) — kept for capability.
        catalogId: PAGED_INPUT_COLOR_SWATCH,
        props: { label: strings.t(M.fill) },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "characterFillColor",
          },
        },
      },
    ],
  });
}
