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

// SDK Phase 3 / gallery pixel-parity — Paragraph panel, composed
// to the deep1 card (gallery-deep1.jsx `Paragraph`):
//
//   Align              (stacked label + icon segments)     LIVE
//   [0|0|0]            (3-up indents, sub-labels below)    LIVE
//   [0 pt | 6 pt]      (2-up space metrics)                LIVE
//   [Drop 0 | lines 0] (2-up + "Drop cap" caption)         LIVE
//   Hyphenate          (check row)                         LIVE
//   Align to baseline grid (check row)                     seam
//   Keep options       (disclosure)                        LIVE (v64)
//   Span columns       (disclosure)                        LIVE (v64)
//   Paragraph rules    (disclosure: above / below structs) LIVE (bespoke)
//
// Protocol 64 (2026-10-01) — the keep options, break-before rule and
// span/split columns became settable paragraph paths, so InDesign's
// Keep Options and Span Columns dialogs land here as two collapsible
// sections. "Keep with next" moved into Keep options and became the
// line COUNT it is in IDML (`KeepWithNext` is a count; the wire reads
// and writes `Value::Length`). It used to be a toggle that committed
// `Value::Bool`, which the engine refuses — and since the readback is
// a Length the pill could only ever show mixed.
//
// W2.1 (2026-06-06) — protocol v28 lands the paragraph layout paths
// (gap 12 closed). L/R indents, drop caps, hyphenation and keep
// options flip seam→live here; rule above/below are rendered bespoke
// in paragraph-panel.tsx (whole-struct `Value::ParagraphRule`, which
// no catalog leaf emits). Align-to-baseline-grid stays seamed (no
// matching PropertyPath on the v28 wire). Content-scope; paragraph
// paths round the range to whole paragraphs.

import type { Binding, CompositionNode } from "@paged-media/catalog";
import type { PropertyPath } from "@paged-media/client";
import {
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

const M = defineMessages("app.paragraphComposition", {
  linesSuffix: "lines",
  styleDefault: "[Style default]",
  keepOptions: "Keep options",
  keepWithNext: "Keep with next",
  keepLinesTogether: "Keep lines together",
  allLinesInParagraph: "All lines in paragraph",
  start: "Start",
  end: "End",
  startParagraph: "Start paragraph",
  anywhere: "Anywhere",
  inNextColumn: "In next column",
  inNextFrame: "In next frame",
  onNextPage: "On next page",
  onNextOddPage: "On next odd page",
  onNextEvenPage: "On next even page",
  spanColumns: "Span columns",
  paragraphLayout: "Paragraph layout",
  singleColumn: "Single column",
  splitColumn: "Split column",
  columns: "Columns",
  all: "All",
  paragraph: "Paragraph",
  align: "Align",
  lastLineIndent: "Last line indent",
  dropCap: "Drop cap",
  drop: "Drop",
  lines: "Lines",
  hyphenate: "Hyphenate",
  balanceRaggedLines: "Balance ragged lines",
  noBalancing: "No balancing",
  fullyBalanced: "Fully balanced",
  pyramid: "Pyramid",
  vee: "Vee",
  autoLeading: "Auto leading",
  singleWord: "Single word",
  fullJustify: "Full justify",
  alignLeft: "Align left",
  alignCenter: "Align center",
  alignRight: "Align right",
  alignToBaselineGrid: "Align to baseline grid",
  startLines: "Start lines",
  endLines: "End lines",
  spaceBefore: "Space before",
  spaceAfter: "Space after",
  insideGutter: "Inside gutter",
  outsideGutter: "Outside gutter",
  lIndent: "L indent",
  rIndent: "R indent",
  n1stIndent: "1st indent",
});

/** Content-scope binding over one paragraph path. */
function para(path: PropertyPath): Record<string, Binding> {
  return {
    value: {
      kind: "selectionProperty" as const,
      scope: "content" as const,
      path,
    },
  };
}

/** A paragraph path laid out ahead of the pinned engine (a paragraph's
 *  line setting, core ADR 153): the field renders only once the schema
 *  and the running engine report it (`hideUnreported`). The pinned wire's
 *  `PropertyPath` union does not name it yet, hence the cast. */
function paraAhead(path: string): Record<string, Binding> {
  return para(path as PropertyPath);
}

/** The "inherit" option every paragraph-level enum select carries: the
 *  engine stores the empty string as "no override", so the paragraph
 *  takes its style's value. */
const styleDefault = (strings: Strings) => ({
  value: "",
  label: strings.t(M.styleDefault),
});

/** Protocol 64 — InDesign's Keep Options dialog, inline. Counts ride
 *  `Value::Length` (integer-as-Length; em-dash = inherited), the
 *  toggles `Value::Bool`, the break-before rule `Value::Text` carrying
 *  the IDML `StartParagraph` string. All reflow-affecting. */
function keepOptionsSection(strings: Strings): CompositionNode {
  return {
    catalogId: PAGED_LAYOUT_SECTION,
    props: {
      title: strings.t(M.keepOptions),
      collapsible: true,
      defaultOpen: false,
    },
    bindings: {},
    children: [
      {
        catalogId: PAGED_INPUT_NUMERIC_SCRUB,
        props: {
          label: strings.t(M.keepWithNext),
          suffix: strings.t(M.linesSuffix),
        },
        bindings: para("paragraphKeepWithNext"),
      },
      {
        catalogId: PAGED_INPUT_TOGGLE_SWITCH,
        props: { label: strings.t(M.keepLinesTogether) },
        bindings: para("paragraphKeepLinesTogether"),
      },
      {
        catalogId: PAGED_INPUT_TOGGLE_SWITCH,
        props: { label: strings.t(M.allLinesInParagraph) },
        bindings: para("paragraphKeepAllLinesTogether"),
      },
      {
        // "At start/end of paragraph" — the orphan / widow counts the
        // engine applies while keep-lines is on and all-lines is off.
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: {
          count: 2,
          sublabels: [strings.t(M.startLines), strings.t(M.endLines)],
        },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: { prefix: strings.t(M.start) },
            bindings: para("paragraphKeepFirstLines"),
          },
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: { prefix: strings.t(M.end) },
            bindings: para("paragraphKeepLastLines"),
          },
        ],
      },
      {
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.startParagraph),
          labelPosition: "stack",
          options: [
            styleDefault(strings),
            { value: "Anywhere", label: strings.t(M.anywhere) },
            { value: "NextColumn", label: strings.t(M.inNextColumn) },
            { value: "NextFrame", label: strings.t(M.inNextFrame) },
            { value: "NextPage", label: strings.t(M.onNextPage) },
            { value: "NextOddPage", label: strings.t(M.onNextOddPage) },
            { value: "NextEvenPage", label: strings.t(M.onNextEvenPage) },
          ],
        },
        bindings: para("paragraphStartParagraph"),
      },
    ],
  };
}

/** Protocol 64 — InDesign's Span Columns dialog, inline. The layout
 *  and the column count are `Value::Text` (the count is "All" or a
 *  whole number — an enum-or-number no Length can say); the four
 *  spacings are `Value::Length` in pt. */
function spanColumnsSection(strings: Strings): CompositionNode {
  return {
    catalogId: PAGED_LAYOUT_SECTION,
    props: {
      title: strings.t(M.spanColumns),
      collapsible: true,
      defaultOpen: false,
    },
    bindings: {},
    children: [
      {
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.paragraphLayout),
          labelPosition: "stack",
          options: [
            styleDefault(strings),
            { value: "SingleColumn", label: strings.t(M.singleColumn) },
            { value: "SpanColumns", label: strings.t(M.spanColumns) },
            { value: "SplitColumns", label: strings.t(M.splitColumn) },
          ],
        },
        bindings: para("paragraphSpanColumnType"),
      },
      {
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.columns),
          options: [
            styleDefault(strings),
            { value: "All", label: strings.t(M.all) },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
            { value: "4", label: "4" },
            { value: "5", label: "5" },
            { value: "6", label: "6" },
          ],
        },
        bindings: para("paragraphSpanSplitColumnCount"),
      },
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: {
          count: 2,
          sublabels: [strings.t(M.spaceBefore), strings.t(M.spaceAfter)],
        },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-leading" },
            bindings: para("paragraphSpanColumnMinSpaceBefore"),
          },
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-leading" },
            bindings: para("paragraphSpanColumnMinSpaceAfter"),
          },
        ],
      },
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: {
          count: 2,
          sublabels: [strings.t(M.insideGutter), strings.t(M.outsideGutter)],
        },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-size" },
            bindings: para("paragraphSplitColumnInsideGutter"),
          },
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-size" },
            bindings: para("paragraphSplitColumnOutsideGutter"),
          },
        ],
      },
    ],
  };
}

// ADR 323 — every live field is a schema-driven `PropertyField`: the
// type comes from the target's schema row, reads/writes go through
// `host.objects` (one batch = one undo step over a multi-selection), and
// each field offers "Bind to data…" with a binding badge. Seams stay seams.
export function paragraphComposition(strings: Strings): CompositionNode {
  return asPropertyFields({
    catalogId: PAGED_LAYOUT_SECTION,
    props: { title: strings.t(M.paragraph), heading: false },
    bindings: {},
    children: [
      {
        catalogId: PAGED_INPUT_TOGGLE_GROUP,
        props: {
          label: strings.t(M.align),
          labelPosition: "stack",
          options: [
            { value: "LeftAlign", label: "ui-align-left" },
            { value: "CenterAlign", label: "ui-align-center" },
            { value: "RightAlign", label: "ui-align-right" },
            { value: "LeftJustified", label: "ui-align-justify" },
          ],
        },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "paragraphJustification",
          },
        },
      },
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: {
          count: 3,
          sublabels: [
            strings.t(M.lIndent),
            strings.t(M.rIndent),
            strings.t(M.n1stIndent),
          ],
        },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-align-left", showUnit: false },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "paragraphLeftIndent",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-align-right", showUnit: false },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "paragraphRightIndent",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-align-left", showUnit: false },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "paragraphFirstLineIndent",
              },
            },
          },
        ],
      },
      {
        catalogId: PAGED_INPUT_LENGTH,
        props: {
          label: strings.t(M.lastLineIndent),
          icon: "ui-align-right",
          showUnit: false,
          hideUnreported: true,
        },
        bindings: paraAhead("paragraphLastLineIndent"),
      },
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: { count: 2 },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-leading" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "paragraphSpaceBefore",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_LENGTH,
            props: { icon: "ui-leading" },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "paragraphSpaceAfter",
              },
            },
          },
        ],
      },
      {
        catalogId: PAGED_LAYOUT_CLUSTER,
        props: { count: 2, caption: strings.t(M.dropCap) },
        bindings: {},
        children: [
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: { prefix: strings.t(M.drop) },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "paragraphDropCapCharacters",
              },
            },
          },
          {
            catalogId: PAGED_INPUT_NUMERIC_SCRUB,
            props: { prefix: strings.t(M.lines) },
            bindings: {
              value: {
                kind: "selectionProperty",
                scope: "content",
                path: "paragraphDropCapLines",
              },
            },
          },
        ],
      },
      {
        catalogId: PAGED_INPUT_TOGGLE_SWITCH,
        props: { label: strings.t(M.hyphenate) },
        bindings: {
          value: {
            kind: "selectionProperty",
            scope: "content",
            path: "paragraphHyphenation",
          },
        },
      },
      // InDesign's Paragraph panel menu ▸ Balance Ragged Lines and its
      // Justification dialog (Auto Leading, Single Word Justification).
      {
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.balanceRaggedLines),
          hideUnreported: true,
          options: [
            styleDefault(strings),
            { value: "NoBalancing", label: strings.t(M.noBalancing) },
            { value: "FullyBalanced", label: strings.t(M.fullyBalanced) },
            { value: "PyramidShape", label: strings.t(M.pyramid) },
            { value: "VeeShape", label: strings.t(M.vee) },
          ],
        },
        bindings: paraAhead("paragraphBalanceRaggedLines"),
      },
      {
        catalogId: PAGED_INPUT_NUMERIC_SCRUB,
        props: {
          label: strings.t(M.autoLeading),
          suffix: "%",
          hideUnreported: true,
        },
        bindings: paraAhead("paragraphAutoLeading"),
      },
      {
        catalogId: PAGED_INPUT_SELECT,
        props: {
          label: strings.t(M.singleWord),
          hideUnreported: true,
          options: [
            styleDefault(strings),
            { value: "FullyJustified", label: strings.t(M.fullJustify) },
            { value: "LeftAlign", label: strings.t(M.alignLeft) },
            { value: "CenterAlign", label: strings.t(M.alignCenter) },
            { value: "RightAlign", label: strings.t(M.alignRight) },
          ],
        },
        bindings: paraAhead("paragraphSingleWordJustification"),
      },
      {
        // Engine gap — no align-to-baseline-grid PropertyPath on the
        // v28 wire; stays an honest seam.
        catalogId: PAGED_INPUT_TOGGLE_SWITCH,
        props: { label: strings.t(M.alignToBaselineGrid), seam: true },
        bindings: {},
      },
      keepOptionsSection(strings),
      spanColumnsSection(strings),
    ],
  });
}
