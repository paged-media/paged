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

// The engine's capability catalog (`paged describe`, `describeCatalog()`,
// `introspect/catalog.json` in @paged-media/canvas-wasm) as the model reads it.
// Generated from the engine, so it never drifts; where it and the authoring
// guide disagree, the catalog wins.

/** The slice of the catalog this package reads. The full catalog carries
 *  more (operations, elements, path aliases); extra fields are ignored. */
export interface ApiCatalog {
  hostFunctions: ReadonlyArray<{
    name: string;
    params: string;
    returns: string;
    kind: string;
    summary: string;
  }>;
  idGrammar: ReadonlyArray<{ form: string; example: string; note: string }>;
  settablePaths: readonly string[];
  constraints: readonly string[];
  propertySchemas?: ReadonlyArray<{
    addressKind: string;
    path: string;
    type: unknown;
    nullable?: boolean;
    access?: string;
  }>;
}

/** The compact reference block that goes into the cached system prompt:
 *  every host function, the id grammar, the settable paths, the rules.
 *  Property schemas are left out (they are ~35k tokens); the model looks a
 *  path up with the `lookup_api` tool instead. */
export function renderCatalog(catalog: ApiCatalog): string {
  const fns = catalog.hostFunctions
    .map(
      (f) =>
        `- \`${f.name}${f.params}\` -> ${f.returns}  [${f.kind}] ${f.summary}`,
    )
    .join("\n");
  const ids = catalog.idGrammar
    .map((g) => `- \`${g.form}\`  e.g. \`${g.example}\` — ${g.note}`)
    .join("\n");
  const constraints = catalog.constraints.map((c) => `- ${c}`).join("\n");
  return [
    "## Host functions",
    fns,
    "",
    "## Address grammar",
    ids,
    "",
    `## Settable property paths (${catalog.settablePaths.length})`,
    catalog.settablePaths.join(", "),
    "",
    "## Constraints",
    constraints,
  ].join("\n");
}

const LOOKUP_LIMIT = 40;

/** Answer a `lookup_api` call: host functions whose name contains the
 *  query, and the property-schema rows (type, unit, enum members, access)
 *  of paths that contain it. Case-insensitive. */
export function lookupApi(catalog: ApiCatalog, query: string): string {
  const q = query.trim().toLowerCase();
  if (!q)
    return "Empty query. Pass part of a function name (insertTextFrame) or a property path (characterFontSize).";
  const fns = catalog.hostFunctions.filter((f) =>
    f.name.toLowerCase().includes(q),
  );
  const rows = (catalog.propertySchemas ?? []).filter((r) =>
    r.path.toLowerCase().includes(q),
  );
  const ids = catalog.idGrammar.filter((g) => g.form.toLowerCase().includes(q));
  if (fns.length + rows.length + ids.length === 0) {
    return `Nothing in the catalog matches "${query}". Check the spelling against the host functions and settable paths in the system prompt.`;
  }
  const out: string[] = [];
  for (const f of fns.slice(0, LOOKUP_LIMIT))
    out.push(
      `fn ${f.name}${f.params} -> ${f.returns} [${f.kind}] ${f.summary}`,
    );
  for (const r of rows.slice(0, LOOKUP_LIMIT)) {
    out.push(
      `path ${r.addressKind}.${r.path}: ${JSON.stringify(r.type)}${r.nullable ? " | null" : ""}${r.access && r.access !== "readWrite" ? ` [${r.access}]` : ""}`,
    );
  }
  for (const g of ids)
    out.push(`address ${g.form} e.g. ${g.example} — ${g.note}`);
  const total = fns.length + rows.length;
  if (total > 2 * LOOKUP_LIMIT)
    out.push(`(${total - 2 * LOOKUP_LIMIT}+ more matches; narrow the query)`);
  return out.join("\n");
}
