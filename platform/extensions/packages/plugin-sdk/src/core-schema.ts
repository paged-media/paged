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
// `requestStyleProperties` on frames, story ranges and styles, read off a
// real document (`inferred` absent). Rows the probe could not reach (layer,
// page, cell, table, anchored-object paths) are inferred from the name and
// marked `inferred: true`. Semantic refinements over the wire variant
// (`length` → `number` in deg / percent / integer; `text` → `ref`) follow
// the path names; enum MEMBERS are not known to the SDK, so enum-like paths
// are `text` until core's table names them.
//
// `wire` is the `Value` variant a WRITE must carry. Rows without `type`
// are structured values (gradient feather, paragraph rules, tab stops) or
// geometry ops (path points, outline/offset/simplify) — not schema rows;
// they stay reachable by passing a raw wire `Value` (`{ type, value }`).

import type { PropertyPath, PropertySchema, ValueType } from "@paged-media/plugin-api";

import catalog from "../../plugin-api/src/catalog.json";

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
  imageContentTransform: { scope: "frame", wire: "transform", type: { kind: "transform" }, inferred: true },
  framePathPoint: OP,
  pathPointInsert: OP,
  pathPointRemove: OP,
  pathPointCurveType: OP,
  layerVisible: { scope: "layer", wire: "bool", type: { kind: "bool" }, inferred: true },
  layerLocked: { scope: "layer", wire: "bool", type: { kind: "bool" }, inferred: true },
  layerPrintable: { scope: "layer", wire: "bool", type: { kind: "bool" }, inferred: true },
  layerName: { scope: "layer", wire: "text", type: { kind: "text" }, inferred: true },
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
  appliedCellStyle: { scope: "cell", wire: "text", type: { kind: "ref", to: "style:cell" }, inferred: true },
  appliedTableStyle: { scope: "table", wire: "text", type: { kind: "ref", to: "style:table" }, inferred: true },
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
  pageBounds: { scope: "page", wire: "bounds", type: { kind: "bounds" }, inferred: true },
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
  appliedConditions: { scope: "story", wire: "text", type: { kind: "text" }, inferred: true },
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
  cellFillColor: { scope: "cell", wire: "colorRef", type: { kind: "color" }, inferred: true },
  cellFillTint: { scope: "cell", wire: "length", type: PCT, inferred: true },
  cellInsetTop: { scope: "cell", wire: "length", type: { kind: "length" }, inferred: true },
  cellInsetLeft: { scope: "cell", wire: "length", type: { kind: "length" }, inferred: true },
  cellInsetBottom: { scope: "cell", wire: "length", type: { kind: "length" }, inferred: true },
  cellInsetRight: { scope: "cell", wire: "length", type: { kind: "length" }, inferred: true },
  cellVerticalJustification: { scope: "cell", wire: "text", type: { kind: "text" }, inferred: true },
  cellTopEdgeStrokeColor: { scope: "cell", wire: "colorRef", type: { kind: "color" }, inferred: true },
  cellTopEdgeStrokeWeight: { scope: "cell", wire: "length", type: { kind: "length" }, inferred: true },
  cellTopEdgeStrokeTint: { scope: "cell", wire: "length", type: PCT, inferred: true },
  cellBottomEdgeStrokeColor: { scope: "cell", wire: "colorRef", type: { kind: "color" }, inferred: true },
  cellBottomEdgeStrokeWeight: { scope: "cell", wire: "length", type: { kind: "length" }, inferred: true },
  cellBottomEdgeStrokeTint: { scope: "cell", wire: "length", type: PCT, inferred: true },
  cellLeftEdgeStrokeColor: { scope: "cell", wire: "colorRef", type: { kind: "color" }, inferred: true },
  cellLeftEdgeStrokeWeight: { scope: "cell", wire: "length", type: { kind: "length" }, inferred: true },
  cellLeftEdgeStrokeTint: { scope: "cell", wire: "length", type: PCT, inferred: true },
  cellRightEdgeStrokeColor: { scope: "cell", wire: "colorRef", type: { kind: "color" }, inferred: true },
  cellRightEdgeStrokeWeight: { scope: "cell", wire: "length", type: { kind: "length" }, inferred: true },
  cellRightEdgeStrokeTint: { scope: "cell", wire: "length", type: PCT, inferred: true },
  tableRowCount: { scope: "table", wire: "length", type: { kind: "number", integer: true }, inferred: true, readOnly: true },
  tableColumnCount: { scope: "table", wire: "length", type: { kind: "number", integer: true }, inferred: true, readOnly: true },
  pluginMetadata: OP,
  anchoredPosition: { scope: "frame", wire: "text", type: { kind: "text" }, inferred: true },
  anchorPoint: { scope: "frame", wire: "text", type: { kind: "text" }, inferred: true },
  anchoredXOffset: { scope: "frame", wire: "length", type: { kind: "length" }, inferred: true },
  anchoredYOffset: { scope: "frame", wire: "length", type: { kind: "length" }, inferred: true },
  anchoredHorizontalReference: { scope: "frame", wire: "text", type: { kind: "text" }, inferred: true },
  anchoredVerticalReference: { scope: "frame", wire: "text", type: { kind: "text" }, inferred: true },
  anchoredHorizontalAlignment: { scope: "frame", wire: "text", type: { kind: "text" }, inferred: true },
  anchoredVerticalAlignment: { scope: "frame", wire: "text", type: { kind: "text" }, inferred: true },
  anchoredSpineRelative: { scope: "frame", wire: "bool", type: { kind: "bool" }, inferred: true },
  anchoredLockPosition: { scope: "frame", wire: "bool", type: { kind: "bool" }, inferred: true },
  elementVisible: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  elementLocked: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameStrokeStartArrowhead: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameStrokeEndArrowhead: { scope: "frame", wire: "text", type: { kind: "text" } },
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
  virtual?: { op: string; field?: string } | null;
  bindable?: boolean;
}

/** A normalised core row: the SDK schema row, the wire `Value` variant a
 *  write carries, and the CORE address kind the row belongs to (the SDK
 *  folds `storyRange` into `story` and `group` into `frame`). */
export interface CoreRow71 {
  schema: PropertySchema;
  wire: string;
  coreKind: string;
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
      if (t.unit === "count") return { kind: "number", integer: true };
      const unit = t.unit ? UNIT[t.unit] : undefined;
      return unit ? { kind: "number", unit } : { kind: "number" };
    }
    case "enum":
      return { kind: "enum", members: [...(t.members ?? [])] };
    case "text":
      return { kind: "text" };
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
  ((catalog as unknown as { propertySchemas?: CoreCatalogRow[] }).propertySchemas ?? []);

let schema71: Map<string, Map<string, CoreRow71>> | null = null;

/** SDK kind → path → normalised row, from the vendored catalog. Indexed
 *  core paths (`labels[key]`, `rows[i].height`) become `[]` rows. */
export function coreSchema71(): ReadonlyMap<string, ReadonlyMap<string, CoreRow71>> {
  if (schema71) return schema71;
  const out = new Map<string, Map<string, CoreRow71>>();
  for (const row of CORE_CATALOG_ROWS) {
    const type = normalizeCoreType(row.type);
    if (!type) continue;
    const path = row.path.replace(/\[[^\]]*\]/g, "[]");
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
      const m = out.get(kind) ?? new Map<string, CoreRow71>();
      if (!m.has(path)) m.set(path, { schema, wire: row.wire, coreKind: row.addressKind });
      out.set(kind, m);
    }
  }
  schema71 = out;
  return out;
}

/** The OPERATION paths of the catalog (raw wire values only). */
export const CORE_OPERATION_PATHS: ReadonlySet<string> = new Set(
  CORE_CATALOG_ROWS.filter((r) => r.type.kind === "operation").map((r) => r.path),
);
