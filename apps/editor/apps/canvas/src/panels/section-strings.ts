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

// The schema-driven options panels lay out their sections as tables of
// message keys (titles and labels); this turns a table into the words of
// the editor's locale when the panel renders.

import type { Strings } from "@paged-media/strings";

import type { FieldSpec, SectionSpec } from "./schema-sections";

type SubFields = FieldSpec["fields"];

/** A struct's or a list item's sub-fields, their labels translated. */
function subFieldsIn(strings: Strings, fields: SubFields): SubFields {
  return fields?.map((f) =>
    typeof f === "string" || f.label === undefined
      ? f
      : { ...f, label: strings.t(f.label) },
  );
}

/** `sections` with their titles and labels in `strings`' locale. */
export function sectionsIn(
  strings: Strings,
  sections: readonly SectionSpec[],
): SectionSpec[] {
  return sections.map((section) => ({
    ...section,
    title: strings.t(section.title),
    fields: section.fields.map((field) => ({
      ...field,
      label: strings.t(field.label),
      ...(field.fields && { fields: subFieldsIn(strings, field.fields) }),
      ...(field.items && {
        items: {
          ...field.items,
          ...(field.items.fields && {
            fields: subFieldsIn(strings, field.items.fields),
          }),
        },
      }),
    })),
  }));
}
