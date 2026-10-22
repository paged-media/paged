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
