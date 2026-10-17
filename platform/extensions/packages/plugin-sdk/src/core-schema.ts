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

// Core's property schemas, two ways:
//
// * Protocol 71 and later (`CORE_SCHEMA_71`, below): core publishes ADR
//   132's typed `propertySchemas` in the catalog, and this file only
//   NORMALISES the vendored catalog's rows into the SDK's `PropertySchema`
//   (enums with their members, struct shapes, list item types, ranges,
//   defaults). Nothing is inferred.
// * Below protocol 71 (`CORE_PATHS`): the interim table the 0.70 seam
//   (core-objects-v70.ts) writes through, kept so an editor on a published
//   engine below 71 still works. One row per `PropertyPath` of the vendored
//   wire, keyed by the path — a `Record<PropertyPath, …>`, so a re-vendored
//   wire with a NEW path fails typecheck here until it is classified (the
//   totality gate ADR 132 asks of core, mirrored). Paths a pre-71 engine
//   does not have are `{ since: 71 }`.
//
// Unit-less numbers on the `length` wire variant (a miter limit is a
// multiple of the stroke width; chokes, spreads and bevel depth are
// percentages; bevel altitude is an angle) are typed by MEANING, from core's
// PropertyPath doc comments (audit 2026-10-06), not by the wire variant.
//
// Where each row comes from: the wire `Value` variant the published engine
// (0.69.0) answers for that path in `requestElementProperties` /
// `requestStyleProperties`, read off a real document. The table's own
// `type` is now only a FALLBACK: wherever core's catalog types the same
// path, the pre-71 seam serves the catalog's type, range and default
// (enum members included) — the wire variant is the same on the older
// engine. `inferred: true` is left only on the four paths core's catalog
// gives no row (`tableRowCount`, `tableColumnCount`, and since 0.71.13
// `tableHeaderRowCount`, `tableFooterRowCount`): read-only counts.
//
// `wire` is the `Value` variant a WRITE must carry. Rows without `type`
// are structured values (gradient feather, paragraph rules, tab stops) or
// geometry ops (path points, outline/offset/simplify) — not schema rows;
// they stay reachable by passing a raw wire `Value` (`{ type, value }`).

import type { PropertyPath, PropertySchema, ValueType } from "@paged-media/plugin-api";

// Named imports, so the bundler keeps only these two keys of the catalog.
import { pathAliases, propertySchemas } from "../../plugin-api/src/catalog.json";

export type CorePathScope = "frame" | "story" | "cell" | "table" | "layer" | "page";

export interface CorePathRow {
  scope: CorePathScope;
  /** The wire `Value` variant a write carries. */
  wire: string;
  type?: ValueType;
  inferred?: true;
  readOnly?: true;
}

const OP = { op: true } as const;
/** A path the pre-71 wire does not carry: only the protocol-71 seam reaches it. */
const V71 = { since: 71 } as const;
const PCT: ValueType = { kind: "number", unit: "percent" };

export const CORE_PATHS: Record<PropertyPath, CorePathRow | typeof OP | typeof V71> = {
  frameBounds: { scope: "frame", wire: "bounds", type: { kind: "bounds" } },
  frameFillColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameStrokeColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameStrokeWeight: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameOpacity: { scope: "frame", wire: "length", type: PCT },
  frameTransform: { scope: "frame", wire: "transform", type: { kind: "transform" } },
  imageContentTransform: { scope: "frame", wire: "transform", type: { kind: "transform" } },
  framePathPoint: OP,
  pathPointInsert: OP,
  pathPointRemove: OP,
  pathPointCurveType: OP,
  layerVisible: { scope: "layer", wire: "bool", type: { kind: "bool" } },
  layerLocked: { scope: "layer", wire: "bool", type: { kind: "bool" } },
  layerPrintable: { scope: "layer", wire: "bool", type: { kind: "bool" } },
  layerName: { scope: "layer", wire: "text", type: { kind: "text" } },
  characterFontSize: { scope: "story", wire: "length", type: { kind: "length" } },
  characterLeading: { scope: "story", wire: "length", type: { kind: "length" } },
  characterTracking: { scope: "story", wire: "length", type: { kind: "number", unit: "em1000" } },
  characterFillColor: { scope: "story", wire: "colorRef", type: { kind: "color" } },
  paragraphSpaceBefore: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphSpaceAfter: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphFirstLineIndent: { scope: "story", wire: "length", type: { kind: "length" } },
  appliedParagraphStyle: { scope: "story", wire: "text", type: { kind: "ref", to: "style:paragraph" } },
  appliedCharacterStyle: { scope: "story", wire: "text", type: { kind: "ref", to: "style:character" } },
  appliedObjectStyle: { scope: "frame", wire: "text", type: { kind: "ref", to: "style:object" } },
  itemLayer: { scope: "frame", wire: "text", type: { kind: "ref", to: "layer" } },
  appliedCellStyle: { scope: "cell", wire: "text", type: { kind: "ref", to: "style:cell" } },
  appliedTableStyle: { scope: "table", wire: "text", type: { kind: "ref", to: "style:table" } },
  framePath: OP,
  frameNonprinting: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameFillTint: { scope: "frame", wire: "length", type: PCT },
  frameGradientFillAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameGradientFillLength: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameGradientStrokeAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameGradientStrokeLength: { scope: "frame", wire: "length", type: { kind: "length" } },
  pathOpenAt: OP,
  outlineStroke: OP,
  outlineStrokeVariable: OP,
  offsetPath: OP,
  simplifyPath: OP,
  closePath: OP,
  frameGradientFeather: { scope: "frame", wire: "gradientFeather" },
  pageBounds: { scope: "page", wire: "bounds", type: { kind: "bounds" } },
  frameDropShadowMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameDropShadowXOffset: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDropShadowYOffset: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDropShadowSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDropShadowOpacity: { scope: "frame", wire: "length", type: PCT },
  frameDropShadowColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameDropShadow: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameFittingCrops: { scope: "frame", wire: "bounds", type: { kind: "bounds" } },
  frameFittingType: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameTextWrapMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameTextWrapOffsets: { scope: "frame", wire: "bounds", type: { kind: "bounds" } },
  frameTextWrapContourType: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameTextWrapContourIncludeInside: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  paragraphJustification: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphStyleNextStyle: { scope: "story", wire: "text", type: { kind: "ref", to: "style:paragraph" } },
  paragraphAppliedNumberingList: { scope: "story", wire: "text", type: { kind: "text" } },
  frameStrokeEndCap: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameInsetSpacing: { scope: "frame", wire: "bounds", type: { kind: "bounds" } },
  appliedConditions: { scope: "story", wire: "text", type: { kind: "text" } },
  characterFontFamily: { scope: "story", wire: "text", type: { kind: "text" } },
  characterFontStyle: { scope: "story", wire: "text", type: { kind: "text" } },
  characterKerningMethod: { scope: "story", wire: "text", type: { kind: "text" } },
  characterCase: { scope: "story", wire: "text", type: { kind: "text" } },
  characterPosition: { scope: "story", wire: "text", type: { kind: "text" } },
  characterLanguage: { scope: "story", wire: "text", type: { kind: "text" } },
  characterBaselineShift: { scope: "story", wire: "length", type: { kind: "length" } },
  characterHorizontalScale: { scope: "story", wire: "length", type: { kind: "number", unit: "percent" } },
  characterVerticalScale: { scope: "story", wire: "length", type: { kind: "number", unit: "percent" } },
  characterSkew: { scope: "story", wire: "length", type: { kind: "number", unit: "deg" } },
  characterUnderline: { scope: "story", wire: "bool", type: { kind: "bool" } },
  characterStrikethru: { scope: "story", wire: "bool", type: { kind: "bool" } },
  characterLigatures: { scope: "story", wire: "bool", type: { kind: "bool" } },
  characterNoBreak: { scope: "story", wire: "bool", type: { kind: "bool" } },
  characterOtfFeatures: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphLeftIndent: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphRightIndent: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphDropCapCharacters: { scope: "story", wire: "length", type: { kind: "number", integer: true } },
  paragraphDropCapLines: { scope: "story", wire: "length", type: { kind: "number", integer: true } },
  paragraphHyphenation: { scope: "story", wire: "bool", type: { kind: "bool" } },
  paragraphHyphenationZone: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphKeepLinesTogether: { scope: "story", wire: "bool", type: { kind: "bool" } },
  paragraphKeepWithNext: { scope: "story", wire: "length", type: { kind: "number", integer: true } },
  paragraphKeepAllLinesTogether: { scope: "story", wire: "bool", type: { kind: "bool" } },
  paragraphKeepFirstLines: { scope: "story", wire: "length", type: { kind: "number", integer: true } },
  paragraphKeepLastLines: { scope: "story", wire: "length", type: { kind: "number", integer: true } },
  paragraphStartParagraph: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphSpanColumnType: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphSpanSplitColumnCount: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphSpanColumnMinSpaceBefore: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphSpanColumnMinSpaceAfter: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphSplitColumnInsideGutter: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphSplitColumnOutsideGutter: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphRuleAbove: { scope: "story", wire: "paragraphRule" },
  paragraphRuleBelow: { scope: "story", wire: "paragraphRule" },
  paragraphTabStops: { scope: "story", wire: "tabStops" },
  paragraphListType: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphBulletCharacter: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphNumberingFormat: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphBulletsTextAfter: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphNumberingExpression: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphNumberingStartAt: { scope: "story", wire: "length", type: { kind: "number", integer: true } },
  paragraphNumberingContinue: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphBulletsCharacterStyle: { scope: "story", wire: "text", type: { kind: "ref", to: "style:character" } },
  paragraphNumberingCharacterStyle: { scope: "story", wire: "text", type: { kind: "ref", to: "style:character" } },
  paragraphComposer: { scope: "story", wire: "text", type: { kind: "text" } },
  // core ADR 153 — a paragraph's line setting.
  paragraphAutoLeading: { scope: "story", wire: "length", type: PCT },
  paragraphSingleWordJustification: { scope: "story", wire: "text", type: { kind: "text" } },
  paragraphLastLineIndent: { scope: "story", wire: "length", type: { kind: "length" } },
  paragraphBalanceRaggedLines: { scope: "story", wire: "text", type: { kind: "text" } },
  // core ADR 158 — a paragraph's level in a multi-level list; the restart
  // flag is tristate like NumberingContinue (Text("") clears).
  paragraphNumberingLevel: { scope: "story", wire: "length", type: { kind: "number", integer: true } },
  paragraphNumberingApplyRestartPolicy: { scope: "story", wire: "text", type: { kind: "text" } },
  textFrameColumnCount: { scope: "frame", wire: "length", type: { kind: "number", integer: true } },
  textFrameColumnGutter: { scope: "frame", wire: "length", type: { kind: "length" } },
  textFrameColumnBalance: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  textFrameVerticalJustification: { scope: "frame", wire: "text", type: { kind: "text" } },
  textFrameAutoSizing: { scope: "frame", wire: "text", type: { kind: "text" } },
  textFrameFirstBaseline: { scope: "frame", wire: "text", type: { kind: "text" } },
  textWrapInvert: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameFittingReferencePoint: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameAutoFit: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameStrokeType: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameStrokeJoin: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameStrokeMiterLimit: { scope: "frame", wire: "length", type: { kind: "number" } },
  frameStrokeAlignment: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameStrokeGapColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameStrokeGapTint: { scope: "frame", wire: "length", type: PCT },
  frameStrokeDashArray: { scope: "frame", wire: "lengths", type: { kind: "list", of: { kind: "length" } } },
  frameCornerOptionTopLeft: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameCornerOptionTopRight: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameCornerOptionBottomLeft: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameCornerOptionBottomRight: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameCornerRadiusTopLeft: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameCornerRadiusTopRight: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameCornerRadiusBottomLeft: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameCornerRadiusBottomRight: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameRotationAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameScaleX: { scope: "frame", wire: "length", type: { kind: "number" } },
  frameScaleY: { scope: "frame", wire: "length", type: { kind: "number" } },
  frameFlipH: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameFlipV: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameOverprintFill: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameOverprintStroke: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameInnerShadowEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameInnerShadowBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameInnerShadowColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameInnerShadowOpacity: { scope: "frame", wire: "length", type: PCT },
  frameInnerShadowAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameInnerShadowDistance: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameInnerShadowSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameInnerShadowChoke: { scope: "frame", wire: "length", type: PCT },
  frameInnerShadowNoise: { scope: "frame", wire: "length", type: PCT },
  frameOuterGlowEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameOuterGlowBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameOuterGlowColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameOuterGlowOpacity: { scope: "frame", wire: "length", type: PCT },
  frameOuterGlowSpread: { scope: "frame", wire: "length", type: PCT },
  frameOuterGlowSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameOuterGlowNoise: { scope: "frame", wire: "length", type: PCT },
  frameInnerGlowEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameInnerGlowBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameInnerGlowColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameInnerGlowOpacity: { scope: "frame", wire: "length", type: PCT },
  frameInnerGlowChoke: { scope: "frame", wire: "length", type: PCT },
  frameInnerGlowSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameInnerGlowSource: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameInnerGlowNoise: { scope: "frame", wire: "length", type: PCT },
  frameBevelEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameBevelStyle: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameBevelTechnique: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameBevelDepth: { scope: "frame", wire: "length", type: PCT },
  frameBevelDirection: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameBevelSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameBevelSoften: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameBevelAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameBevelAltitude: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameBevelHighlightColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameBevelShadowColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameBevelHighlightOpacity: { scope: "frame", wire: "length", type: PCT },
  frameBevelShadowOpacity: { scope: "frame", wire: "length", type: PCT },
  frameSatinEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameSatinBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameSatinColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameSatinOpacity: { scope: "frame", wire: "length", type: PCT },
  frameSatinAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameSatinDistance: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameSatinSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameSatinInvert: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameFeatherEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameFeatherWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameFeatherCornerType: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameFeatherNoise: { scope: "frame", wire: "length", type: PCT },
  frameFeatherChoke: { scope: "frame", wire: "length", type: PCT },
  frameDirectionalFeatherEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameDirectionalFeatherLeftWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherRightWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherTopWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherBottomWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameDirectionalFeatherNoise: { scope: "frame", wire: "length", type: PCT },
  frameDirectionalFeatherChoke: { scope: "frame", wire: "length", type: PCT },
  frameBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  nextTextFrame: { scope: "frame", wire: "text", type: { kind: "ref", to: "frame" } },
  previousTextFrame: { scope: "frame", wire: "text", type: { kind: "ref", to: "frame" } },
  cellFillColor: { scope: "cell", wire: "colorRef", type: { kind: "color" } },
  cellFillTint: { scope: "cell", wire: "length", type: PCT },
  cellInsetTop: { scope: "cell", wire: "length", type: { kind: "length" } },
  cellInsetLeft: { scope: "cell", wire: "length", type: { kind: "length" } },
  cellInsetBottom: { scope: "cell", wire: "length", type: { kind: "length" } },
  cellInsetRight: { scope: "cell", wire: "length", type: { kind: "length" } },
  cellVerticalJustification: { scope: "cell", wire: "text", type: { kind: "text" } },
  cellTopEdgeStrokeColor: { scope: "cell", wire: "colorRef", type: { kind: "color" } },
  cellTopEdgeStrokeWeight: { scope: "cell", wire: "length", type: { kind: "length" } },
  cellTopEdgeStrokeTint: { scope: "cell", wire: "length", type: PCT },
  cellBottomEdgeStrokeColor: { scope: "cell", wire: "colorRef", type: { kind: "color" } },
  cellBottomEdgeStrokeWeight: { scope: "cell", wire: "length", type: { kind: "length" } },
  cellBottomEdgeStrokeTint: { scope: "cell", wire: "length", type: PCT },
  cellLeftEdgeStrokeColor: { scope: "cell", wire: "colorRef", type: { kind: "color" } },
  cellLeftEdgeStrokeWeight: { scope: "cell", wire: "length", type: { kind: "length" } },
  cellLeftEdgeStrokeTint: { scope: "cell", wire: "length", type: PCT },
  cellRightEdgeStrokeColor: { scope: "cell", wire: "colorRef", type: { kind: "color" } },
  cellRightEdgeStrokeWeight: { scope: "cell", wire: "length", type: { kind: "length" } },
  cellRightEdgeStrokeTint: { scope: "cell", wire: "length", type: PCT },
  // A table row's own options, written through any cell of it (core
  // ADR 175); the catalog types rowStartRow's members.
  rowStartRow: { scope: "cell", wire: "text", type: { kind: "text" } },
  rowKeepWithNext: { scope: "cell", wire: "bool", type: { kind: "bool" } },
  tableRowCount: { scope: "table", wire: "length", type: { kind: "number", integer: true }, inferred: true, readOnly: true },
  tableColumnCount: { scope: "table", wire: "length", type: { kind: "number", integer: true }, inferred: true, readOnly: true },
  // Core v0.71.13 (ADR 159): a table's header and footer bands, read-only and
  // unadvertised like the two counts above (the bands change through
  // insertHeaderRow / removeHeaderRow and their footer twins). An older
  // engine answers "no such readable path".
  tableHeaderRowCount: { scope: "table", wire: "length", type: { kind: "number", integer: true }, inferred: true, readOnly: true },
  tableFooterRowCount: { scope: "table", wire: "length", type: { kind: "number", integer: true }, inferred: true, readOnly: true },
  pluginMetadata: OP,
  anchoredPosition: { scope: "frame", wire: "text", type: { kind: "text" } },
  anchorPoint: { scope: "frame", wire: "text", type: { kind: "text" } },
  anchoredXOffset: { scope: "frame", wire: "length", type: { kind: "length" } },
  anchoredYOffset: { scope: "frame", wire: "length", type: { kind: "length" } },
  anchoredHorizontalReference: { scope: "frame", wire: "text", type: { kind: "text" } },
  anchoredVerticalReference: { scope: "frame", wire: "text", type: { kind: "text" } },
  anchoredHorizontalAlignment: { scope: "frame", wire: "text", type: { kind: "text" } },
  anchoredVerticalAlignment: { scope: "frame", wire: "text", type: { kind: "text" } },
  anchoredSpineRelative: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  anchoredLockPosition: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  elementVisible: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  elementLocked: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameStrokeStartArrowhead: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameStrokeEndArrowhead: { scope: "frame", wire: "text", type: { kind: "text" } },
  // Core v0.71.7 (ADR 135): transparency per target and the effect attributes.
  frameFillOpacity: { scope: "frame", wire: "length", type: PCT },
  frameFillBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameStrokeOpacity: { scope: "frame", wire: "length", type: PCT },
  frameStrokeBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameContentOpacity: { scope: "frame", wire: "length", type: PCT },
  frameContentBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  groupIsolateBlending: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  groupKnockout: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameDropShadowBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameDropShadowSpread: { scope: "frame", wire: "length", type: PCT },
  frameDropShadowNoise: { scope: "frame", wire: "length", type: PCT },
  frameDropShadowKnockedOut: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameDropShadowUseGlobalLight: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  // Protocol 71 (ADR 132): modelled fields that were unsettable before.
  pageMarginTop: V71,
  pageMarginBottom: V71,
  pageMarginLeft: V71,
  pageMarginRight: V71,
  pageColumnCount: V71,
  pageColumnGutter: V71,
  documentBleedTop: V71,
  documentBleedBottom: V71,
  documentBleedInsideOrLeft: V71,
  documentBleedOutsideOrRight: V71,
  documentSlugTop: V71,
  documentSlugBottom: V71,
  documentSlugInsideOrLeft: V71,
  documentSlugRightOrOutside: V71,
  documentGlobalLightAngle: V71,
  documentGlobalLightAltitude: V71,
  textVariableName: V71,
  textVariableType: V71,
  textVariableContents: V71,
  textVariableTextBefore: V71,
  textVariableTextAfter: V71,
  textVariableDateFormat: V71,
  objectStyleStrokeTint: V71,
  objectStyleCornerRadius: V71,
  objectStyleCornerOption: V71,
  cellStyleRotationAngle: V71,
  tableStyleHeaderRegionCellStyle: V71,
  tableStyleBodyRegionCellStyle: V71,
  tableStyleFooterRegionCellStyle: V71,
  tableStyleLeftColumnRegionCellStyle: V71,
  tableStyleRightColumnRegionCellStyle: V71,
  tableStyleTopBorderStrokeColor: V71,
  tableStyleTopBorderStrokeWeight: V71,
  tableStyleBottomBorderStrokeColor: V71,
  tableStyleBottomBorderStrokeWeight: V71,
  tableStyleLeftBorderStrokeColor: V71,
  tableStyleLeftBorderStrokeWeight: V71,
  tableStyleRightBorderStrokeColor: V71,
  tableStyleRightBorderStrokeWeight: V71,
  tableStyleAlternatingFills: V71,
  tableStyleStartRowFillColor: V71,
  tableStyleStartRowFillCount: V71,
  tableStyleStartRowFillTint: V71,
  tableStyleEndRowFillColor: V71,
  tableStyleEndRowFillCount: V71,
  tableStyleEndRowFillTint: V71,
  itemName: V71,
  // Core v0.71.13 (ADR 162): the document's footnote options, on the `doc`
  // address; the catalog types them.
  documentFootnoteNumberingStyle: V71,
  documentFootnoteStartAt: V71,
  documentFootnoteRestartNumbering: V71,
  documentFootnotePrefix: V71,
  documentFootnoteSuffix: V71,
  documentFootnoteShowPrefixSuffix: V71,
  documentFootnoteEnableStraddling: V71,
  documentFootnoteNoSplitting: V71,
  documentFootnoteSpaceBetween: V71,
  documentFootnoteSpacer: V71,
  documentFootnoteRuleOn: V71,
  documentFootnoteContinuingRuleOn: V71,
};

/** Ranges the SDK knows from core's PropertyPath docs: opacity / tint /
 *  noise / choke / spread percentages are 0–100; a miter limit is a
 *  multiple of the stroke width, 1–500 (InDesign's limits). */
export function corePathRange(path: string): { min: number; max: number } | undefined {
  if (path === "frameStrokeMiterLimit") return { min: 1, max: 500 };
  return /Opacity|Tint$|Noise$|Choke$|GlowSpread$/.test(path) ? { min: 0, max: 100 } : undefined;
}

/** The catalog's advertised ALIASES (Boa names) → the wire path, mirrored
 *  from `catalog.json` `pathAliases`. Accepted on input, never listed. */
export const CORE_PATH_ALIASES: Readonly<Record<string, PropertyPath>> = {
  frameTextWrapInvert: "textWrapInvert",
  frameInnerShadow: "frameInnerShadowEnabled",
  frameOuterGlow: "frameOuterGlowEnabled",
  frameInnerGlow: "frameInnerGlowEnabled",
  frameBevel: "frameBevelEnabled",
  frameSatin: "frameSatinEnabled",
  frameFeather: "frameFeatherEnabled",
  frameDirectionalFeather: "frameDirectionalFeatherEnabled",
};

/** A core path name with its alias resolved. */
export const canonicalCorePath = (path: string): string => CORE_PATH_ALIASES[path] ?? path;

// ------------------------------------------------- protocol 71: the catalog

/** One `propertySchemas` row as core's catalog publishes it (protocol 71). */
export interface CoreCatalogRow {
  addressKind: string;
  appliesTo?: readonly string[];
  path: string;
  type: { kind: string; unit?: string; members?: readonly string[]; to?: string; of?: string; shape?: string };
  wire: string;
  nullable?: boolean;
  range?: { min?: number; max?: number; step?: number };
  default?: unknown;
  access?: "readWrite" | "readOnly" | "derived";
  virtual?: { op: string; field?: string; clearOp?: string } | null;
  bindable?: boolean;
}

/** A normalised core row: the SDK schema row, the wire `Value` variant a
 *  write carries, and the CORE address kind the row belongs to (the SDK
 *  folds `storyRange` into `story` and `group` into `frame`). */
export interface CoreRow71 {
  schema: PropertySchema;
  wire: string;
  coreKind: string;
  /** Not in core's catalog: typed from the interim table (CORE_ROWLESS_PATHS). */
  inferred?: true;
}

const UNIT: Record<string, "pt" | "deg" | "percent" | "em1000" | "ppi"> = {
  degrees: "deg",
  deg: "deg",
  percent: "percent",
  em1000: "em1000",
  ppi: "ppi",
};

/** Core's catalog type → the SDK's `ValueType`; null for an OPERATION row
 *  (path-point edits, outline / offset / simplify): those are geometry
 *  ops, not values, and stay reachable as a raw wire `{ type, value }`. */
export function normalizeCoreType(t: CoreCatalogRow["type"]): ValueType | null {
  switch (t.kind) {
    case "operation":
      return null;
    case "bool":
    case "length":
    case "color":
    case "bounds":
    case "transform":
    case "point":
      return { kind: t.kind } as ValueType;
    case "number": {
      // A number row's `members` are words it takes in place of a number
      // (a span count's "All"); dropping them made the row refuse them.
      const keywords = t.members?.length ? { keywords: [...t.members] } : {};
      if (t.unit === "count") return { kind: "number", integer: true, ...keywords };
      const unit = t.unit ? UNIT[t.unit] : undefined;
      return unit ? { kind: "number", unit, ...keywords } : { kind: "number", ...keywords };
    }
    case "enum":
      return { kind: "enum", members: [...(t.members ?? [])] };
    case "text":
      return { kind: "text" };
    case "asset":
      return t.shape ? { kind: "asset", shape: t.shape } : { kind: "asset" };
    case "ref":
      return { kind: "ref", to: t.to ?? "object" };
    case "struct":
      return { kind: "struct", fields: {}, ...(t.shape ? { shape: t.shape } : {}), open: true };
    case "list": {
      const of =
        t.of === "struct"
          ? t.shape === "swatch ref"
            ? ({ kind: "ref", to: "swatch" } as ValueType)
            : ({ kind: "struct", fields: {}, ...(t.shape ? { shape: t.shape } : {}), open: true } as ValueType)
          : normalizeCoreType({ kind: t.of ?? "text" });
      return { kind: "list", of: of ?? { kind: "text" } };
    }
    default:
      return { kind: "text" };
  }
}

/** The SDK kind a core catalog row serves (`style` rows split by family). */
function sdkKindsOf(row: CoreCatalogRow): string[] {
  switch (row.addressKind) {
    case "storyRange":
    case "story":
      return ["story"];
    case "group":
      return ["frame"];
    case "style":
      return (row.appliesTo ?? ["paragraph", "character", "object", "cell", "table"]).map((f) => `style:${f}`);
    default:
      return [row.addressKind];
  }
}

/** The raw rows of the vendored catalog (empty before protocol 71). */
export const CORE_CATALOG_ROWS: readonly CoreCatalogRow[] =
  propertySchemas as unknown as CoreCatalogRow[];

let schema71: Map<string, Map<string, CoreRow71>> | null = null;

/** Catalog rows core lists as read-write but does not STORE: the engine
 *  accepts the `Set` and drops it, and `RequestGet` answers null. The SDK
 *  marks them read-only (and unbindable) so a field or a binding cannot
 *  claim a write that never lands. Remove an entry when core models the
 *  value (or flips the row itself). Empty since engine 0.71.11, which
 *  stores a cell's fill tint (`cell|cellFillTint`, the only entry it had). */
export const CORE_UNSTORED_ROWS: ReadonlyMap<string, string> = new Map<string, string>([]);

/** The catalog names a few rows by their Boa ALIAS (`frameInnerShadow`);
 *  the SDK lists every core row under its WIRE path, as the registry
 *  canonicalises input (`canonicalCorePath`). */
const CATALOG_ALIASES: ReadonlyMap<string, string> = new Map(
  (pathAliases as { name: string; wire: string }[]).map((a) => [a.name, a.wire]),
);

/** Wire PropertyPaths core's catalog gives NO row (protocol 71): still
 *  reachable through `Set` / `RequestGet`, typed from the interim table
 *  and marked so. The SDK infers nothing else. */
export const CORE_ROWLESS_PATHS: readonly string[] = Object.keys(CORE_PATHS).filter((p) => {
  const row = (CORE_PATHS as Record<string, CorePathRow | { op: true } | { since: 71 }>)[p]!;
  if ("op" in row || "since" in row || !row.type) return false;
  return !CORE_CATALOG_ROWS.some((r) => (CATALOG_ALIASES.get(r.path) ?? r.path) === p);
});

/** SDK kind → path → normalised row, from the vendored catalog. Indexed
 *  core paths (`labels[key]`, `rows[i].height`) become `[]` rows. */
export function coreSchema71(): ReadonlyMap<string, ReadonlyMap<string, CoreRow71>> {
  if (schema71) return schema71;
  const out = new Map<string, Map<string, CoreRow71>>();
  for (const row of CORE_CATALOG_ROWS) {
    const type = normalizeCoreType(row.type);
    if (!type) continue;
    const path = (CATALOG_ALIASES.get(row.path) ?? row.path).replace(/\[[^\]]*\]/g, "[]");
    for (const kind of sdkKindsOf(row)) {
      const base = kind.startsWith("style:") ? "style" : kind;
      const schema: PropertySchema = { addressKind: base, path, type };
      if (row.appliesTo && row.addressKind !== "style") schema.appliesTo = row.appliesTo;
      if (row.addressKind === "group") schema.appliesTo = ["group"];
      if (row.nullable !== undefined) schema.nullable = row.nullable;
      if (row.range) schema.range = row.range;
      if (row.default !== undefined) schema.default = row.default;
      if (row.access && row.access !== "readWrite") schema.access = row.access;
      if (row.virtual) schema.virtual = row.virtual;
      if (row.bindable !== undefined) schema.bindable = row.bindable;
      schema.since = 71;
      const unstored = CORE_UNSTORED_ROWS.get(`${row.addressKind}|${path}`);
      if (unstored && (schema.access ?? "readWrite") === "readWrite") {
        schema.access = "readOnly";
        schema.bindable = false;
        schema.summary = unstored;
      }
      const m = out.get(kind) ?? new Map<string, CoreRow71>();
      if (!m.has(path)) m.set(path, { schema, wire: row.wire, coreKind: row.addressKind });
      out.set(kind, m);
    }
  }
  const coreKindOfScope: Record<CorePathScope, string> = { frame: "frame", story: "storyRange", cell: "cell", table: "table", layer: "layer", page: "page" };
  for (const path of CORE_ROWLESS_PATHS) {
    const row = (CORE_PATHS as Record<string, CorePathRow>)[path]!;
    const schema: PropertySchema = {
      addressKind: row.scope,
      path,
      type: row.type!,
      nullable: true,
      summary: "Not typed by core's catalog (protocol 71): typed from the SDK's interim table.",
    };
    if (row.readOnly) schema.access = "readOnly";
    const m = out.get(row.scope) ?? new Map<string, CoreRow71>();
    m.set(path, { schema, wire: row.wire, coreKind: coreKindOfScope[row.scope], inferred: true });
    out.set(row.scope, m);
  }
  schema71 = out;
  return out;
}

/** The OPERATION paths of the catalog (raw wire values only). */
export const CORE_OPERATION_PATHS: ReadonlySet<string> = new Set(
  CORE_CATALOG_ROWS.filter((r) => r.type.kind === "operation").map((r) => r.path),
);
