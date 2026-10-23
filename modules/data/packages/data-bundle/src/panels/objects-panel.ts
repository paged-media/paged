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

// ADR 323 (object-model design §4 "Panels") — paged.data's OWN objects as a
// SCHEMA panel of property rows: the sources, queries, bindings, data sets
// and variables, each a list (publishObjectList over `host.objects`) with
// the picked item's properties below it. The host renders every row with
// its one schema-driven `PropertyField` over `host.objects` (the widget and
// read-only state come from the kind's manifest schema row; a commit goes
// through the kind's set / batch — the same session paths the panels use).
// The bundle declares fields, never widgets. The React panels (Sources,
// Bindings, Dataset preview, Query) stay: they own import, consent, the
// expression builder, preview and diagnostics; this panel is the property
// view of the same objects.

import type {
  BundleHost,
  Disposable,
  PanelSchema,
} from "@paged-media/plugin-api";
import { propertyRows, publishObjectList } from "@paged-media/plugin-sdk";
import { t } from "@paged-media/strings";

import { PANEL_FIELDS, PLUGIN_ID, type KindName } from "../object-model";
import type { DataSourceSession } from "../session";
import { COMMANDS, OBJECTS as M } from "../messages";

export const OBJECTS_PANEL_ID = "media.paged.data.panel.objects";

const qualified = (kind: KindName) => `plugin:${PLUGIN_ID}/${kind}`;

/** Published bindings the lists and their property rows share. */
export const BIND = {
  sources: "data.objects.sources",
  source: "data.objects.source",
  queries: "data.objects.queries",
  query: "data.objects.query",
  bindings: "data.objects.bindings",
  binding: "data.objects.binding",
  dataSets: "data.objects.dataSets",
  dataSet: "data.objects.dataSet",
  variables: "data.objects.variables",
  variable: "data.objects.variable",
} as const;

/** The panels that create and edit each kind — the overview's rows
 *  open them; it is an index, not a second editor. Titles are message
 *  keys. */
const PANEL = {
  sources: {
    id: "media.paged.data.panel.sources",
    title: COMMANDS.sourcesPanel,
  },
  query: { id: "media.paged.data.panel.query", title: COMMANDS.queryPanel },
  bindings: {
    id: "media.paged.data.panel.bindings",
    title: COMMANDS.bindingsPanel,
  },
  dataset: {
    id: "media.paged.data.panel.dataset",
    title: COMMANDS.datasetPanel,
  },
} as const;

/** One section per kind: an empty line naming where the kind is made,
 *  the list (each row opens its panel), then the picked item's rows.
 *  `title` and `empty` are message keys. */
const SECTIONS: ReadonlyArray<{
  kind: KindName;
  title: string;
  rows: string;
  select: string;
  labelPath?: string;
  secondaryPath?: string;
  panel: { id: string; title: string };
  empty: string;
}> = [
  {
    kind: "source",
    title: M.sources,
    rows: BIND.sources,
    select: BIND.source,
    secondaryPath: "type",
    panel: PANEL.sources,
    empty: M.sourcesEmpty,
  },
  {
    kind: "query",
    title: M.queries,
    rows: BIND.queries,
    select: BIND.query,
    secondaryPath: "shape",
    panel: PANEL.query,
    empty: M.queriesEmpty,
  },
  {
    kind: "binding",
    title: M.bindings,
    rows: BIND.bindings,
    select: BIND.binding,
    secondaryPath: "kind",
    panel: PANEL.bindings,
    empty: M.bindingsEmpty,
  },
  {
    kind: "dataSet",
    title: M.dataSets,
    rows: BIND.dataSets,
    select: BIND.dataSet,
    panel: PANEL.dataset,
    empty: M.dataSetsEmpty,
  },
  {
    kind: "variable",
    title: M.variables,
    rows: BIND.variables,
    select: BIND.variable,
    secondaryPath: "trait",
    panel: PANEL.dataset,
    empty: M.variablesEmpty,
  },
];

/** Published per list once it has been read: true when it has rows. Its
 *  empty line shows on the NEGATION, so an unpublished flag (before the
 *  first read — the host reads an unpublished gate as false) shows it. */
export const hasRowsBinding = (rows: string) => `${rows}.any`;

const paths = (kind: KindName) =>
  PANEL_FIELDS.filter((f) => f.kind === kind).map((f) => f.path);

const list = (
  rows: string,
  select: string,
  panel: { id: string; title: string },
) => ({
  widget: "paged.list",
  list: {
    items: { kind: "binding" as const, bind: rows },
    labelField: "name",
    secondaryField: "secondary",
    selectionBinding: select,
    // The host derives `paged.panel.show.<id>` for every registered panel.
    actions: [
      {
        label: t(M.openIn, { panel: t(panel.title) }),
        action: {
          kind: "command" as const,
          command: `paged.panel.show.${panel.id}`,
        },
      },
    ],
  },
});

/** The panel, from `PANEL_FIELDS` (every entry is a row of its kind), in
 *  the active locale's words (built when the bundle registers it). */
export const dataObjectsPanel = (): PanelSchema => ({
  id: OBJECTS_PANEL_ID,
  // "Data overview": every data object of the document in one place. It was
  // "Data objects", the one panel title a designer would not parse.
  title: t(M.title),
  icon: "panel-tree",
  defaultDock: "right",
  sections: [
    {
      rows: [
        {
          widget: "paged.label",
          props: {
            text: t(M.intro),
          },
        },
      ],
    },
    ...SECTIONS.map((s, i) => ({
      title: t(s.title),
      ...(i > 1 ? { collapsible: true } : {}),
      rows: [
        {
          widget: "paged.label",
          props: { text: t(s.empty) },
          visible: { bind: hasRowsBinding(s.rows), negate: true },
        },
        // The list shows once it has rows; until then the sentence above
        // says what "No entries" would, and where to start.
        {
          ...list(s.rows, s.select, s.panel),
          visible: { bind: hasRowsBinding(s.rows) },
        },
        ...propertyRows(qualified(s.kind), paths(s.kind), { bind: s.select }),
      ],
    })),
  ],
});

/** Keep the five lists live. The session's objects are session state the
 *  object registry does not announce, so a session change re-reads them
 *  too (coalesced: one re-read per burst). The lists read only a READY
 *  session: listing data sets or variables would boot the engine, and
 *  activation boots nothing; a restore or an undo reloading the session
 *  (status idle meanwhile) is never raced. They start with the first ready
 *  session, so activation pays no host calls for them (perf W7). */
export function publishObjectLists(
  host: BundleHost,
  session: DataSourceSession,
): Disposable {
  const ready = () => session.getState().status === "ready";
  let lists: ReturnType<typeof publishObjectList>[] | null = null;
  // The empty lines show while their list has not reported rows, so
  // activation publishes nothing (perf W7). Once the lists start, each
  // republished list carries its flag along.
  const publishEmpty = (rowsName: string) => {
    const rows = host.bindings.get(rowsName);
    host.bindings.publish(
      hasRowsBinding(rowsName),
      Array.isArray(rows) && rows.length > 0,
    );
  };
  const rowNames = new Set(SECTIONS.map((s) => s.rows));
  let emptySub: Disposable | null = null;
  const start = () =>
    SECTIONS.map((s) =>
      publishObjectList(host, {
        rows: s.rows,
        select: s.select,
        selector: () => (ready() ? qualified(s.kind) : null),
        ...(s.labelPath ? { labelPath: s.labelPath } : {}),
        ...(s.secondaryPath ? { secondaryPath: s.secondaryPath } : {}),
      }),
    );
  let pending: ReturnType<typeof setTimeout> | null = null;
  const sub = session.onDidChange(() => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (lists) for (const l of lists) void l.refresh();
      else if (ready()) {
        emptySub = host.bindings.onDidChange((name) => {
          if (rowNames.has(name)) publishEmpty(name);
        });
        lists = start(); // its first read is the refresh
      }
    }, 0);
  });
  return {
    dispose() {
      if (pending !== null) clearTimeout(pending);
      sub.dispose();
      emptySub?.dispose();
      for (const l of lists ?? []) l.dispose();
    },
  };
}
