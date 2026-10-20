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

// R13 (UX audit F-22, editor ADR 254) — the words a select shows for an
// engine enum member. A schema-driven field lists every member of its
// row's enum; before this table a member with no panel-given label was
// shown as itself ("LeftAlign", "UserModifiedPath", "RoundedCorner",
// "StrokeStyle/$ID/Japanese Dots"). The wording follows InDesign's own
// menus (Paragraph ▸ Justification, Text Wrap ▸ Contour Options, Corner
// Options, Stroke ▸ Type, …) in the editor's sentence case. A member the
// table does not know falls back to `humaniseIdentifier`, so no field
// can show a camel-cased id again.

const ENUM_MEMBER_LABELS: Readonly<Record<string, string>> = {
  // Paragraph alignment, as Paragraph Style Options ▸ Indents and
  // Spacing words it (the same members serve tab and vertical alignment)
  LeftAlign: "Left",
  CenterAlign: "Center",
  RightAlign: "Right",
  LeftJustified: "Left justify",
  CenterJustified: "Center justify",
  RightJustified: "Right justify",
  FullyJustified: "Full justify",
  ToBindingSide: "Towards spine",
  AwayFromBindingSide: "Away from spine",
  TopAlign: "Top",
  BottomAlign: "Bottom",
  JustifyAlign: "Justify",
  // Stroke caps, joins, alignment
  ButtEndCap: "Butt cap",
  RoundEndCap: "Round cap",
  ProjectingEndCap: "Projecting cap",
  MiterEndJoin: "Miter join",
  RoundEndJoin: "Round join",
  BevelEndJoin: "Bevel join",
  CenterAlignment: "Align stroke to center",
  InsideAlignment: "Align stroke to inside",
  OutsideAlignment: "Align stroke to outside",
  // Arrowheads (InDesign's Start/End list)
  SimpleArrowHead: "Simple",
  SimpleWideArrowHead: "Simple - wide",
  TriangleArrowHead: "Triangle",
  TriangleWideArrowHead: "Triangle - wide",
  BarbedArrowHead: "Barbed",
  CurvedArrowHead: "Curved",
  CircleArrowHead: "Circle",
  CircleSolidArrowHead: "Circle solid",
  SquareArrowHead: "Square",
  SquareSolidArrowHead: "Square solid",
  BarArrowHead: "Bar",
  // Corner options
  RoundedCorner: "Rounded",
  InverseRoundedCorner: "Inverse rounded",
  InsetCorner: "Inset",
  BeveledCorner: "Bevel",
  FancyCorner: "Fancy",
  // Text wrap mode and contour
  BoundingBoxTextWrap: "Wrap around bounding box",
  Contour: "Wrap around object shape",
  JumpObjectTextWrap: "Jump object",
  NextColumnTextWrap: "Jump to next column",
  BoundingBox: "Bounding box",
  DetectEdges: "Detect edges",
  AlphaChannel: "Alpha channel",
  PhotoshopPath: "Photoshop path",
  GraphicFrame: "Graphic frame",
  SameAsClipping: "Same as clipping",
  UserModifiedPath: "User-modified path",
  // Frame fitting
  Proportionally: "Fit content proportionally",
  FillProportionally: "Fill frame proportionally",
  ContentToFrame: "Fit content to frame",
  CenterContent: "Center content",
  FrameToContent: "Fit frame to content",
  // Auto-size
  HeightOnly: "Height only",
  WidthOnly: "Width only",
  HeightAndWidth: "Height and width",
  HeightAndWidthProportionally: "Height and width (keep proportions)",
  // First baseline offset
  AscentOffset: "Ascent",
  CapHeight: "Cap height",
  XHeight: "x height",
  EmBoxHeight: "Em box height",
  LeadingOffset: "Leading",
  FixedHeight: "Fixed",
  // Reference point
  TopLeftAnchor: "Top left",
  TopCenterAnchor: "Top center",
  TopRightAnchor: "Top right",
  LeftCenterAnchor: "Left center",
  CenterAnchor: "Center",
  RightCenterAnchor: "Right center",
  BottomLeftAnchor: "Bottom left",
  BottomCenterAnchor: "Bottom center",
  BottomRightAnchor: "Bottom right",
  // Effects
  ColorDodge: "Color dodge",
  ColorBurn: "Color burn",
  SoftLight: "Soft light",
  HardLight: "Hard light",
  EdgeSourced: "Edge",
  CenterSourced: "Center",
  OuterBevel: "Outer bevel",
  InnerBevel: "Inner bevel",
  PillowEmboss: "Pillow emboss",
  SmoothContour: "Smooth",
  ChiselHard: "Chisel hard",
  ChiselSoft: "Chisel soft",
  // Keep options: start paragraph
  NextColumn: "In next column",
  NextFrame: "In next frame",
  NextPage: "On next page",
  NextOddPage: "On next odd page",
  NextEvenPage: "On next even page",
  // Anchored objects
  InlinePosition: "Inline",
  AboveLine: "Above line",
  // Case and position
  AllCaps: "All caps",
  SmallCaps: "Small caps",
  CapToSmallCap: "Caps to small caps",
  OTSuperscript: "OpenType superscript",
  OTSubscript: "OpenType subscript",
  OTNumerator: "OpenType numerator",
  OTDenominator: "OpenType denominator",
  // Span columns
  SingleColumn: "Single column",
  SpanColumns: "Span columns",
  SplitColumns: "Split column",
  // Lists
  NoList: "None",
  BulletList: "Bullets",
  NumberedList: "Numbers",
  // Composers
  "HL Composer": "Paragraph composer",
  "HL Single": "Single-line composer",
  "Adobe Paragraph Composer": "Adobe Paragraph Composer",
  "Adobe Single-line Composer": "Adobe Single-line Composer",
  // Balance ragged lines
  NoBalancing: "No balancing",
  FullyBalanced: "Fully balanced",
  PyramidShape: "Pyramid",
  VeeShape: "Vee",
  // Numbering formats
  Arabic: "1, 2, 3, 4…",
  UpperRoman: "I, II, III, IV…",
  LowerRoman: "i, ii, iii, iv…",
  UpperLetters: "A, B, C, D…",
  LowerLetters: "a, b, c, d…",
  Asterisks: "*, **, ***…",
  ArabicAlifBaTah: "Arabic (alif, ba, tah)",
  ArabicAbjad: "Arabic (abjad)",
  HebrewBiblical: "Hebrew (biblical)",
  HebrewNonStandard: "Hebrew (non-standard)",
  SingleLeadingZeros: "01, 02, 03…",
  DoubleLeadingZeros: "001, 002, 003…",
  TripleLeadingZeros: "0001, 0002, 0003…",
  // Numbering restart
  DontRestart: "Continuous",
  PageRestart: "Every page",
  SpreadRestart: "Every spread",
  SectionRestart: "Every section",
  // Section prefix/suffix
  NoPrefixSuffix: "None",
  PrefixSuffixReference: "Prefix/suffix in reference",
  PrefixSuffixText: "Prefix/suffix in text",
  PrefixSuffixBoth: "Prefix/suffix in both",
  // Text variables
  CustomTextType: "Custom text",
  FileNameType: "File name",
  PageCountType: "Page count",
  CreationDateType: "Creation date",
  ModificationDateType: "Modification date",
  OutputDateType: "Output date",
  ChapterNumberType: "Chapter number",
  MatchParagraphStyleType: "Running header (paragraph style)",
  MatchCharacterStyleType: "Running header (character style)",
  LastPageNumberType: "Last page number",
  XrefPageNumberType: "Cross-reference page number",
  XrefChapterNumberType: "Cross-reference chapter number",
  // Table fills
  AlternatingRows: "Every other row",
  AlternatingColumns: "Every other column",
  // Colour management
  PreserveEmbedded: "Preserve embedded profiles",
  ConvertToWorking: "Convert to working space",
  RelativeColorimetric: "Relative colorimetric",
  AbsoluteColorimetric: "Absolute colorimetric",
  LAB: "Lab",
};

/**
 * Words for an identifier the engine uses as a value: an IDML reference
 * (`StrokeStyle/$ID/Japanese Dots` → "Japanese Dots"), a camel-cased
 * member (`UserModifiedPath` → "User modified path") or a word that is
 * already one ("Normal"). All-capital acronyms stay as they are (CMYK).
 */
export function humaniseIdentifier(id: string): string {
  // The last segment of an IDML reference; `$ID/` marks a built-in name.
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  if (tail.includes(" ") || /^[A-Z0-9]+$/.test(tail)) return tail;
  const words = tail
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean);
  if (words.length === 0) return id;
  return words
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1)
        : /^[A-Z0-9]+$/.test(w) && w.length > 1
          ? w
          : w.toLowerCase(),
    )
    .join(" ");
}

/** The words a select shows for one enum member (see the header). */
export function enumMemberLabel(member: string): string {
  return ENUM_MEMBER_LABELS[member] ?? humaniseIdentifier(member);
}
