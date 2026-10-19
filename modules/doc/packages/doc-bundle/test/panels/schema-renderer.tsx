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
// editor's renderer does with a schema panel, reduced to an input per
// property row and a list per list row, so a test can mount the schema
// panel the bundle contributes and assert what it shows and what an edit
// in it writes. (The same file is in the doc, slide and web bundles' tests;
// a module may not import another module's tests.)
//
// A PROPERTY ROW resolves its targets the way the editor does: a selector
// is queried; `"selection"` scoped to a kind is `<selected element> >
// <kind>` for each selected element; `{ bind }` is the address the bundle
// published under that name. It reads the path of the first target through
// `host.objects` and renders it: a checkbox for a boolean, a number input
// for a number, a text input for a string, JSON for anything else; a row
// the kind's schema declares `readOnly` or `derived` is a readout
// (`data-readonly`). A change writes back through `host.objects.set` (one
// undo step) and shows the refusal, if any.
//
// A `paged.list` ROW lists the rows published under `items.bind` (one
// button per row, `data-list-item` = its address) and a click publishes the
// row's address back under `selectionBinding`, as the editor's list does.
// Any other catalog widget renders its `props.text`, if any.
//
// Every object, selection and binding change re-reads. The editor's own
// renderer (widgets, "Bind to data…", mixed values) is the editor's to test.

import type {
  BindingsSurface,
  BundleHost,
  ObjectValue,
  PanelSchemaPropertyRow,
  PanelSchemaRow,
  SchemaPanelContribution,
  SchemaPanelRenderer,
} from "@paged-media/plugin-api";
import {
  fromElementId,
  isPropertyRow,
  makeSchemaPanelComponent,
} from "@paged-media/plugin-sdk";
import * as React from "react";

/** Re-render on every object, selection and binding change. */
function useTick(host: BundleHost, bindings: BindingsSurface): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const subs = [
      host.objects.onDidChange(bump),
      host.selection.onDidChange(bump),
      bindings.onDidChange(bump),
    ];
    return () => {
      for (const s of subs) s.dispose();
    };
  }, [host, bindings]);
  return tick;
}

async function targetsOf(
  host: BundleHost,
  bindings: BindingsSurface,
  row: PanelSchemaPropertyRow,
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
  if (typeof address === "object" && "bind" in address) {
    const v = bindings.get(address.bind);
    if (typeof v === "string") return [v];
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  }
  if (typeof address === "object" && "addresses" in address)
    return [...address.addresses];
  return [];
}

function PropertyRow({
  host,
  bindings,
  row,
}: {
  host: BundleHost;
  bindings: BindingsSurface;
  row: PanelSchemaPropertyRow;
}) {
  const tick = useTick(host, bindings);
  const [target, setTarget] = React.useState<string | null>(null);
  const [value, setValue] = React.useState<ObjectValue | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [readOnly, setReadOnly] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    void (async () => {
      const [first] = await targetsOf(host, bindings, row);
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
  }, [host, bindings, row, tick]);

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

interface ListSpec {
  items?: { kind?: string; bind?: string };
  labelField?: string;
  secondaryField?: string;
  selectionBinding?: string;
}

function ListRow({
  host,
  bindings,
  spec,
}: {
  host: BundleHost;
  bindings: BindingsSurface;
  spec: ListSpec;
}) {
  useTick(host, bindings);
  const bind = spec.items?.bind ?? "";
  const raw = bindings.get(bind);
  const rows = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : [];
  const selected = spec.selectionBinding
    ? bindings.get(spec.selectionBinding)
    : undefined;
  return (
    <ul data-list={bind}>
      {rows.map((r, i) => {
        const id = String(r.selfId ?? r.id ?? i);
        return (
          <li key={id}>
            <button
              type="button"
              data-list-item={id}
              aria-pressed={id === selected}
              onClick={() => {
                if (spec.selectionBinding)
                  bindings.publish(spec.selectionBinding, id);
              }}
            >
              {String(r[spec.labelField ?? "name"] ?? id)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Row({
  host,
  bindings,
  row,
}: {
  host: BundleHost;
  bindings: BindingsSurface;
  row: PanelSchemaRow;
}) {
  if (isPropertyRow(row))
    return <PropertyRow host={host} bindings={bindings} row={row} />;
  const widget = row as {
    widget?: string;
    list?: ListSpec;
    props?: { text?: unknown };
  };
  if (widget.widget === "paged.list" && widget.list)
    return <ListRow host={host} bindings={bindings} spec={widget.list} />;
  return (
    <div data-widget={widget.widget}>
      {typeof widget.props?.text === "string" ? widget.props.text : null}
    </div>
  );
}

/** A renderer over `host` (the bundle's own host: its object model). */
export function testSchemaRenderer(host: BundleHost): SchemaPanelRenderer {
  return function TestSchemaRenderer({ schema, bindings }) {
    return (
      <div data-schema-panel={schema.id}>
        {schema.sections.map((section, i) => (
          <section key={i} data-section={section.title ?? ""}>
            {section.rows.map((row, j) => (
              <Row key={j} host={host} bindings={bindings} row={row} />
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
