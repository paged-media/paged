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

// The words paged.sheet shows (plan E10): panel and command titles, the
// workbook, grid, format and datasets panels, the grid's notices and the
// template fields' refusals. English beside the code; the German in
// ../locales/de.json, registered here so it loads with the bundle. Ids,
// function names, number-format codes, range syntax and the object model's
// schema stay as they are.

import { defineMessages, defineTranslations } from "@paged-media/strings";

import de from "../locales/de.json" with { type: "json" };

/** Panel titles and the palette category. */
export const PANELS = defineMessages("sheet.panel", {
  workbook: "Workbook",
  grid: "Grid",
  datasets: "Datasets",
  properties: "Sheet properties",
});

/** Command titles (palette). */
export const COMMANDS = defineMessages("sheet.command", {
  importXlsx: "Import workbook (.xlsx)",
  lowerToFrame: "Place selection on page",
  lowerChartToFrame: "Place chart on page",
  openGrid: "Open sheet grid",
  showGridInFrame: "Show grid in frame",
  hideGridInFrame: "Hide grid in frame",
  sortRange: "Sort range…",
  findReplace: "Find & replace…",
  sheetFromDataset: "Sheet from dataset",
  copySelection: "Copy sheet selection",
  pasteSelection: "Paste into sheet",
  styleFromCell: "New cell style from selection",
  paginateToChain: "Paginate into threaded frames",
  newWorkbook: "New blank workbook",
  insertRows: "Insert rows",
  deleteRows: "Delete rows",
  insertColumns: "Insert columns",
  deleteColumns: "Delete columns",
  addSheet: "Add sheet",
  fillDown: "Fill down",
  fillRight: "Fill right",
  clearCells: "Clear cells",
  cutSelection: "Cut sheet selection",
  formatCells: "Format cells…",
  pasteSpecial: "Paste special…",
  findInSheet: "Find in sheet…",
  findNext: "Find next in sheet",
  defaultStyleName: "Cell style",
});

/** The menu segments this bundle creates (its "Sheet" menu and the item
 *  labels; the host's own menus are the host's). Paths stay English, they
 *  are identities: the shell reads the label of each segment here. */
defineMessages("menu", {
  Sheet: "Sheet",
  "Insert spreadsheet…": "Insert spreadsheet…",
  "New blank workbook": "New blank workbook",
  "Add sheet": "Add sheet",
  "Open sheet grid": "Open sheet grid",
  "Show grid in frame": "Show grid in frame",
  "Hide grid in frame": "Hide grid in frame",
  "Place selection on page": "Place selection on page",
  "Place chart on page": "Place chart on page",
  "Paginate into threaded frames": "Paginate into threaded frames",
  "Insert rows": "Insert rows",
  "Delete rows": "Delete rows",
  "Insert columns": "Insert columns",
  "Delete columns": "Delete columns",
  "Sort range…": "Sort range…",
  "Find & replace…": "Find & replace…",
  "Copy cells": "Copy cells",
  "Paste into sheet": "Paste into sheet",
  "Style from cell": "Style from cell",
  "New sheet from dataset": "New sheet from dataset",
});

/** The palette category of this bundle's commands (an identity, labelled
 *  through the shell). */
defineMessages("commandCategory", {
  Sheet: "Sheet",
});

/** File ▸ Open and Export entries. */
export const FILES = defineMessages("sheet.files", {
  spreadsheet: "Spreadsheet",
  delimited: "Delimited text (CSV/TSV)",
  xlsx: "Workbook (.xlsx)",
});

/** The Sheet properties panel's sections. */
export const PROPERTIES = defineMessages("sheet.properties", {
  cell: "Cell",
  range: "Selected range",
  sheet: "Sheet",
  workbook: "Workbook",
  namedRange: "Named range",
  chart: "Chart",
});

/** Copy and paste answers (the grid's status line). */
export const NOTICES = defineMessages("sheet.notice", {
  copied:
    "Copied {rows} × {cols}: {cells, plural, one {# cell} other {# cells}}.",
  pasted:
    "Pasted {rows} × {cols}: {cells, plural, one {# cell} other {# cells}}.",
  cantCopy: "Can't copy: {reason}.",
  cantPaste: "Can't paste: {reason}.",
});

/** The grid panel. */
export const GRID = defineMessages("sheet.grid", {
  kicker: "Grid",
  bootError: "The spreadsheet engine could not start: {error}.",
  empty: "Open or create a workbook to edit it here.",
  newWorkbook: "New blank workbook",
  noMatch: "No match",
  matches: "{count, plural, one {# match} other {# matches}}.",
  replaced:
    "Replaced {occurrences, plural, one {# occurrence} other {# occurrences}} in {cells, plural, one {# cell} other {# cells}}.",
  replacedSkipped:
    "Replaced {occurrences, plural, one {# occurrence} other {# occurrences}} in {cells, plural, one {# cell} other {# cells}} ({skipped} skipped).",
  cantFill: "Can't fill: {reason}.",
  editNotSaved: "The cell edit was not saved.",
  formulaPlaceholder: "Select a cell to edit its formula",
  findPlaceholder: "Find in sheet",
  typeFirst: "Type something to find first",
  prevTitle: "Previous match (Shift+Enter)",
  prev: "Prev",
  nextTitle: "Next match (Enter)",
  next: "Next",
  findAllTitle: "List every match in this sheet",
  findAll: "Find all",
  replaceOptions: "Replace and options",
  replaceWith: "Replace with",
  replaceAllTitle: "Replace every match in this sheet",
  replaceAll: "Replace all",
  matchCase: "Match case",
  entireCell: "Entire cell",
  inFormulas: "In formulas",
  scrollUp: "Scroll up one row",
  scrollDown: "Scroll down one row",
  scrollLeft: "Scroll left one column",
  scrollRight: "Scroll right one column",
  copyTitle: "Copy the selected cells",
  copyFirst: "Select cells to copy first",
  copy: "Copy",
  pasteTitle: "Paste at the selected cell",
  pasteFirst: "Select a cell to paste at first",
  paste: "Paste",
  honesty:
    "Click a cell to select it and type to edit; the same grid edits inside a placed sheet frame.",
  about:
    "Drag or Shift+click to select a range. F2 edits the cell, Enter or Tab commits and moves, Delete clears. Drag the corner handle to fill. Double-click a placed sheet frame on the page to edit it there.",
});

/** The workbook panel. */
export const WORKBOOK = defineMessages("sheet.workbook", {
  kicker: "Workbook",
  placeFailed:
    "The range could not be placed. Check that it is a valid range like A1:D20.",
  paginated: "Paginated into the frame chain (live).",
  sorted: "Sorted.",
  valuesFirst: "Enter a values range (for example B2:C8) first.",
  chartCreated:
    "Chart created. Place it on the page from the list below; it is not saved into the .xlsx.",
  noClipboard: "Copying isn't available here; type {name}( in a cell.",
  fnCopied: "{name}() copied; paste it into a cell.",
  fnCopyFailed: "Couldn't copy {name}: {error}.",
  styleApplied:
    "Captured {count, plural, one {# property} other {# properties}}; style applied to the cell.",
  styleNotApplied:
    "Captured {count, plural, one {# property} other {# properties}}; {reason}.",
  styleCreatedOnly: "style created (not applied)",
  confirmDelete: "Confirm delete",
  confirmReplace: "Confirm replace",
  open: "Open .xlsx or .csv…",
  openAria: "Open a workbook",
  replacesWorkbook: "Replaces the open workbook; this can't be undone",
  newWorkbook: "New blank workbook",
  bootError: "The spreadsheet engine could not start: {error}.",
  empty: "Open a workbook or start a blank one to place a table on the page.",
  imported: "Imported",
  sheetKicker: "Sheet",
  activeSheet: "Active sheet",
  sheetAdded: "Sheet added.",
  addSheet: "Add sheet",
  newName: "New name",
  newNameAria: "New sheet name",
  typeNameFirst: "Type a new name first",
  sheetRenamed: "Sheet renamed.",
  rename: "Rename",
  oneSheetNeeded: "A workbook needs at least one sheet",
  deleteSheetTitle: "Delete this sheet; this can't be undone",
  sheetDeleted: "Sheet deleted.",
  deleteSheet: "Delete sheet",
  placeSection: "Place on page",
  range: "Range",
  placeTitle: "Place the range on the page as a table",
  rangeFirst: "Enter a range first",
  place: "Place on page",
  chainFirst: "Select a text frame of a threaded chain first",
  paginate: "Paginate into threaded frames",
  headerRowsTitle: "Rows repeated at the top of every frame of the chain",
  headerRows: "Header rows",
  structureSection: "Rows and columns",
  structureNote: "Acts on the rows or columns selected in the grid.",
  rowsInserted: "Rows inserted.",
  insertRows: "Insert rows",
  deleteRowsTitle: "Delete the selected rows; this can't be undone",
  rowsDeleted: "Rows deleted.",
  deleteRows: "Delete rows",
  colsInserted: "Columns inserted.",
  insertCols: "Insert columns",
  deleteColsTitle: "Delete the selected columns; this can't be undone",
  colsDeleted: "Columns deleted.",
  deleteCols: "Delete columns",
  formatSection: "Format and layout",
  namesSection: "Names",
  sortSection: "Sort range",
  keyColumn: "Key column",
  keyColumnTitle: "1 = the first column of the range",
  sortDirection: "Sort direction",
  ascending: "Ascending",
  descending: "Descending",
  hasHeader: "Has header row",
  sort: "Sort",
  stylesSection: "Cell styles",
  styleName: "Style name",
  newStyle: "New style from selected cell",
  styleNote:
    "Takes the fill and borders of the selected cell in a placed table.",
  chartsSection: "Charts",
  chartType: "Chart type",
  seriesInTitle: "Which axis of the values block is a series",
  seriesIn: "Series in",
  seriesInColumns: "Series in columns",
  seriesInRows: "Series in rows",
  valuesPlaceholder: "Values, e.g. B2:C8",
  valuesAria: "Values range",
  labelsPlaceholder: "Labels (optional)",
  labelsAria: "Labels range",
  titlePlaceholder: "Title (optional)",
  titleAria: "Chart title",
  createChart: "Create chart",
  untitledChart: "{kind} chart",
  chartSeries: "{count, plural, one {# series} other {# series}}",
  functionsSection: "Functions",
  filterFunctions: "Filter functions",
  fnArgs:
    "{name}: {count, plural, one {# argument} other {# arguments}}. Click to copy.",
  fnArgsOrMore: "{name}: {count} or more arguments. Click to copy.",
  fnArgsRange: "{name}: {min} to {max} arguments. Click to copy.",
  contentsSection: "Workbook contents",
  sheetN: "Sheet {n}",
  frozen:
    "{sheet}: frozen {rows, plural, one {# row} other {# rows}}, {cols, plural, one {# column} other {# columns}}",
  validations:
    "{sheet}: {count, plural, one {# data validation} other {# data validations}} ({kinds}; kept but not enforced)",
  comments:
    "{count, plural, one {# comment} other {# comments}} (read-only): {list}",
  commentAt: "{author} at {cell}",
  unknownAuthor: "Unknown",
  findPointer: "Find and replace are in the",
  gridPanel: "Grid panel",
  savedInDocument:
    "The workbook is saved inside the document and travels with the .paged file.",
  savedInBrowser:
    "The workbook is saved in this browser and restored on reload.",
  inMemory: "The workbook lives in memory only; open it again after a reload.",
});

/** The format & layout and names sections. */
export const FORMAT = defineMessages("sheet.format", {
  kicker: "Format",
  bold: "bold",
  italic: "italic",
  underline: "underline",
  fillSummary: "fill {color}",
  alignSummary: "align {align}",
  wrapSummary: "wrap",
  pointer:
    "Number format, font, fill, alignment and iterative calculation are in",
  properties: "Sheet properties",
  borderStyle: "Border style",
  borderColour: "Border colour",
  bordersRemoved: "Borders removed.",
  bordersApplied: "{edges} borders applied.",
  layout: "Layout",
  merged: "Merged.",
  merge: "Merge",
  unmerged: "Unmerged.",
  unmerge: "Unmerge",
  unfrozen: "Panes unfrozen.",
  frozen: "Panes frozen.",
  unfreeze: "Unfreeze",
  freeze: "Freeze panes",
  widthPlaceholder: "Width (ch)",
  widthAria: "Column width in characters",
  widthFirst: "Enter a width first",
  widthSet: "Column width set.",
  setWidth: "Set width",
  widthReset: "Column width reset.",
  default: "Default",
  heightPlaceholder: "Height (pt)",
  heightAria: "Row height in points",
  heightFirst: "Enter a height first",
  heightSet: "Row height set.",
  setHeight: "Set height",
  heightReset: "Row height reset.",
  numberFormat: "Number format",
  customCode: "Custom code",
  customCodeAria: "Custom number format code",
  numberFormatApplied: "Number format applied.",
  boldLabel: "Bold",
  boldToggled: "Bold toggled.",
  italicLabel: "Italic",
  italicToggled: "Italic toggled.",
  underlineLabel: "Underline",
  underlineToggled: "Underline toggled.",
  font: "Font",
  fontName: "Font name",
  fontSize: "Font size in points",
  textColour: "Text colour",
  fontApplied: "Font applied.",
  fillColour: "Fill colour",
  fillApplied: "Fill applied.",
  fill: "Fill",
  fillCleared: "Fill cleared.",
  noFill: "No fill",
  hAlign: "Horizontal alignment",
  alignApplied: "Alignment applied.",
  vAlign: "Vertical alignment",
  vAlignApplied: "Vertical alignment applied.",
  wrapOn: "Wrap on.",
  wrapOff: "Wrap off.",
  wrap: "Wrap",
  iterativeOn: "Iterative calculation on.",
  iterativeOff: "Iterative calculation off.",
  iterative: "Iterative calculation (circular references converge)",
  presetGeneral: "General",
  presetInteger: "Integer (0)",
  presetDecimal: "Decimal (0.00)",
  presetThousands: "Thousands (#,##0)",
  presetThousands2: "Thousands, 2 dp",
  presetPercent: "Percent (0%)",
  presetPercent2: "Percent, 2 dp",
  presetScientific: "Scientific",
  presetDateIso: "Date (yyyy-mm-dd)",
  presetDateShort: "Date (d-mmm-yy)",
  presetTime: "Time (h:mm)",
  presetEuro: "Euro",
  presetText: "Text (@)",
});

/** The name manager. */
export const NAMES = defineMessages("sheet.names", {
  name: "Name",
  refersTo: "Refers to (range)",
  thisSheetOnly: "This sheet only",
  nameFirst: "Enter a name first",
  defined: "Name {name} defined.",
  define: "Define",
  thisSheet: " (this sheet)",
  placeTitle: "Place this range on the page",
  placed: "Placed {name} on the page.",
  notARange: "{name} does not name a range.",
  place: "Place",
  deleted: "Name {name} deleted.",
  delete: "Delete",
});

/** The datasets panel. */
export const DATASETS = defineMessages("sheet.datasets", {
  kicker: "Datasets",
  empty:
    "No datasets yet. Publish a query as a dataset in paged.data, and it appears here.",
  fields: "{count, plural, one {# field} other {# fields}}",
  fieldsNamed: "{count, plural, one {# field} other {# fields}}: {names}",
  updateAvailable: " · update available",
  inUse: " · in use",
  updateTitle: "Replace the sheet with the newer revision",
  replaceTitle:
    "Replaces the open workbook with this dataset; this can't be undone",
  startTitle: "Start a new workbook from this dataset",
  confirmReplace: "Confirm replace",
  update: "Update",
  use: "Use",
  honesty:
    "A sheet made from a dataset is a snapshot saved with the document; choose Update when a newer revision is available.",
});

/** Template field kinds and their refusals. */
export const TEMPLATE = defineMessages("sheet.template", {
  cell: "Sheet cell",
  range: "Sheet range",
  chartData: "Chart data",
  noDefinition: "The field “{name}” has no {needs} in its definition.",
  noWorkbook: "No workbook is open in this document.",
  noNamedRange: "The workbook has no range named “{ref}”.",
  notCells: "“{ref}” does not name a sheet's cells.",
  noSheet: "The workbook has no sheet named “{sheet}”.",
  notARange: "“{ref}” is not a range of the workbook.",
  // Split before the ")" that follows a parameter: the strings guard reads
  // these objects as text, and "}" then ")" would end the call for it.
  shownElsewhere:
    "{ref} is also shown in a table this template does not open ({address} needs {lacks}" +
    "); make that frame a sheet field too.",
  undoLabel: "Fill template field",
  noMetadata:
    "This template does not let a filler change the workbook: its document policy must grant document.metadata (the workbook's version is the document's label).",
  notChanged: "The workbook could not be changed: {reason}",
  notOneCell: "“{ref}” is not one cell.",
  notAChoice: "“{value}” is not one of the choices",
  notANumber: "“{value}” is not a number.",
  lessThan: "{value} is less than {min}.",
  moreThan: "{value} is more than {max}.",
  noFormula: "A formula cannot be entered into a template field.",
  holdsFormula: "{id} holds a formula; a template opens constant cells only.",
  notATable: "The value is not a table of rows.",
  rowWidth: "Row {row} has {count} values; the table has {width} columns.",
  atMost: "The table takes at most {max} rows; {count} were given.",
  atLeast: "The table needs at least {min} rows; {count} were given.",
  exactRows: "The table has {height} rows; {count} were given.",
  holdsFormulas: "{id} holds formulas; a template opens constant cells only.",
  chartRedraw:
    "The chart is placed on the page and redrawing it replaces its artwork, which this template does not allow",
});

/** Engine tokens shown as labels: border styles and edges, alignments,
 *  chart kinds and function families. A token without a message reads
 *  as itself, capitalised (`labelOf`). */
export const TOKENS = defineMessages("sheet.token", {
  thin: "Thin",
  medium: "Medium",
  thick: "Thick",
  dashed: "Dashed",
  dotted: "Dotted",
  double: "Double",
  hair: "Hair",
  general: "General",
  left: "Left",
  center: "Center",
  right: "Right",
  justify: "Justify",
  bottom: "Bottom",
  top: "Top",
  all: "All",
  outline: "Outline",
  none: "None",
  column: "Column",
  stackedColumn: "Stacked column",
  bar: "Bar",
  stackedBar: "Stacked bar",
  line: "Line",
  area: "Area",
  scatter: "Scatter",
  pie: "Pie",
  donut: "Donut",
  radar: "Radar",
  agg: "Aggregate",
  array: "Array",
  database: "Database",
  date: "Date and time",
  engineering: "Engineering",
  external: "External",
  fin: "Financial",
  info: "Information",
  lambda: "Lambda",
  logical: "Logical",
  lookup: "Lookup and reference",
  math: "Math and trigonometry",
  stat: "Statistical",
  text: "Text",
});

defineTranslations("de", de);
