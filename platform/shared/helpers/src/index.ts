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

// The small helpers of the built-ins and the editor (docs/adr/PM-0002):
// one implementation each, where every module had its own. Internal; the
// extension contract's own copies (plugin-sdk's `parseLength`, its
// `data:` URI encoding) stay in the public SDK, which cannot import this.

export {
  crc32,
  fnv1a32,
  fnv1a32Hex,
  fnv1a32Utf16,
  hex,
  sha256Hex,
  sha256HexPrefix,
} from "./hash.ts";
export {
  decodePng,
  encodePng,
  zlibStored,
  type EncodePngOptions,
  type RgbaImage,
} from "./png.ts";
export {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  dataUrl,
  dataUrlBytes,
} from "./base64.ts";
export { PT_PER_PX, PT_PER_UNIT, PX_PER_PT, parseLength } from "./units.ts";
export {
  HARMONY_RULES,
  cmykToRgb,
  deltaE,
  harmonyOf,
  hexToRgb,
  hsbToRgb,
  hueDelta,
  labToRgb,
  linearToSrgb,
  rgbToCmyk,
  rgbToHex,
  rgbToHsb,
  rgbToHsl,
  rgbToLab,
  rotateHues,
  sameRgb,
  srgbToLinear,
  wrapHue,
  type HarmonyRule,
  type Hsb,
  type Lab,
  type LabWhite,
  type Rgb,
} from "./colour.ts";
export {
  LABEL_PREFIX,
  asciiEscape,
  asciiJson,
  decodeEnvelope,
  encodeEnvelope,
  labelKey,
  type LabelEnvelope,
} from "./label.ts";
export {
  DASH_PRESET_LENGTHS,
  MAX_DASH_PAIRS,
  dashArrayOp,
  dashLengthsFromPairs,
  dashPairsFromLengths,
  type DashPair,
} from "./dash.ts";
export {
  gradientSpecWithStop,
  type GradientRead,
  type GradientStopRead,
} from "./gradient-stop.ts";
export {
  applySampledStyle,
  sampledStyleFrom,
  type SampledEntry,
  type SampledStyle,
  type SampledTarget,
} from "./sampled-style.ts";
export {
  LIVE_CORNER_KINDS,
  cornerPresetOps,
  supportsLiveCornerKind,
  type CornerStyleToken,
} from "./corners.ts";
export {
  INDESIGN_GRAPHIC_PAINT,
  NORMAL_GRAPHICS_FRAME_STYLE,
  graphicPaintFromStyle,
  graphicPaintOps,
  resolveGraphicPaint,
  withGraphicPaint,
  type GraphicDocumentDefaults,
  type GraphicPaint,
  type GraphicStyleEntries,
} from "./graphic-default.ts";
export {
  IDENTITY,
  apply,
  compose,
  createTransformMemory,
  invert,
  linearChange,
  reflectMatrix,
  selectionCentre,
  transformBounds,
  transformMatrixOf,
  translate,
  type Affine,
  type Bounds,
  type Linear,
  type TransformMemory,
  type TransformRecord,
} from "./transform.ts";
export { escapeXmlAttr, escapeXmlText } from "./escape.ts";
export {
  deflateRaw,
  inflateRaw,
  unzip,
  zip,
  zipAsync,
  type ZipAsyncOptions,
  type ZipOptions,
} from "./zip.ts";
export {
  isApprovedScript,
  trustedHtml,
  trustedScript,
} from "./trusted-types.ts";
export { KAPPA } from "./geometry.ts";
export {
  ALIGNMENTS as TEXT_ALIGNMENTS,
  INDENT_STEP_PT,
  LINE_SPACINGS,
  TEXT_SIZES,
  TEXT_VERBS,
  alignmentOf,
  isBold,
  isItalic,
  leadingFor,
  lineSpacingOf,
  runTextVerb,
  stepFontSize,
  steppedIndent,
  toggledFontStyle,
  type Alignment as TextAlignment,
  type Read as TextRead,
  type TextDoor,
  type TextVerb,
  type TextVerbValue,
  type TextVerbWrite,
} from "./text-format.ts";
