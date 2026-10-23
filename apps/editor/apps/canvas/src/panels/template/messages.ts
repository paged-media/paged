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

// The words of filling in a template (plan E4, phase 1): the form, a module
// field's control, and the engine's reasons a value does not fit.

import { defineMessages, type Strings } from "@paged-media/strings";

export const FORM = defineMessages("templateForm", {
  empty: "This document has no fields to fill in.",
  didNotApply: "The change did not apply.",
  noPicture: "No picture",
  replace: "Replace…",
  cannotFill: "This field cannot be filled in here yet.",
  overset: "The text does not fit its frame.",
  noModuleReads: "No module reads this field.",
  moduleNotLoaded: "The module this field belongs to is not loaded.",
  noModuleWrites: "No module writes this field.",
});

/** The engine's reasons a value does not fit its field (paged-canvas
 *  `lower_template_fields`), by the engine's own words. */
const PROBLEMS = defineMessages("templateProblem", {
  noSuchField: "No field has this name.",
  required: "This field is required.",
  tooLong: "The text is longer than the field allows.",
  variableUnaddressable: "The field's variable cannot be found.",
  noStory: "The field's frame holds no text.",
  itemGone: "The field's item is no longer in the document.",
  notYet: "This kind of field cannot be filled in yet.",
  wrongKind: "The value does not fit the field.",
  throughModule: "This field is filled in through its module.",
});

const ENGINE_WORDS: Readonly<Record<string, string>> = {
  "no field has this name": PROBLEMS.noSuchField,
  required: PROBLEMS.required,
  "longer than the field allows": PROBLEMS.tooLong,
  "the field's variable cannot be addressed": PROBLEMS.variableUnaddressable,
  "the field's frame holds no story": PROBLEMS.noStory,
  "the field's item is not in the document": PROBLEMS.itemGone,
  "this kind of field cannot be set yet": PROBLEMS.notYet,
  "the value does not fit the field's kind": PROBLEMS.wrongKind,
  "a module field is set through its module": PROBLEMS.throughModule,
};

/** An engine problem in the reader's words; a module's own sentence stays
 *  as the module wrote it. */
export function problemText(strings: Strings, problem: string): string {
  const key = ENGINE_WORDS[problem];
  return key ? strings.t(key) : problem;
}

/** The template's preflight findings (plan F3), by the engine's code. */
export const PREFLIGHT = defineMessages("templatePreflight", {
  heading: "Problems",
  none: "No problems: the template is ready to hand to a filler.",
  policyUnreadable: "A template label cannot be read.",
  fieldUnnamed: "A field has no name, so no form or data can address it.",
  fieldDuplicate:
    "Several fields are named “{field}”; a value would reach only one of them.",
  imageNotReplaceable:
    "“{field}” is a picture field on an item that holds no picture.",
  textHasNoStory: "“{field}” is a text field on an item that holds no text.",
  requiredHidden:
    "“{field}” is required but its item is hidden, so a filler cannot see it.",
  fieldOnParentPage:
    "“{field}” is on a parent page, where no filler reaches it.",
  linkMissing: "“{field}” shows a picture that is not in the package.",
  marker: "This field has a problem: {message}",
});

/** A finding in the reader's words: its code's message, else the engine's. */
export function findingText(
  strings: Strings,
  finding: { code: string; field?: string | null; message: string },
): string {
  const key = (PREFLIGHT as Readonly<Record<string, string>>)[finding.code];
  return key &&
    finding.code !== "heading" &&
    finding.code !== "none" &&
    finding.code !== "marker"
    ? strings.t(key, { field: finding.field ?? "" })
    : finding.message;
}

/** The Template panel (plan F1, F2). */
export const PANEL = defineMessages("templatePanel", {
  allowFormat: "Format the text",
  allowCrop: "Move and scale the picture in its frame",
  allowMove: "Move",
  allowResize: "Resize",
  allowRotate: "Rotate",
  allowDelete: "Delete",
  allowShowHide: "Show or hide",
  allowFill: "Change the fill",
  allowStroke: "Change the stroke",
  everywhereSelect: "Select any item",
  everywherePages: "Add and remove pages",
  everywhereAdd: "Add new items",
  lineAuthor: "You are authoring this template.",
  lineFiller: "You see the template as the person filling it in.",
  lineEditor: "Take up authoring to make fields and set what a filler may do.",
  previewAsFiller: "Preview as filler",
  backToAuthoring: "Back to authoring",
  authorTemplate: "Author template",
  stopAuthoring: "Stop authoring",
  needsName: "A field needs a name.",
  badDefinition: "The module definition is not JSON.",
  name: "Name",
  label: "Label",
  kind: "Kind",
  kindText: "Text",
  kindPicture: "Picture",
  kindVisibility: "Shown or hidden",
  kindModule: "Module content",
  longestText: "Longest text",
  moduleField: "Module field",
  definition: "Definition (JSON)",
  group: "Group",
  help: "Help",
  required: "Required",
  fillerMayAlso: "A filler may also",
  saveField: "Save field",
  makeField: "Make field",
  removeField: "Remove field",
  everywhere: "Everywhere, a filler may",
  fields: "Fields",
  noFields: "No fields yet. Select an item and make it a field.",
  selectedItem: "Selected item",
  field: "Field",
  selectOne: "Select one item to make it a field.",
  thisPage: "This page",
  pageCopies:
    "A filler may copy this page and remove its copies (the pages of a catalogue)",
});
