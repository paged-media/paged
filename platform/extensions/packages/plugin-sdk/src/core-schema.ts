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

// The SEAM schema for core's property paths, until core publishes ADR 132's
// `propertySchemas` in the catalog (core branch om/schema). One row per
// `PropertyPath` of the vendored wire, keyed by the path — a
// `Record<PropertyPath, …>`, so a re-vendored wire with a NEW path fails
// typecheck here until it is classified (the totality gate ADR 132 asks of
// core, mirrored).
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

import type { PropertyPath, ValueType } from "@paged-media/plugin-api";

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
const PCT: ValueType = { kind: "number", unit: "percent" };

export const CORE_PATHS: Record<PropertyPath, CorePathRow | typeof OP> = {
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
  frameStrokeMiterLimit: { scope: "frame", wire: "length", type: { kind: "length" } },
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
  frameInnerShadowChoke: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameInnerShadowNoise: { scope: "frame", wire: "length", type: PCT },
  frameOuterGlowEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameOuterGlowBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameOuterGlowColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameOuterGlowOpacity: { scope: "frame", wire: "length", type: PCT },
  frameOuterGlowSpread: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameOuterGlowSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameOuterGlowNoise: { scope: "frame", wire: "length", type: PCT },
  frameInnerGlowEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameInnerGlowBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameInnerGlowColor: { scope: "frame", wire: "colorRef", type: { kind: "color" } },
  frameInnerGlowOpacity: { scope: "frame", wire: "length", type: PCT },
  frameInnerGlowChoke: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameInnerGlowSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameInnerGlowSource: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameInnerGlowNoise: { scope: "frame", wire: "length", type: PCT },
  frameBevelEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameBevelStyle: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameBevelTechnique: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameBevelDepth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameBevelDirection: { scope: "frame", wire: "text", type: { kind: "text" } },
  frameBevelSize: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameBevelSoften: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameBevelAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameBevelAltitude: { scope: "frame", wire: "length", type: { kind: "length" } },
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
  frameFeatherChoke: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherEnabled: { scope: "frame", wire: "bool", type: { kind: "bool" } },
  frameDirectionalFeatherLeftWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherRightWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherTopWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherBottomWidth: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameDirectionalFeatherAngle: { scope: "frame", wire: "length", type: { kind: "number", unit: "deg" } },
  frameDirectionalFeatherNoise: { scope: "frame", wire: "length", type: PCT },
  frameDirectionalFeatherChoke: { scope: "frame", wire: "length", type: { kind: "length" } },
  frameBlendMode: { scope: "frame", wire: "text", type: { kind: "text" } },
  nextTextFrame: { scope: "frame", wire: "text", type: { kind: "ref", to: "frame" } },
  previousTextFrame: { scope: "frame", wire: "text", type: { kind: "ref", to: "frame" } },
  cellFillColor: { scope: "cell", wire: "colorRef", type: { kind: "color" }, inferred: true },
  cellFillTint: { scope: "cell", wire: "length", type: PCT, inferred: true },
  cellInsetTop: { scope: "cell", wire: "text", type: { kind: "text" }, inferred: true },
  cellInsetLeft: { scope: "cell", wire: "text", type: { kind: "text" }, inferred: true },
  cellInsetBottom: { scope: "cell", wire: "text", type: { kind: "text" }, inferred: true },
  cellInsetRight: { scope: "cell", wire: "text", type: { kind: "text" }, inferred: true },
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
  frameStrokeEndArrowhead: { scope: "frame", wire: "text", type: { kind: "text" } },};

/** Opacity / tint rows carry the 0–100 range. */
export function corePathRange(path: string): { min: number; max: number } | undefined {
  return /Opacity|Tint$/.test(path) ? { min: 0, max: 100 } : undefined;
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
