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

// A minimal SCHEMA-PANEL RENDERER for the component tests: what the
// editor's renderer does with a property row, reduced to an input per row,
// so a test can mount the schema panel the bundle contributes and assert
// what the panel shows and what an edit in it writes.
//
// For every property row: resolve the row's targets the way the editor
// does (a selector is queried; `"selection"` scoped to a kind is
// `<selected element> > <kind>` for each selected element), read the path
// of the first target through `host.objects`, and render it — a checkbox
// for a boolean, a number input for a number, a text input for a string,
// read-only JSON for anything else. A change writes the value back through
// `host.objects.set` (one undo step); the refusal, if any, is shown. Every
// object change and selection change re-reads. The editor's own renderer
// (widgets, bindings, mixed values) is the editor's to test.

import type {
  BundleHost,
  ObjectValue,
  PanelSchemaPropertyRow,
  SchemaPanelContribution,
  SchemaPanelRenderer,
} from "@paged-media/plugin-api";
import {
  fromElementId,
  isPropertyRow,
  makeSchemaPanelComponent,
} from "@paged-media/plugin-sdk";
import * as React from "react";

type PropertyRow = PanelSchemaPropertyRow;

async function targetsOf(
  host: BundleHost,
  row: PropertyRow,
): Promise<string[]> {
  const { address, kind } = row;
  if (typeof address === "string" && address !== "selection")
    return host.objects.query(address).catch(() => []);
  if (address === "selection") {
    if (!kind) return [];
    const out: string[] = [];
    for (const id of host.selection.get()) {
      for (const hit of await host.objects
        .query(`${fromElementId(id)} > ${kind}`)
        .catch(() => [] as string[])) {
        if (!out.includes(hit)) out.push(hit);
      }
    }
    return out;
  }
  if (typeof address === "object" && "addresses" in address)
    return [...address.addresses];
  return [];
}

function Row({ host, row }: { host: BundleHost; row: PropertyRow }) {
  const [tick, setTick] = React.useState(0);
  const [target, setTarget] = React.useState<string | null>(null);
  const [value, setValue] = React.useState<ObjectValue | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [readOnly, setReadOnly] = React.useState(false);
  React.useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const a = host.objects.onDidChange(bump);
    const b = host.selection.onDidChange(bump);
    return () => {
      a.dispose();
      b.dispose();
    };
  }, [host]);
  React.useEffect(() => {
    let live = true;
    void (async () => {
      const [first] = await targetsOf(host, row);
      const v = first ? await host.objects.get(first, row.path) : null;
      const schema = first ? await host.objects.schema(first) : [];
      const access = schema.find((r) => r.path === row.path)?.access;
      if (!live) return;
      setReadOnly(access === "readOnly" || access === "derived");
      setTarget(first ?? null);
      setValue(v);
      setDraft(null);
    })();
    return () => {
      live = false;
    };
  }, [host, row, tick]);

  const write = async (next: unknown) => {
    if (!target) return;
    const r = await host.objects.set(target, row.path, next);
    setError(r.applied ? null : `${r.code ?? "refused"}: ${r.reason ?? ""}`);
  };
  const current = value?.kind === "value" ? value.value : undefined;
  const common = {
    "data-path": row.path,
    "data-target": target ?? "",
    "aria-label": row.label ?? row.path,
    ...(readOnly ? { "data-readonly": "" } : {}),
  };
  let field: React.ReactNode;
  if (!target || !value) field = <span {...common} data-empty />;
  else if (value.kind !== "value")
    field = <span {...common} data-state={value.kind} />;
  else if (readOnly)
    field = (
      <output {...common}>
        {typeof current === "string" || typeof current === "number"
          ? String(current)
          : JSON.stringify(current)}
      </output>
    );
  else if (typeof current === "boolean")
    field = (
      <input
        {...common}
        type="checkbox"
        checked={current}
        onChange={(e) => void write(e.target.checked)}
      />
    );
  else if (typeof current === "number" || typeof current === "string")
    field = (
      <input
        {...common}
        type={typeof current === "number" ? "number" : "text"}
        value={draft ?? String(current)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          void write(typeof current === "number" ? Number(draft) : draft);
        }}
      />
    );
  else
    field = (
      <output {...common} data-json>
        {JSON.stringify(current)}
      </output>
    );
  return (
    <div data-row={row.path}>
      {field}
      {error && <span data-error={row.path}>{error}</span>}
    </div>
  );
}

/** A renderer over `host` (the bundle's own host: its object model). */
export function testSchemaRenderer(host: BundleHost): SchemaPanelRenderer {
  return function TestSchemaRenderer({ schema }) {
    return (
      <div data-schema-panel={schema.id}>
        {schema.sections.map((section, i) => (
          <section key={i}>
            {section.rows.filter(isPropertyRow).map((row) => (
              <Row key={row.path} host={host} row={row} />
            ))}
          </section>
        ))}
      </div>
    );
  };
}

/** The component the SDK builds for `contribution` with this renderer:
 *  the path the host takes when it has a schema renderer. */
export function schemaPanelComponent(
  host: BundleHost,
  contribution: SchemaPanelContribution,
) {
  return makeSchemaPanelComponent(
    contribution,
    host.bindings,
    testSchemaRenderer(host),
  );
}
