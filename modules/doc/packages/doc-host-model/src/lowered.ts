// paged.doc — the Lowered IR, mirrored on the TS side.
//
// This is the exact JSON shape `docx-lower` (Rust) serializes and `docx-js`
// hands across the wasm boundary (serde `rename_all = "camelCase"`). Keeping a
// local structural twin — rather than importing anything from the engine — keeps
// this package dependency-free apart from `@paged-media/plugin-api`.

/** A tab stop, shaped as the host `TabStopSpec` (position in points). */
export interface TabStopSpec {
  position: number;
  alignment?: string;
  alignmentCharacter?: string;
  leader?: string;
}

/** A wire `Value` (the union `docx-lower`'s `PropValue` serializes to). */
export type PropValue =
  | { type: "text"; value: string }
  | { type: "length"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "colorRef"; value: string }
  | { type: "tabStops"; value: TabStopSpec[] };

/** A single style-property assignment. */
export interface StyleProp {
  /** A `PropertyPath` wire string, e.g. `"characterFontStyle"`. */
  path: string;
  value: PropValue;
}

export type StyleCollection = "paragraph" | "character";

/** A native style to create + populate. */
export interface LoweredStyle {
  /** Full token, e.g. `ParagraphStyle/docx-Heading1`. */
  id: string;
  name: string;
  collection: StyleCollection;
  basedOn?: string | null;
  props: StyleProp[];
}

/** A color to mint via `createSwatch`. */
export interface LoweredSwatch {
  /** `Color/docx-RRGGBB`, or `Color/docx-theme-…` for a theme colour. */
  id: string;
  name: string;
  /** `"RGB"` this pass. */
  space: string;
  /** Channel values in `space` — `[r, g, b]` on 0–255. */
  value: number[];
  /** A theme colour's swatch (doc ADR 609): the Word theme colour and the
   *  colour it had at import. */
  theme?: {
    color: { slot: string; tint?: number; shade?: number };
    rgb: string;
  };
}

/** A colour group to mint via `createColorGroup` (the "Word theme" group). */
export interface LoweredColorGroup {
  id: string;
  name: string;
  members: string[];
}

export interface LoweredRun {
  text: string;
  charStyleId?: string | null;
  /** When the run is a hyperlink, its external target URL — the host-model emits
   *  an `insertHyperlink` over the run range so it becomes natively clickable.
   *  (The blue+underline look still rides on `charStyleId`.) Absent otherwise. */
  hyperlinkUrl?: string | null;
  /** When the run is (part of) a Word MERGEFIELD's result, the parsed field
   *  (`docx_core::MergeField`). The text pours as ordinary text; the bundle's
   *  object model addresses the field (`mergeField`). Absent otherwise. */
  mergeField?: LoweredMergeField | null;
  /** Doc ADR 612 — a Word field the engine keeps live: the run's text is
   *  (part of) its result; the runs of one field share `seq`. */
  field?: LoweredField | null;
  /** Doc ADR 611 — a footnote or endnote reference: the run's text is the
   *  engine's marker character, which `insertFootnote` / `insertEndnote`
   *  writes. */
  note?: LoweredNoteRef | null;
}

export interface LoweredField {
  /** The instruction (`PAGE \* roman`, `PAGEREF _Toc1 \h`). */
  code: string;
  /** Which field of its paragraph (0-based). */
  seq: number;
}

export interface LoweredNoteRef {
  id: number;
  endnote: boolean;
}

/** The engine's note reference markers (paged-model). */
export const FOOTNOTE_MARKER = "\u{E01C}";
export const ENDNOTE_MARKER = "\u{E01D}";

/** A Word `MERGEFIELD` (mail merge) as `docx-import` parsed it. */
export interface LoweredMergeField {
  /** The data-source column (`FirstName`, `First Name`). */
  name: string;
  /** The instruction as written (kept: save-back never rewrites it). */
  instruction: string;
  /** Ordinal among the paragraph's merge fields. */
  occurrence: number;
  /** `\b` / `\f` — text before / after a non-empty value. */
  before?: string | null;
  after?: string | null;
  /** `\m` mapped, `\v` vertical. */
  mapped?: boolean;
  vertical?: boolean;
  /** `\*` format switches, in order. */
  format?: string[];
}

export interface LoweredParagraph {
  paraStyleId?: string | null;
  runs: LoweredRun[];
  /** Inline images anchored to this paragraph (placed via insertAnchoredFrame). */
  images?: LoweredImage[];
  sourceIndex: number;
  /** ADR 028/029 — where a page/column break INSIDE the Word paragraph
   *  splits it: the pour starts a new native paragraph at each `at`, styled
   *  with the segment's style (it carries the break-before rule). Absent for
   *  an unsplit paragraph. */
  segments?: LoweredSegment[];
  /** The Word bookmarks that start in this paragraph, by name (what a
   *  template field anchors to). Absent when none. */
  bookmarks?: string[];
  /** The Word list this paragraph is an item of (`w:numId`) and its level.
   *  Absent when it is not a list item. */
  list?: LoweredListRef;
  /** Engine ADR 1050 — text boxes anchored in the paragraph that are not
   *  page items: anchored text frames with stories of their own. */
  textBoxes?: LoweredTextBox[];
}

/** Engine ADR 1050 — a float's layout among its story's text. */
export interface LoweredFloatLayout {
  wrap?: LoweredWrap;
  /** Word's `behindDoc`. */
  behind?: boolean;
  /** Word's `allowOverlap="0"`. */
  noOverlap?: boolean;
}

/** Engine ADR 1050 — a text box anchored in its paragraph. */
export interface LoweredTextBox {
  at?: number;
  widthPt: number;
  heightPt: number;
  /** Absent for an inline box (a character of its line). */
  anchor?: LoweredAnchor;
  layout?: LoweredFloatLayout;
  insetsPt: [number, number, number, number];
  paragraphs: LoweredParagraph[];
  fx?: NativeFx;
}

/** A list paragraph's list identity. */
export interface LoweredListRef {
  numId: number;
  level: number;
}

/** The second or later part of a Word paragraph split by a break. */
export interface LoweredSegment {
  /** Contiguous char offset into the paragraph's run text where it starts. */
  at: number;
  paraStyleId?: string | null;
}

/** An image lowered to an anchored-frame placement. */
export interface LoweredImage {
  /** Contiguous char offset into the paragraph's run text where the picture
   *  is addressed (where it sits in Word's paragraph; `docx-lower` decides
   *  it). Absent from an older IR: the paragraph's start. */
  at?: number;
  widthPt: number;
  heightPt: number;
  /** A self-contained `data:<mime>;base64,…` URI. */
  uri: string;
  /** ADR 035 — a FLOATING Word drawing's position and wrap, carried for the
   *  later lowering. It is still placed inline (with a diagnostic) until the
   *  engine can create a positioned, wrapped anchored object. Absent for an
   *  inline picture. */
  float?: LoweredFloat;
  /** Doc ADR 614 — a float placed as an anchored object: the engine's
   *  anchored-object settings, set on the frame `insertAnchoredFrame` makes. */
  anchor?: LoweredAnchor;
  /** Doc ADR 618 — the picture's DrawingML look as the shared mapper
   *  (`dml-native`) lowered it: fill, outline, opacity and effects, colours
   *  as `#RRGGBB`. Painted on the picture's anchored frame (doc ADR 619).
   *  Absent for a plain picture. */
  fx?: NativeFx;
  /** What the engine cannot hold of the look, one line per kind. */
  losses?: string[];
  /** Engine ADR 1050 — a float's wrap, z-order and overlap. */
  layout?: LoweredFloatLayout;
}

/** `dml_native::native::NativeFx` (doc ADR 618): the lowering kit's own
 *  type (plugin-sdk), colours `#RRGGBB`; lengths pt; opacities 0–100. */
import type { NativeFx } from "@paged-media/plugin-sdk";
export type { NativeFx };

/** A floating drawing's position and wrap, in points, Word's vocabulary. */
export interface LoweredFloat {
  horizontal?: LoweredFloatPosition;
  vertical?: LoweredFloatPosition;
  /** `wrapNone` / `wrapSquare` / `wrapTight` / `wrapThrough` / `wrapTopAndBottom`. */
  wrap: string;
  /** `bothSides` / `left` / `right` / `largest`. */
  wrapText?: string;
  distTopPt: number;
  distBottomPt: number;
  distLeftPt: number;
  distRightPt: number;
  behindDoc: boolean;
  allowOverlap: boolean;
  layoutInCell: boolean;
  locked: boolean;
  relativeHeight: number;
  /** `wp:simplePos` (x, y) from the page's top-left, when used. */
  simplePosPt?: [number, number];
  /** `wp:wrapPolygon`, in the drawing's own points. */
  wrapPolygonPt?: [number, number][];
}

/** One axis of a float's position. */
export interface LoweredFloatPosition {
  /** `page`, `margin`, `column`, `character`, `paragraph`, `line`, … */
  relativeFrom: string;
  offsetPt?: number;
  align?: string;
  /** `wp14:pctPos*Offset`, in percent. */
  percent?: number;
}

/** The body as a sequence of blocks (paragraphs + tables) in document order. */
export interface LoweredStory {
  blocks: LoweredBlock[];
}

export type LoweredBlock =
  | ({ kind: "paragraph" } & LoweredParagraph)
  | {
      kind: "table";
      rows: number;
      cols: number;
      columnWidthsPt: number[];
      cells: LoweredCell[];
      /** Non-empty: the table has a row taller than its page, which Word
       *  splits across pages and a native row never does. It pours as these
       *  paragraphs (its cells' text in reading order) instead of a table. */
      flow?: LoweredParagraph[];
    };

/** A native table to build via insertTable + per-cell insertText + setCellSpan. */
export interface LoweredTable {
  rows: number;
  cols: number;
  columnWidthsPt: number[];
  cells: LoweredCell[];
  /** Leading rows Word repeats on every page (`w:tblHeader`). */
  headerRows?: number;
  /** Each row's least height in points (`w:trHeight`), 0 where a row
   *  declares none; absent when no row does. */
  rowHeightsPt?: number[];
  /** See `LoweredBlock`'s table: the paragraphs it pours as when it cannot
   *  be a native table. */
  flow?: LoweredParagraph[];
  /** Doc ADR 614 — the table's own paragraph's style (Word's `w:jc`). */
  paraStyleId?: string | null;
  /** Doc ADR 614 — what the engine does not lay out yet, carried. */
  layout?: LoweredTableLayout;
}

/** One table cell, addressed by its resolved grid position. */
export interface LoweredCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  paragraphs: LoweredParagraph[];
  /** Native insets (top, left, bottom, right, pt) that give the cell Word's
   *  height and text width. */
  insetsPt?: [number, number, number, number];
  /** `TopAlign` / `CenterAlign` / `BottomAlign` (Word's `w:vAlign`). */
  vAlign?: string;
  /** Doc ADR 614 — Word's borders and shading on the cell's edges. */
  look?: LoweredCellLook;
  /** Engine ADR 1050 — tables nested in the cell, each on the empty cell
   *  paragraph `paragraph` that stands for it. */
  nested?: { paragraph: number; table: LoweredTable }[];
}

export interface LoweredSection {
  pageWidthPt: number;
  pageHeightPt: number;
  marginTopPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  marginRightPt: number;
  /** `w:cols/@w:num` — the section's own column count. */
  columns: number;
  /** The columns of the frame this section's story pours into, as the
   *  engine lays them out: equal columns `frameGutterPt` apart (Word's
   *  `w:cols/@w:space`; unequal widths are laid out equal, with a
   *  diagnostic). Embedded placement gives its frame these. Absent from
   *  older lowerings: one column. */
  frameColumns?: number;
  frameGutterPt?: number;
  /** ADR 029 — index into `story.blocks` of this section's first block. */
  firstBlock?: number;
  /** ADR 029 — the native story (skeleton page) this section pours into.
   *  Consecutive sections share one when Word continues the later section on
   *  the same page (continuous / nextColumn). Absent from older lowerings:
   *  every section is its own story. */
  story?: number;
  /** ADR 033 — the headers and footers this section shows (after Word's
   *  inheritance). Carried, not yet placed. */
  headerFooter?: LoweredHeaderFooter;
  /** ADR 034 — the section's own footnote numbering (Word reads nothing
   *  else). Absent: Word's defaults. */
  footnoteNumbering?: LoweredNoteNumbering;
  endnoteNumbering?: LoweredNoteNumbering;
  /** Doc ADR 611 — the masters this section's story's pages take. */
  masters?: LoweredSectionMasters;
  /** Doc ADR 611 — the grow rule's section start (`oddPage`/`evenPage`). */
  sectionStart?: "newPage" | "oddPage" | "evenPage";
}

export interface LoweredSectionMasters {
  master?: string;
  firstMaster?: string;
  evenMaster?: string;
}

/** Doc ADR 611 — a master the skeleton writes, with its header and footer
 *  frames' stories. */
export interface LoweredMaster {
  id: string;
  name: string;
  section: number;
  kind: "default" | "first" | "even";
  pageWidthPt: number;
  pageHeightPt: number;
  header?: LoweredMasterFrame;
  footer?: LoweredMasterFrame;
}

export interface LoweredMasterFrame {
  /** Index into `LoweredDoc.headerFooterParts`. */
  part: number;
  storyId: string;
  frameId: string;
  bounds: [number, number, number, number];
  bottomAligned?: boolean;
}

export interface LoweredHeaderFooterPart {
  part: string;
  footer: boolean;
  paragraphs: LoweredParagraph[];
}

/** Doc ADR 611 — a footnote or endnote. */
export interface LoweredNote {
  id: number;
  endnote: boolean;
  paragraphs: LoweredParagraph[];
  /** The text the engine's note holds (paragraphs joined by `\n`). */
  text: string;
}

/** Doc ADR 612 — a Word table of contents in the body. */
export interface LoweredToc {
  instruction: string;
  firstBlock: number;
  endBlock: number;
  levels: [number, number];
}

/** One section's headers and footers, by part name (`word/header1.xml`). */
export interface LoweredHeaderFooter {
  header: LoweredHeaderFooterParts;
  footer: LoweredHeaderFooterParts;
  titlePage: boolean;
  headerDistancePt?: number;
  footerDistancePt?: number;
  pageNumberStart?: number;
  pageNumberFormat?: string;
}

/** The part of each kind; absent is blank. */
export interface LoweredHeaderFooterParts {
  default?: string;
  first?: string;
  even?: string;
}

/** Footnote/endnote numbering, Word's vocabulary; absent fields are Word's defaults. */
export interface LoweredNoteNumbering {
  numFmt?: string;
  numStart?: number;
  /** `continuous` / `eachSect` / `eachPage`. */
  numRestart?: string;
  /** `pageBottom` / `beneathText` / `sectEnd` / `docEnd`. */
  pos?: string;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  tier: number;
}

/** The whole Tier-0 lowering of one Word document body. */
export interface LoweredDoc {
  swatches: LoweredSwatch[];
  styles: LoweredStyle[];
  story: LoweredStory;
  section: LoweredSection;
  /** ADR 029 — every section in order (standalone open pours each into its
   *  own story). Absent from older lowerings: treat as `[section]`. */
  sections?: LoweredSection[];
  /** ADR 033 — `w:evenAndOddHeaders`: even pages show the `even` pair. */
  evenAndOddHeaders?: boolean;
  diagnostics: Diagnostic[];
  /** Doc ADR 609 — colour groups to create after the swatches. */
  colorGroups?: LoweredColorGroup[];
  /** Doc ADR 609 — the theme's Latin heading and body faces. */
  themeFonts?: { major?: string; minor?: string };
  /** Doc ADR 611 — every header and footer part, lowered. */
  headerFooterParts?: LoweredHeaderFooterPart[];
  /** Doc ADR 611 — the masters the standalone skeleton writes. */
  masters?: LoweredMaster[];
  /** Doc ADR 611 — the notes referenced from the body. */
  notes?: LoweredNote[];
  /** Doc ADR 612 — the tables of contents in the body. */
  tocs?: LoweredToc[];
  /** Doc ADR 614 — floating pictures and text boxes placed as page items. */
  pageItems?: LoweredPageItem[];
}

/** Doc ADR 614 — a float's anchored-object settings, the engine's names. */
export interface LoweredAnchor {
  /** `Anchored` (custom) or `AbovePosition`. */
  position: string;
  anchorPoint: string;
  horizontalReference: string;
  horizontalAlignment: string;
  verticalReference: string;
  verticalAlignment: string;
  xOffsetPt: number;
  yOffsetPt: number;
}

/** Doc ADR 614 — one cell edge as the engine strokes it. */
export interface LoweredEdge {
  weightPt: number;
  /** A swatch token. */
  color: string;
}

/** Doc ADR 614 — a cell's edges and fill. */
export interface LoweredCellLook {
  top: LoweredEdge;
  left: LoweredEdge;
  bottom: LoweredEdge;
  right: LoweredEdge;
  fill?: string;
}

/** Doc ADR 614 — table layout Word asks for that the engine does not do. */
export interface LoweredTableLayout {
  fixed?: boolean;
  widthPt?: number;
  widthPct?: number;
  cellWidthsPt?: (number | null)[];
  indentPt?: number;
  cantSplit?: boolean[];
  exactRows?: boolean[];
}

/** Doc ADR 614 — a page item's text wrap (the engine's `TextWrap`). */
export interface LoweredWrap {
  mode: string;
  offsetsPt: [number, number, number, number];
  side?: string;
  contour?: string;
  polygonPt?: [number, number][];
}

/** Doc ADR 614 — a float or text box placed as a page item, written into
 *  the standalone skeleton; the bundle pours a text box's story. */
export interface LoweredPageItem {
  id: string;
  host: { kind: "page"; pageId: string } | { kind: "master"; masterId: string };
  bounds: [number, number, number, number];
  item:
    | { kind: "picture"; uri: string }
    | {
        kind: "textBox";
        storyId: string;
        paragraphs: LoweredParagraph[];
        insetsPt: [number, number, number, number];
      };
  wrap?: LoweredWrap;
  behind?: boolean;
  fx?: NativeFx;
  source: {
    part: string;
    ordinal?: number;
    vml?: boolean;
    editable?: boolean;
  };
}

/** Parse the JSON string `docx-js` produces into a typed [`LoweredDoc`]. */
export function parseLoweredDoc(json: string): LoweredDoc {
  return JSON.parse(json) as LoweredDoc;
}
