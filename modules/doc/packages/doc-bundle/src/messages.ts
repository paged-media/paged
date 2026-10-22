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

export const TEMPLATE = defineMessages("doc.template", {
  noDocument: "There is no Word document on the field's frame {frame}.",
  partsMissing: "The Word document's parts are missing from this file.",
  noBookmark: "The Word document has no bookmark named “{name}”.",
  occurrence: "The anchor's occurrence is a whole number from 0.",
  noParagraph:
    "The Word document has no paragraph number {n} in the style “{style}”.",
  noBlock: "The Word document has no block {index}.",
  noAnchor:
    "The field's anchor names no paragraph: give a bookmark, a style or a block.",
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
  mergeFieldInCell:
    "The merge field sits in a table cell, which cannot be written yet.",
  fillMergeField: "Fill merge field",
  listItemsTitle: "Word list items",
  itemColumn: "Item",
  rowsOfText: "A list's items are rows of text.",
  keepOne: "A list keeps at least one item.",
  notListItem: "The field's anchor names a paragraph that is not a list item.",
});

defineTranslations("de", de);
