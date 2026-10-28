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

// The words paged.doc shows (editor plan E10): the outline panel, the Word
// properties panel, the object kinds, the template fields' refusals and the
// open/insert notices. English beside the code; the German in
// locales/de.json, registered here, which every entry point imports.
//
// What stays English: the manifest's titles and the engine's own
// diagnostics (the lowering's and save-back's sentences), which the engine
// writes.

import { defineMessages, defineTranslations } from "@paged-media/strings";

import de from "../locales/de.json" with { type: "json" };

export const OUTLINE = defineMessages("doc.outline", {
  title: "Document outline",
  insert: "Insert Word document…",
  insertTitle: "Pick a .docx and insert it into this document",
  noPicker:
    "This editor has no file picker. Open the .docx with File ▸ Open, or drop it on the canvas.",
  cannotRead: "{name} could not be read as a Word document.",
  error: "Error",
  warning: "Warning",
  note: "Note",
  showFewer: "Show fewer",
  showAllStyles: "Show all {count} styles",
  showAllDiagnostics: "Show all {count} diagnostics",
  live: "Your edits are written back into the .docx when you export it.",
  notCaptured:
    "Export writes the original .docx unchanged: this document's text was not captured.",
  cannotReadBack:
    "Export writes the original .docx unchanged: this editor cannot read edited text back.",
  empty: "Insert a Word document to see its outline, styles and diagnostics.",
  paragraphs: "{count, plural, one {# paragraph} other {# paragraphs}}",
  tables: "{count, plural, one {# table} other {# tables}}",
  images: "{count, plural, one {# image} other {# images}}",
  links: "{count, plural, one {# link} other {# links}}",
  selectFrameTitle: "Select the frame the document is placed in",
  selectFrame: "Select frame",
  outline: "Outline",
  noHeadings: "This document has no headings.",
  goTo: "Go to “{text}”",
  notOnPage:
    "“{text}” isn't on the page — the heading was edited, or it is in overset text.",
  table:
    "Table, {rows, plural, one {# row} other {# rows}} × {cols, plural, one {# column} other {# columns}}",
  showingFirst: "Showing the first {count} entries.",
  // A ")" right after a "}" ends a message object for the strings guard,
  // which reads these calls as text: the parentheses close in a second
  // literal.
  styles: "Styles ({styles}" + ") and swatches ({swatches}" + ")",
  noStyles: "No styles.",
  paragraphStyle: "Paragraph",
  characterStyle: "Character",
  basedOn: ", based on {name}",
  diagnostics: "Diagnostics ({count}" + ")",
  allCarried: "Everything in the document was carried over.",
  savingBack: "Saving back to Word",
  emptyHeading: "(empty heading)",
  pageLine:
    "{width} × {height} pt · {columns, plural, one {# column} other {# columns}}",
});

export const DOC = defineMessages("doc.bundle", {
  importer: "Word document (.docx)",
  propertiesTitle: "Word properties",
  sectionDocument: "Document",
  sectionMailMerge: "Mail merge",
  sectionBlock: "Block",
  sectionRun: "Run",
  kindDocument: "Word document",
  kindBlock: "Word block",
  kindRun: "Word run",
  kindMergeField: "Merge field",
  fillMergeFields: "Fill merge fields",
  cannotGrow:
    "This editor version cannot add pages as text grows: {refused} of {total} Word section(s) stay on one page, and text past it is overset. {reason}",
  cannotChangeColumns:
    "This editor version cannot change columns mid-page: each Word section that does opens a new page instead.",
  cannotApply: "This engine cannot apply {what}: {reason}",
});

/** The menu item this bundle adds: the path stays English (it is the
 *  item's identity) and the shell shows the segment through this message. */
/** Doc ADR 616 — the files paged.doc opens and writes. */
export const FILES = defineMessages("doc.files", {
  odtImporter: "OpenDocument text (.odt)",
  newFromTemplate:
    "A new document from the template {template}. You are not editing the template: saving writes a new Word document ({name}).",
});

export const MENU = defineMessages("menu", {
  "Insert Word document…": "Insert Word document…",
});

export const TEMPLATE = defineMessages("doc.template", {
  noDocument: "There is no Word document on the field's frame {frame}.",
  partsMissing: "The Word document's parts are missing from this file.",
  noBookmark: "The Word document has no bookmark named “{name}”.",
  occurrence: "The anchor's occurrence is a whole number from 0.",
  noParagraph:
    "The Word document has no paragraph number {n} in the style “{style}”.",
  noBlock: "The Word document has no block {index}.",
  headingLevel: "The anchor's heading level is a whole number from 1.",
  noHeading: "The Word document has no heading number {n} of level {level}.",
  noCell:
    "The Word document's block {index} is no table with a cell {cell} that has a paragraph {paragraph}.",
  noAnchor:
    "The field's anchor names no paragraph: give a bookmark, a style, a heading or a block.",
  deniedDocument:
    "The template does not permit {permission} on the document, which this field needs.",
  deniedTarget:
    "The template does not permit {permission} on {target}, which is outside this field.",
  refused: "the Word document refused the value",
  mustBeText: "{what} must be text.",
  oneParagraph: "{what} is one paragraph and cannot hold a line break.",
  paragraphText: "A paragraph's text",
  mergeFieldValue: "A merge field's value",
  item: "Item {n}",
  blockTextTitle: "Word paragraph text",
  anchorIsTable: "The field's anchor names a table, not a paragraph.",
  noMergeFieldName: "The field names no merge field.",
  noMergeField: "The Word document has no merge field named “{name}”.",
  mergeFieldTitle: "Word merge field",
  mergeFieldUnwritable:
    "No use of the merge field can be written: each sits in a paragraph a page or column break splits, or in a table poured as text.",
  fillMergeField: "Fill merge field",
  listItemsTitle: "Word list items",
  itemColumn: "Item",
  rowsOfText: "A list's items are rows of text.",
  keepOne: "A list keeps at least one item.",
  notListItem: "The field's anchor names a paragraph that is not a list item.",
});

/** Word inside paged (doc ADR 608): the Home group, the shortcuts' command
 *  titles and the status items. */
export const WORD = defineMessages("doc.word", {
  home: "Home",
  paragraphStyle: "Paragraph style",
  fontFamily: "Font",
  fontSize: "Font size (pt)",
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strikethrough: "Strikethrough",
  subscript: "Subscript",
  superscript: "Superscript",
  allCaps: "All caps",
  smallCaps: "Small caps",
  textColor: "Text colour",
  bullets: "Bullets",
  numbering: "Numbering",
  decreaseIndent: "Decrease indent",
  increaseIndent: "Increase indent",
  alignLeft: "Align left",
  center: "Center",
  alignRight: "Align right",
  justify: "Justify",
  lineSpacing: "Line spacing",
  single: "Single",
  oneAndHalf: "1.5 lines",
  double: "Double",
  growFont: "Increase font size",
  shrinkFont: "Decrease font size",
  clearCharacter: "Clear character formatting",
  clearParagraph: "Clear paragraph formatting",
  spaceBefore: "Space before: 12 pt or none",
  heading: "Heading {level}",
  normal: "Normal style",
  listLevelDown: "Demote list level",
  listLevelUp: "Promote list level",
  copyFormat: "Copy formatting",
  pasteFormat: "Paste formatting",
  mixed: "— mixed —",
  page: "Page {page} of {pages}",
  words: "{count, plural, one {# word} other {# words}}",
  wordsOf: "{selected} of {total, plural, one {# word} other {# words}}",
  zoom: "{percent} %",
  noStyle: "The document has no “{name}” style.",
  doubleUnderline: "Double underline",
  hidden: "Hidden text",
  highlight: "Text highlight colour",
  highlightColor: "Highlight colour",
  noColor: "No colour",
  shading: "Shading",
  shadingColor: "Shading colour",
  borders: "Borders",
  borderBottom: "Bottom border",
  borderBox: "Box border",
  borderNone: "No border",
  showHidden: "Show hidden text (¶)",
  restartNumbering: "Restart numbering",
  continueNumbering: "Continue numbering",
  multilevelList: "Multilevel list",
  stylesMenu: "Styles",
  styleUpdate: "Update style to match selection",
  styleModify: "Modify style…",
  styleNew: "New style from selection…",
  applyStyles: "Apply styles",
  // Doc ADRs 611 / 612 — the document structure.
  pageBreak: "Page break",
  sectionNextPage: "Section break (next page)",
  sectionOddPage: "Section break (odd page)",
  sectionEvenPage: "Section break (even page)",
  sectionContinuous: "Section break (continuous)",
  footnote: "Insert footnote",
  endnote: "Insert endnote",
  updateFields: "Update fields",
  toggleFieldCodes: "Toggle field codes",
  insertToc: "Table of contents",
  updateToc: "Update table",
  insertPageNumber: "Page number",
  insertPageCount: "Number of pages",
  insertDate: "Date",
  editHeader: "Edit header",
  editFooter: "Edit footer",
  closeHeaderFooter: "Close header and footer",
  differentFirstPage: "Different first page",
  differentOddEven: "Different odd & even pages",
  linkToPrevious: "Link to previous",
  references: "References",
  crossReference: "Cross-reference\u2026",
  field: "Field\u2026",
  bookmark: "Bookmark\u2026",
  indexEntry: "Mark index entry\u2026",
  pageSetup: "Page setup",
});

defineTranslations("de", de);
