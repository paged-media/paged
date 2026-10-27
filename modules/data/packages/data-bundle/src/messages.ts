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

// The words paged.data shows (editor plan E10): its panels, commands, menu
// rows, template-field problems and the session's status line, with their
// English beside the keys and the German in ../locales/de.json, registered
// here (activate.ts imports this module, so it loads with the bundle).
//
// The guard (platform/shared/strings/scripts/guard.mjs) reads these objects
// statically and stops at the first `}` followed by `)`: a message that
// ends in "…{name})" is written as two joined literals.

import { defineMessages, defineTranslations } from "@paged-media/strings";

import de from "../locales/de.json" with { type: "json" };

/** Panel titles, runtime command titles, the importer. */
export const COMMANDS = defineMessages("data.commands", {
  sourcesPanel: "Data sources",
  bindingsPanel: "Bindings",
  datasetPanel: "Dataset preview",
  queryPanel: "Data query",
  templatesPanel: "Record templates",
  paginationPanel: "Record flow pagination",
  importerTitle: "Data source (JSON, Parquet)",
  importData: "Data sources…",
  defineBinding: "Bindings…",
  resolveBindings: "Refresh data from sources",
  lowerBinding: "Place bindings on the page",
  mergeRecords: "Merge records into the document",
  openDataset: "Dataset preview…",
  captureDataSet: "Capture the current values as a data set",
  applyDataSet: "Apply a data set…",
  editQuery: "Data query…",
  bindProperty: "Bind to data…",
});

/** The menu rows paged.data adds (menu.ts), keyed by the path segment the
 *  shell looks up (menuLabel): the paths themselves stay English, they are
 *  the menus' identities. */
export const MENU = defineMessages("menu", {
  "Insert data binding…": "Insert data binding…",
  "Data query…": "Data query…",
  "Refresh from sources": "Refresh from sources",
  "Place bindings on the page": "Place bindings on the page",
  "Merge records into the document": "Merge records into the document",
  "Capture current values as a data set":
    "Capture current values as a data set",
  "Apply a data set…": "Apply a data set…",
});

/** The command category of paged.data's commands (categoryLabel). */
export const CATEGORY = defineMessages("commandCategory", {
  Data: "Data",
});

/** The Bindings panel. */
export const BINDINGS = defineMessages("data.bindings", {
  kindVariable: "variable field",
  fieldVariable: "field (column name)",
  kindImage: "image",
  fieldImage: "field with the image path or URL",
  kindBarcode: "barcode / QR",
  fieldBarcode: "field to encode",
  kindTable: "table",
  fieldTable: "columns, comma-separated",
  kindVisibility: "show / hide",
  fieldVisibility: "field or expression (true = shown)",
  kindRule: "style rule",
  fieldRule: "condition, e.g. stock < 5",
  kindRecordFlow: "record flow (catalog)",
  fieldRecordFlow: "fields per record, comma-separated",
  ruleCharacter: "character style",
  ruleParagraph: "paragraph style",
  ruleCell: "cell style (table column)",
  syncLinked: "synced",
  syncStale: "stale",
  syncPinned: "pinned",
  syncOverridden: "overridden",
  syncError: "error",
  formatPlain: "as is",
  formatNumber: "number",
  formatCurrency: "currency",
  formatPercent: "percent",
  formatDate: "date",
  fitProportional: "Fit (proportional)",
  fitFill: "Fill (proportional, crop)",
  fitContent: "Fit content to frame",
  fitContentAware: "Content-aware",
  fitNone: "None (no fitting)",
  symbologyEan13: "EAN-13 (retail)",
  symbologyUpca: "UPC-A (retail)",
  symbologyCode128: "Code-128 (general 1D)",
  symbologyQr: "QR (2D)",
  allRowsOf: "All rows of {source}",
  queryOption: "Query {query}",
  draftNeeds: "pick a query and write an expression",
  refused: "refused",
  draftBind: "Bind",
  draftOf: "of",
  draftTo: "to",
  exprPlaceholder: "expression, e.g. MM(width) or tint",
  bind: "Bind",
  cancel: "Cancel",
  importFirst: "Import a data source first, in Data sources.",
  merged: "merged {records} record(s) onto {pages} page(s)",
  mergedOverset: " — {count} overset",
  mergeFailed: "merge failed: {reasons}",
  noColumns: `No columns to map — "{query}" returned no data. Refresh data and try again.`,
  noRecordsYet: "No records yet — refresh data first.",
  enterField: "enter the {field}",
  variableBound: "variable binding {id} — Lower places the field",
  selectRectangleImage: "select a rectangle to bind the image into",
  selectRectangleBarcode: "select a rectangle to bind the barcode into",
  imageBound: "image binding {id} → the selected rectangle ({fit}" + ")",
  barcodeBound:
    "barcode binding {id} → the selected rectangle ({symbology}" + ")",
  tableBound: "table binding {id} ({count} column(s)) — Lower places the table",
  selectVisibilityTarget: "select the frame, shape or group to show or hide",
  visibilityBound: "show/hide binding {id} → the selected {kind}",
  hiddenWhenTrue: " (hidden when true)",
  ruleNeedsStyle: "enter the name of the document style the rule applies",
  ruleNeedsTarget:
    "select a table cell, or put the text cursor in the story to style",
  ruleCellNeedsCell: "a cell style rule needs a selected table cell",
  ruleTextNeedsCaret:
    "a character or paragraph rule needs the text cursor in a story",
  conditionUnusable: "the condition is not usable: {error}",
  conditionNoParse: "it does not parse",
  ruleBoundColumn:
    "style rule {id}: when {field} → {style} on the selected column — Lower applies it",
  ruleBoundParagraphs:
    "style rule {id}: when {field} → {style} on the paragraph of each record that fires — Lower applies it",
  ruleBoundStory:
    "style rule {id}: when {field} → {style} on the story — Lower applies it",
  flowBound: "record flow {id} — Preview lists what it places",
  relink:
    "Re-link data: {sources} — the bindings came back from the document's labels, the data did not (import the file again in Data sources).",
  emptyStart: "Import a data source to start binding.",
  openSources: "Open Data sources",
  recordsFrom: "Records from",
  hideWhenTrue: "hide when true",
  styleTitle: "A style defined in this document",
  stylePlaceholder: "style name",
  noStylesTitle:
    "No styles of this kind were read from the document — type a style id",
  stylesTitle: "Read this document's styles for the chosen action",
  styles: "styles",
  scopeTitle: "Where in the story the style lands",
  scopeStory: "whole story, when any record fires",
  scopeParagraphs: "one paragraph per record, from the cursor",
  rulePreviewTitle: "Check the condition and list the records it fires on",
  preview: "Preview",
  groupByPlaceholder: "group by (optional)",
  fit: "fit:",
  symbology: "symbology:",
  addBinding: "Add binding",
  conditionDoesNotParse: "the condition does not parse",
  firesOn:
    "fires on {fired} of {total, plural, one {# record} other {# records}}",
  mergeTitle: "Merges the records picked under Records from",
  dataMerge: "Data Merge",
  mergeSingle: "Single record per page",
  mergeMultiple: "Multiple records per page",
  rowsFirst: "Rows first",
  columnsFirst: "Columns first",
  rowSpacing: "row spacing",
  columnSpacing: "column spacing",
  removeBlankLines: "remove blank lines",
  keepTemplateTitle:
    "Keep the template page and put the merged records on new pages after it",
  keepTemplate: "keep template",
  newDocumentTitle:
    "Copy this document, open the copy and merge into it, consuming the template (the current document is kept as it is)",
  noNewDocumentDoor:
    "this editor version cannot open a second document — merge into the current document instead",
  intoNewDocument: "into a new document",
  mergeRunTitle:
    "Merge every record through the <<field>> frames on this page (one document; a second merge replaces the first)",
  mergeRecords: "Merge records",
  refreshData: "Refresh data",
  whatChangedTitle: "Refresh, then show what changed since the last sync",
  whatChanged: "What changed?",
  lower: "Lower to document",
  reresolveNote: "Bindings re-resolve when you refresh data.",
  refreshFields: "Refresh fields",
  previewRecord: "preview record:",
  previousTitle: "Show the document resolved against the previous record",
  previous: "‹ prev",
  nextTitle: "Show the document resolved against the next record",
  next: "next ›",
  jumpTo: "jump to:",
  mapFieldsTitle: "Map the source's columns to variable bindings",
  mapFields: "Map fields…",
  createBindings: "Create {count, plural, one {# binding} other {# bindings}}",
  manualExprTitle: "needs a manual expression",
  manualExpr: "manual expr needed",
  changedSinceSync:
    "changed since last sync: {changed} changed · {unchanged} unchanged",
  changedAdded: " · {count} added",
  changedRemoved: " · {count} removed",
  changeChanged: "changed",
  changeAdded: "added",
  changeRemoved: "removed",
  nothingChanged: "nothing changed — every bound region is up to date.",
  noQueryData: "no query has data yet — refresh first.",
  rowDiffBaseline: "{count} row(s) — nothing was written from this data yet",
  rowDiffSummary:
    "+{inserted} added · −{removed} removed · {updated} changed · {unchanged} unchanged",
  rowsMatchedBy: "rows matched by",
  wholeRow: "the whole row",
  automatic: "automatic",
  moreRows: "… more rows than listed",
  reaches: "reaches:",
  noBindingReads: "no binding reads what changed.",
  bindingsLabel: "bindings:",
  syncStatesTitle: "Show each binding's sync state",
  syncStates: "sync states",
  none: "none",
  syncStatusTitle:
    "Pinned and overridden content is never replaced by a refresh",
  pinTitle: "Keep this content as it is; refreshes leave it alone",
  pin: "Pin",
  unpinTitle: "Follow the source again from the next refresh",
  unpin: "Unpin",
  acceptTitle: "Replace this content with the source's value now",
  accept: "Accept source",
  formatTitle: "Number, currency or date pattern and locale for this field",
  format: "Format…",
  decimals: "decimals",
  symbolPlaceholder: "symbol (locale's)",
  datePlaceholder: "DD.MM.YYYY (locale's)",
  localeTitle: "Format this field for another locale than the session's",
  sessionLocale: "session locale ({locale}" + ")",
  apply: "Apply",
  flowRecords: "{id}: {total} record(s)",
  more: "… {count} more",
  flowNote: "Placing the flow into frames comes with merge.",
});

/** The Data sources panel. */
export const SOURCES = defineMessages("data.sources", {
  persistenceEmpty:
    "Sources and bindings you define are saved with the document.",
  persistencePending: "Saving the data definitions with the document…",
  persistenceSaved:
    "Sources, bindings and imported data are saved with the document.",
  persistenceUnavailable:
    "This editor cannot save data definitions with the document — reopening it needs a new import.",
  refresh: "refresh",
  policyManual: "manual",
  policyOnOpen: "on open",
  policyEvery: "every …",
  policyEverySecs: "every {secs} s",
  policyNever: "never (snapshot)",
  polling: "polling ({policy}" + ")",
  importFile: "Import file…",
  importFileLabel: "Import file",
  formats:
    "CSV, TSV, JSON, Parquet or Excel (.xlsx) — one worksheet per source.",
  noSources: "No sources yet.",
  sheet: "sheet {sheet}",
  remoteSources: "Remote sources",
  remoteNote: "Remote data loads only after you allow it.",
  addRemoteTitle:
    "Add this remote source (it loads only after you allow its origin)",
  addRemoteNeedsUrl: "Enter the source's URL first",
  addRemote: "Add remote",
  noRemote: "No remote sources. A remote source never fetches on open.",
  consented: "consented",
  consentRequired: "consent required",
  remoteInert: "inert",
  remoteLoaded: "loaded",
  remoteError: "error",
  key: "key",
  requestConsent: "Request consent",
  load: "Load",
  consentRefused:
    "Access to {origin} was not granted, so this source stays unloaded.",
  localFileNote:
    "A local file is read once at import; a browser page cannot watch it for changes. Import it again, or let it refresh on open. Remote sources can poll — only while their origin is allowed.",
  engineMissing: "The query engine isn't bundled in this build.",
  localCannotWatch:
    "a local file cannot be watched from the browser — import it again to update it, or refresh on open",
  intervalTooShort: "the interval must be at least {secs} seconds",
  notAUrl: "not a valid URL: {url}",
  urlNotHttp: "remote url must be http(s), got {protocol}//",
  urlCredentials:
    "remote url embeds credentials (user:pass@) — use a stored credential instead",
  urlNoHost: "remote url has no host",
  remoteInertMessage: "Inert — allow this origin before anything is fetched.",
});

/** The Data query panel. */
export const QUERY = defineMessages("data.query", {
  line: " (line {line}",
  lineColumn: " (line {line}, column {column}",
  source: "Source",
  noSources: "no sources",
  readColumns: "Read columns",
  columns: "{count} column(s):",
  builders: "Filter, sort, group",
  opContains: "contains",
  opStartsWith: "starts with",
  opIsEmpty: "is empty",
  opIsNotEmpty: "is not empty",
  value: "value",
  remove: "Remove",
  sortBy: "Sort by",
  ascending: "ascending",
  descending: "descending",
  groupBy: "Group by",
  rows: "(rows)",
  addTotal: "Add total",
  ungroup: "Ungroup",
  addFilter: "Add filter",
  addSort: "Add sort",
  groupByPick: "Group by…",
  writeSql: "Write SQL",
  readColumnsFirst: "Read the source's columns to build a query.",
  preview: "Preview",
  queryId: "Query id",
  saveQuery: "Save query",
  savedAs: "Saved as {id}.",
  nameFirst: "name the query first",
  rowsOf: "{shown} of {total} row(s)",
  queries: "Queries",
  noQueries: "No saved queries. Bindings read a query by its id.",
});

/** The Dataset preview panel. */
export const DATASET = defineMessages("data.dataset", {
  noFlowBinding:
    "no record-flow binding — define one in the Bindings panel first",
  providerShared: `Provider "{id}", revision {revision}, is shared with other plugins.`,
  providerReady: `Provider "{id}", revision {revision}, is ready; this editor can't share it with other plugins yet.`,
  nothingToExport: "nothing to export (no variables defined)",
  noPicker: "This host has no file picker.",
  locale: "Locale:",
  noQueriesNoSources: "No queries yet. Import a data source first.",
  noQueries:
    "No queries yet. Pick records in Bindings, or save a query in Data query.",
  openSources: "Open Data sources",
  openQuery: "Open Data query",
  query: "Query",
  previewTitle: "Refresh the data and show the query's first rows",
  previewRows: "Preview rows",
  publishProvider: "Publish provider",
  catalogColumns:
    "{count, plural, one {# column} other {# columns}} · {documented} documented",
  schemaNotes: " · {count, plural, one {# schema note} other {# schema notes}}",
  noRows: "The query returned no rows.",
  firstRows: "First {shown, plural, one {# row} other {# rows}}.",
  firstRowsOf: "First {shown} of {total, plural, one {# row} other {# rows}}.",
  splitOutput: "Split output:",
  perRecord: "Per record",
  perGroup: "Per group",
  oneCatalog: "One catalog",
  planSummary:
    "{units, plural, one {# output} other {# outputs}} from {records, plural, one {# record} other {# records}}",
  planBatchTitle:
    "Count the frames and records each output takes. No pages are made in this editor.",
  planBatchNeedsFlow: "Needs a record-flow binding — add one in Bindings.",
  planBatch: "Plan batch",
  planned:
    "Planned {count, plural, one {# output document} other {# output documents}}:",
  runDetail: " · {frames} frame(s) · {records} record(s)",
  more: "… {count} more",
  outputNote:
    "Output documents are produced by the batch automation tools, not inside this editor.",
  variables: "Variables:",
  refreshPalette: "Refresh palette",
  importLibrary: "Import library (XML)",
  exportLibrary: "Export library (XML)",
  noVariables:
    "No variables yet. A text, image or visibility binding IS a variable — define one in the Bindings panel, then capture a data set here.",
  graphData:
    "graph data — kept in the library, but not applied in this document",
  notBound: "not bound in this document — skipped on apply",
  setNameLabel: "data set name",
  defaultSetName: "Data Set 1",
  captureCurrent: "Capture current",
  captureEvery: "Capture every record",
  dataSet: "data set:",
  pickDataSet: "— pick a data set —",
  setsNote:
    "{count, plural, one {# set} other {# sets}} · switching is one undo step",
  cannotSave:
    "This host can't save files directly — copy the library below into a .xml file.",
  skipped: "skipped {name}: {reason}",
  serverBatch: "Server-side batch runs aren't available in this editor yet.",
});

/** The diagnostics list under every panel. */
export const DIAGNOSTICS = defineMessages("data.diagnostics", {
  clear: "Clear messages",
});

/** The Data overview (schema) panel. */
export const OBJECTS = defineMessages("data.objects", {
  title: "Data overview",
  intro:
    "Everything this document's data setup holds. Pick an item to see its settings; Open takes you to the panel where it is made.",
  openIn: "Open in {panel}",
  sources: "Sources",
  sourcesEmpty:
    "No sources yet. Import a file or add a remote source in Data sources.",
  queries: "Queries",
  queriesEmpty: "No saved queries. Build and save one in Data query.",
  bindings: "Bindings",
  bindingsEmpty:
    "Nothing on the page is bound yet. Bind a frame's text or image in Bindings.",
  dataSets: "Data sets",
  dataSetsEmpty:
    "No data sets. Capture the current values as one in Dataset preview.",
  variables: "Variables",
  variablesEmpty:
    "No variables yet. They appear once a source or a query defines them.",
});

/** Template field problems (a filler reads them in the form). */
export const TEMPLATE = defineMessages("data.template", {
  notPermitted:
    "this template does not let a filler change {target} ({permission}" + ")",
  fieldNeeds: `The field "{field}" has no {needs} in its definition.`,
  bindingUndefined: `The data binding "{binding}" is not defined.`,
  visibilityItemGone: `The item "{binding}" shows or hides is not here.`,
  notAField:
    "A {kind} binding is not a field: its value comes from its records.",
  objectGone: `The object "{binding}" writes is not in the document.`,
  notANumber: `"{value}" is not a number.`,
  lessThan: "{value} is less than {min}.",
  moreThan: "{value} is more than {max}.",
  notOnOff: `"{value}" is not on or off.`,
  notAChoice: `"{value}" is not one of the choices ({choices}` + ").",
  fillUndo: "Fill template field",
  notWritten: "The value could not be written: {reason}.",
  queryUndefined: `The query "{query}" is not defined.`,
  queryFailed: `The query "{query}" could not run: {problem}`,
  noRecords: `The query "{query}" has no records.`,
  notARecord: `"{value}" is not a record of "{query}" (1 to {count}` + ").",
  recordRefused: "Record {record} could not be shown: {reason}.",
  notADataSet: `"{name}" is not one of the data sets ({sets}` + ").",
  dataSetRefused: `The data set "{name}" could not be applied: {reason}.`,
  variableUndefined: `The variable "{name}" is not defined.`,
  variableUnbound: `The variable "{name}" is bound to nothing here.`,
  variableIsContent: `The variable "{name}" fills a text or a picture: open that frame as a text or image field.`,
});

/** The Record templates panel: the library of the cells a record flow
 *  repeats (record-templates.ts). */
export const RECORD_TEMPLATES = defineMessages("data.recordTemplates", {
  intro:
    "A record template is the cell a record flow repeats for every record: one line per field.",
  engineIdle:
    "The data engine starts with the first data source. Import one to make templates.",
  openSources: "Open Data sources",
  empty: "No record templates yet.",
  nameLabel: "Name",
  namePlaceholder: "Product card",
  fromSelection: "New from selection",
  fromSelectionTitle:
    "Make a template from the selected text frames: each line is one template line, <<field>> reads a field",
  howTo:
    "Write the lines in text frames as for Data Merge (Price: <<price>>), select them, then make the template.",
  needsName: "Give the template a name.",
  created: `Made "{name}" with {count} line(s).`,
  unreferenced: "Kept as text (not a field name): {names}",
  lines: "{count} line(s) · {height} pt per line",
  usedBy: "used by {flows}",
  unused: "not used",
  rename: "Rename",
  renameSave: "Save",
  renameCancel: "Cancel",
  delete: "Delete",
  confirmDelete: "Confirm delete",
  deleteInUse:
    "In use by a record flow: point the flow at another template first.",
  preview: "Preview",
  previewOf: `Preview of "{name}"`,
  previewQuery: "Records from",
  noQuery: "Save a query in Data query to preview with its records.",
  record: "Record",
  previous: "Previous record",
  next: "Next record",
  ofTotal: "of {total}",
  refreshData: "Refresh data",
});

/** The pagination inspector of a record flow. */
export const PAGINATION = defineMessages("data.pagination", {
  intro:
    "How a record flow breaks into pages: lowering places one frame per page in the start page's margin box.",
  engineIdle: "The data engine starts with the first data source.",
  noFlow:
    "No record flow yet. Define one in Bindings (Add binding ▸ record flow).",
  openBindings: "Open Bindings",
  flow: "Record flow",
  template: "Template",
  lineHeight: "Line height (pt)",
  lineHeightShared:
    "Changes the template for every flow using it ({count}" + ").",
  groupBy: "Group by",
  groupByPlaceholder: "field, field",
  groupByNote:
    "One section header per group; fields separated by commas, outermost first.",
  repeatHeader: "Repeat the group header on a new page",
  continuedMarker: "Mark a repeated header as continued",
  footer: "Group footer",
  footerLabel: "Footer text",
  footerLabelNote: "{count} in the text is the group's record count.",
  footerField: "Total of field",
  footerAgg: "As",
  aggSum: "sum",
  aggAvg: "average",
  aggMin: "minimum",
  aggMax: "maximum",
  summary: "Result",
  placed: "{placed} of {total} record(s) on {pages} page(s)",
  perPage: "Records per page: {counts}",
  frameHeight: "Frame height {height} pt (the start page's margin box)",
  continued: "{count} header(s) repeated as continued",
  overflow: "{count} record(s) did not fit.",
  tallRecord:
    "A record is {height} pt tall, more than a page's {frame} pt: it takes a page of its own and runs over.",
  needsData: "The flow's query has no records yet.",
  refreshData: "Refresh data",
  noPage: "There is no page to paginate over.",
});

/** Catalogues (ADR 560): a template's fields as binding targets, the
 *  template repeated per record or group. */
export const CATALOGUE = defineMessages("data.catalogue", {
  section: "Template fields",
  sectionTitle:
    "Bind the template's own fields to the data, then repeat the template once per record or group",
  noFields:
    "This document has no text, picture or visibility fields: make a template first.",
  field: "Field",
  expr: "Expression",
  bind: "Bind",
  unbind: "Unbind",
  invert: "Hide when true",
  perRecord: "One page per record",
  perGroup: "One page per group of",
  run: "Make catalogue",
  runTitle:
    "Copy the template's page once per record (or group) and fill its fields; a second run replaces the copies",
  bound: `Field "{field}" ← {expr}`,
  noSuchField: `The template has no field "{field}".`,
  notFillable: `The field "{field}" is a {kind} field: a catalogue fills text, picture and visibility fields.`,
  queryUndefined: `The query "{query}" is not defined.`,
  exprInvalid: `The expression does not work: {error}`,
  unknownColumns: "The query has no column {columns}.",
  noBindings: "No template field is bound to the data yet.",
  noFieldsOnPage: "None of the bound fields is on the template page {page}.",
  engineTooOld: "This data engine cannot plan a catalogue: rebuild it.",
  noPage: "The template page {page} is not in the document.",
  required: "a value is required",
  tooLong: "longer than {max} characters",
  error: "the expression gives {detail}",
  problem: `{label}, field "{field}": {problem}`,
  refused: "The catalogue was not made: {reason}.",
  done: "Catalogue: {instances} page(s) from {records} record(s).",
  emptied: "Catalogue: the query has no records; its copies were removed.",
  notMarked:
    "the template page is not marked as a catalogue yet: an author makes the catalogue once",
  missingFields: "{count} field(s) were not on a copy and stay as they are.",
});

/** The session's status line (every panel shows it). */
export const STATUS = defineMessages("data.status", {
  mergeCancelled: "Merge cancelled: the current document was kept.",
  remoteChanged: `Remote source "{name}" changed — data refreshed.`,
  notConsented:
    "Origin {origin} not consented — request consent first (no fetch performed).",
  remoteLoadedKey: "Loaded — content key {key}.",
  remoteLoaded: `Remote source "{name}" loaded.`,
  networkPolicy:
    " — the editor's network policy may not admit {origin}; consent alone does not open it",
  noSources: "No data sources yet — import a CSV to begin.",
  restoredFromLabels:
    "Restored {bindings} binding(s) from the document's labels — re-link {sources} data source(s).",
  restored:
    "Restored {bindings} binding(s) over {sources} source(s) from the document.",
  sourceRegistered: `Source "{name}" registered.`,
  importFailed: `Import of "{name}" failed: {error}`,
  imported: `Source "{name}" imported from {file}.`,
  importedSheet: `Source "{name}" imported from {file} (worksheet "{sheet}").`,
  captured: `Captured data set "{name}" (record {record}` + ").",
  capturedEvery: `Captured {count} data set(s) from "{query}".`,
  capturedTooLarge:
    " WARNING: the captured data sets take {bytes} of the {cap} bytes a document can store for them — delete data sets or capture fewer records.",
  appliedDataSet: `Applied data set "{name}": {applied} variable(s) in one undo step.`,
  appliedDataSetSkipped: `Applied data set "{name}": {applied} variable(s) in one undo step, {skipped} skipped.`,
  importedLibrary: `Imported "{name}": {variables} variable(s), {sets} data set(s).`,
  libraryUnbound: " Not bound in this document (will be skipped): {names}.",
  libraryGraphOnly:
    " Graph-data variables are carried but never applied: {names}.",
  refreshed: "Data refreshed from sources.",
  changeReport:
    "Change report: {changed} changed, {unchanged} unchanged{added}{removed}.",
  changeAdded: ", {count} added",
  changeRemoved: ", {count} removed",
  appliedProperty: `Applied "{id}": {applied} write(s) in {steps} undo step(s).`,
  recordFlowFrames: `Record flow "{id}": {frames} frame(s) on {pages} page(s).`,
  appliedRule: `Applied rule "{id}".`,
  loweredBarcode: `Resolved + lowered barcode "{id}".`,
  lowered: `Resolved + lowered "{id}".`,
  previewBarcode: `Preview: barcode "{id}" against record {record}.`,
  previewTable: `Preview: table "{id}" shows every record — nothing to step.`,
  preview: `Preview: "{id}" against record {record}.`,
  refreshedFields: "Refreshed {count} field(s) from the live data.",
  keptPinned: " Left {count} pinned/overridden binding(s) unchanged.",
  consent: "Network consent: {granted} granted, {denied} denied.",
  templateExport: "Data Merge template: {count} field(s).",
  templateExportSkipped:
    "Data Merge template: {count} field(s), {skipped} skipped.",
  mergeFailedWith: "Merge failed: {reason}",
  merged: "Merged {records} record(s) onto {pages} page(s).",
  mergedOverset:
    "Merged {records} record(s) onto {pages} page(s), {overset} overset.",
  mergeFailed: "Merge failed.",
  recordFlowRecords: `Record flow "{id}": {total} record(s).`,
  ruleUndo: `Rule "{scope}"`,
});

/** What may be wrong with the placed content (data ADR 564): the data door's
 *  `issues`, the Problems panel's rows. */
export const ISSUES = defineMessages("data.issues", {
  overset: `The text of "{binding}" does not fit its frame: enlarge the frame, shorten the text, or turn on Auto-Size in Text Frame Options.`,
  oversetRecord: `The text of "{binding}" for record {record} does not fit its frame: enlarge the frame, shorten the text, or turn on Auto-Size in Text Frame Options.`,
  oversetEstimated: `The text of "{binding}" does not fit its frame, as measured (an estimate: the host's layout could not tell): enlarge the frame, shorten the text, or turn on Auto-Size in Text Frame Options.`,
  oversetRecordEstimated: `The text of "{binding}" for record {record} does not fit its frame, as measured (an estimate: the host's layout could not tell): enlarge the frame, shorten the text, or turn on Auto-Size in Text Frame Options.`,
  oversetTable: `The table of "{binding}" does not fit its frame, or the text of one of its cells does not fit its row: enlarge the frame, shorten the text, or let the rows grow in Cell Options.`,
  missingAsset: `The picture of "{binding}" is missing: {reason}.`,
  noReference: "no reference in the data",
  lowResolution: `The picture of "{binding}" is {ppi} ppi at its size in the frame, under {min} ppi: use a larger picture or make the frame smaller.`,
  emptyValue: `"{binding}" shows an empty value: check the field in the data.`,
  failed: `"{binding}" failed: {reason}`,
  failedUnknown: `"{binding}" could not be resolved: check its expression and the data.`,
  unplaced: `{count} of {total} record(s) of "{binding}" were not placed: make the flow's frames larger or the records shorter.`,
});

defineTranslations("de", de);
