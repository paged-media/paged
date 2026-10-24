/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The words of the shell's catalogue fields (plan E10): a property field's
// badges, its "Bind to data…" menu and notice, list editing, the leaves'
// fallbacks and the reasons typed text is refused. Labels a schema or a
// contribution declares are its contributor's words, not these.

import { defineMessages } from "@paged-media/strings";

export const FIELD = defineMessages("shell.field", {
  boundToData: "Bound to data",
  typeInferred: "type inferred",
  bindToData: "Bind to data",
  bindToDataMenu: "Bind to data…",
  bindFailed: "The binding could not be made: {reason}",
  bindPending:
    "Property binding arrives with paged.data's universal binding. This is the request it will receive.",
  target: "Target",
  property: "Property",
  type: "Type",
  close: "Close",
});

/** The bind popover (editor ADR 292). */
export const BIND = defineMessages("shell.bind", {
  title: "Bind {property} to data",
  query: "Records",
  modeField: "Field",
  modeRules: "Rules",
  modeMap: "Map",
  modeExpression: "Expression",
  search: "Search fields",
  noFields: "No field matches",
  unreadable: "Not a bare name: give it an alias in the query",
  when: "When",
  then: "then",
  otherwise: "Otherwise",
  addRule: "Add a rule",
  removeRule: "Remove the rule",
  mapField: "Value of",
  addEntry: "Add a value",
  key: "Value",
  result: "Result",
  expressionHint: "An expression over the record's fields, e.g. MM(weight) * 2",
  compiled: "Expression",
  preview: "Record {n} of {count}",
  previous: "Previous record",
  next: "Next record",
  previewError: "Not a value: {error}",
  noData:
    "No data yet. Import a source and define a query in paged.data, then bind.",
  bind: "Bind",
  cancel: "Cancel",
  opEquals: "is",
  opNot: "is not",
  opLess: "is less than",
  opLessEq: "is at most",
  opMore: "is more than",
  opMoreEq: "is at least",
  opContains: "contains",
  opBlank: "is empty",
});

// `showMore` closes its bracket apart: the strings guard reads a "})"
// inside a message as the end of the call.
export const LIST = defineMessages("shell.list", {
  addItem: "Add an item",
  noItems: "No items",
  moveUp: "Move up",
  moveDown: "Move down",
  remove: "Remove",
  item: "Item",
  noEntries: "No entries",
  collapse: "Collapse: {label}",
  expand: "Expand: {label}",
  showMore: "Show {count} more ({shown} of {total}" + ")",
  none: "[None]",
  default: "[Default]",
  boundsTop: "T",
  boundsLeft: "L",
  boundsBottom: "B",
  boundsRight: "R",
});

// The strings guard reads double-quoted messages only, so these keep
// their escaped quotes.
// prettier-ignore
export const PARSE = defineMessages("shell.parse", {
  notBool: "\"{text}\" is not true or false",
  notNumber: "\"{text}\" is not a number",
  notWholeNumber: "\"{text}\" is not a whole number",
  notLength: "\"{text}\" is not a length",
  notOneOf: "\"{text}\" is not one of {members}",
  bounds: "bounds are four lengths: top, left, bottom, right",
  transform: "a transform is six numbers: a b c d tx ty",
  point: "a point is two lengths: x, y",
  notLengths: "\"{text}\" is not a list of lengths",
  notNumbers: "\"{text}\" is not a list of numbers",
  atMost: "at most {max} items",
  longerThan: "longer than {max} characters",
  emptyReference: "empty reference",
  notJson: "\"{text}\" is not JSON",
  below: "{value} is below {min}",
  above: "{value} is above {max}",
});
