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

// The loss report of a placement (publish ADR 658): every construct the
// page reader or the lowering could not carry exactly, worded, with how
// often it happened. Codes are the mapper's (`vectors::ir::Loss`); a code
// this table does not know is still reported, by its code.

import { defineMessages, t } from "@paged-media/strings";

import type { LossIr, PdfInfo } from "./ir";

const M = defineMessages("publish.pdfVectorLosses", {
  shadingFunctionSampled:
    "{count, plural, one {# function shading was} other {# function shadings were}} sampled to an image",
  shadingMeshSampled:
    "{count, plural, one {# mesh shading was} other {# mesh shadings were}} sampled to an image",
  shadingFocalSampled:
    "{count, plural, one {# radial gradient with a moved centre was} other {# radial gradients with a moved centre were}} sampled to an image",
  shadingSkewedSampled:
    "{count, plural, one {# skewed radial gradient was} other {# skewed radial gradients were}} sampled to an image",
  shadingDegenerate:
    "{count, plural, one {# gradient without a length was} other {# gradients without a length were}} sampled to an image",
  shadingNoExtend:
    "{count, plural, one {# gradient stops} other {# gradients stop}} at its ends in the PDF; the native gradient continues its end colours",
  patternTilingExpanded:
    "{count, plural, one {# pattern fill was} other {# pattern fills were}} expanded into copies of its tile",
  patternTilingFlattened:
    "{count, plural, one {# pattern fill with too many tiles was} other {# pattern fills with too many tiles were}} filled with the tile's colour",
  patternTooDeep:
    "{count, plural, one {# nested pattern was} other {# nested patterns were}} left out",
  strokeNonuniform:
    "{count, plural, one {# stroke was} other {# strokes were}} drawn under an uneven scale; the width is an average",
  strokePattern:
    "{count, plural, one {# patterned stroke was} other {# patterned strokes were}} given a solid colour",
  strokeGradient:
    "{count, plural, one {# gradient stroke was} other {# gradient strokes were}} given its first colour",
  strokeHairline:
    "{count, plural, one {# hairline was} other {# hairlines were}} given a width of 0.25 pt",
  strokeDashPhase:
    "{count, plural, one {# dash pattern starts} other {# dash patterns start}} at an offset that native dashes do not carry",
  gradientNonuniform:
    "{count, plural, one {# gradient was} other {# gradients were}} placed under an uneven scale",
  textInvisible:
    "{count, plural, one {# run of invisible text (a scan's text layer) was} other {# runs of invisible text (a scan's text layer) were}} left out",
  textStroked:
    "{count, plural, one {# run of outlined text keeps} other {# runs of outlined text keep}} only its fill",
  textType3AsPaths:
    "{count, plural, one {# Type 3 glyph run arrived} other {# Type 3 glyph runs arrived}} as paths",
  textPatternFill:
    "{count, plural, one {# run of pattern-filled text was} other {# runs of pattern-filled text were}} set in black",
  textUnmatchedOutlined:
    "{count, plural, one {# text run the text reader did not recover was} other {# text runs the text reader did not recover were}} placed as outlines",
  textRotatedOutlined:
    "{count, plural, one {# rotated text frame was} other {# rotated text frames were}} placed as outlines",
  textMissingFontOutlined:
    "{count, plural, one {# text frame in a font the document lacks was} other {# text frames in fonts the document lacks were}} placed as outlines",
  textMissingFont:
    "{count, plural, one {# text frame is} other {# text frames are}} set in a font the document lacks and will show a substitute",
  textNonuniformScale:
    "{count, plural, one {# text frame was} other {# text frames were}} placed under an uneven scale; the type is scaled evenly",
  maskTooDeep:
    "{count, plural, one {# nested soft mask was} other {# nested soft masks were}} left out",
  maskBackdrop:
    "{count, plural, one {# soft mask's backdrop colour was} other {# soft masks' backdrop colours were}} not carried",
  maskTransfer:
    "{count, plural, one {# soft mask's transfer function was} other {# soft masks' transfer functions were}} not carried",
  maskComplexDropped:
    "{count, plural, one {# soft mask of several objects was} other {# soft masks of several objects were}} left out; the masked artwork shows unmasked",
  maskTextTarget:
    "{count, plural, one {# masked text frame shows} other {# masked text frames show}} unmasked (a text frame cannot take an opacity mask)",
  maskPerItem:
    "{count, plural, one {# soft mask over several objects was} other {# soft masks over several objects were}} applied to each object on its own",
  maskNestedDropped:
    "{count, plural, one {# mask under another mask was} other {# masks under other masks were}} left out",
  imageStencilPattern:
    "{count, plural, one {# pattern-painted image mask was} other {# pattern-painted image masks were}} painted grey",
  imageUndecodable:
    "{count, plural, one {# image could not be decoded and was} other {# images could not be decoded and were}} left out",
  unknown: "{code}: {count, plural, one {# object} other {# objects}}",
  colours:
    "Colours arrive as RGB: CMYK, spot and Lab colours of the file were converted",
  aiPrivate:
    "Illustrator's own data is not read: live effects, symbols, appearance and editable type on a path arrive as the file's PDF part draws them",
  outlinedFonts: "Not in the document, so drawn as outlines: {fonts}",
});

const KEYS: Record<string, string> = {
  "shading.function_sampled": M.shadingFunctionSampled,
  "shading.mesh_sampled": M.shadingMeshSampled,
  "shading.focal_sampled": M.shadingFocalSampled,
  "shading.skewed_sampled": M.shadingSkewedSampled,
  "shading.degenerate": M.shadingDegenerate,
  "shading.no_extend": M.shadingNoExtend,
  "pattern.tiling_expanded": M.patternTilingExpanded,
  "pattern.tiling_flattened": M.patternTilingFlattened,
  "pattern.too_deep": M.patternTooDeep,
  "stroke.nonuniform": M.strokeNonuniform,
  "stroke.pattern": M.strokePattern,
  "stroke.gradient": M.strokeGradient,
  "stroke.hairline": M.strokeHairline,
  "stroke.dash_phase": M.strokeDashPhase,
  "gradient.nonuniform": M.gradientNonuniform,
  "text.invisible": M.textInvisible,
  "text.stroked": M.textStroked,
  "text.type3_as_paths": M.textType3AsPaths,
  "text.pattern_fill": M.textPatternFill,
  "text.unmatched_outlined": M.textUnmatchedOutlined,
  "text.rotated_outlined": M.textRotatedOutlined,
  "text.missing_font_outlined": M.textMissingFontOutlined,
  "text.missing_font": M.textMissingFont,
  "text.nonuniform_scale": M.textNonuniformScale,
  "mask.too_deep": M.maskTooDeep,
  "mask.backdrop": M.maskBackdrop,
  "mask.transfer": M.maskTransfer,
  "mask.complex_dropped": M.maskComplexDropped,
  "mask.text_target": M.maskTextTarget,
  "mask.per_item": M.maskPerItem,
  "mask.nested_dropped": M.maskNestedDropped,
  "image.stencil_pattern": M.imageStencilPattern,
  "image.undecodable": M.imageUndecodable,
};

/** One worded loss. */
export interface LossLine {
  /** The mapper's code, or `"colours"`, `"aiPrivate"`, `"outlinedFonts"`. */
  code: string;
  count: number;
  message: string;
}

/** The report of one placement: the mapper's losses worded, then the two
 *  facts every placement shares (colours arrive as RGB; an Illustrator
 *  file's own data is not read), then the fonts drawn as outlines. */
export function lossLines(
  losses: readonly LossIr[],
  info: PdfInfo,
  outlinedFonts: readonly string[] = [],
): LossLine[] {
  const out: LossLine[] = losses.map((l) => {
    const key = KEYS[l.code];
    return {
      code: l.code,
      count: l.count,
      message: key
        ? t(key, { count: l.count })
        : t(M.unknown, { code: l.code, count: l.count }),
    };
  });
  out.push({ code: "colours", count: 1, message: t(M.colours) });
  if (info.format === "ai" && info.ai?.has_private_data) {
    out.push({ code: "aiPrivate", count: 1, message: t(M.aiPrivate) });
  }
  if (outlinedFonts.length > 0) {
    out.push({
      code: "outlinedFonts",
      count: outlinedFonts.length,
      message: t(M.outlinedFonts, { fonts: outlinedFonts.join(", ") }),
    });
  }
  return out;
}

/** Every code the table words — for the spec that holds it to the
 *  mapper's list. */
export const WORDED_LOSS_CODES: readonly string[] = Object.keys(KEYS);
