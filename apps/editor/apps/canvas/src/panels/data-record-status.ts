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

// The Data panel's per-record status (editor ADR 291): a query's rows
// coloured new or changed since the document was written from it, the rows
// placed in the document marked, how many placed records are gone, and a
// double-click on a row that selects the page items showing that record.
// The service decides all of it (`recordStatus`, `placements`' `record`);
// this file only reads it.

import { useEffect, useState, type CSSProperties } from "react";

import type {
  DataBindingStatus,
  DataRecordStatus,
  DataService,
  DataTableInfo,
} from "@paged-media/plugin-api";
import { status } from "@paged-media/panel-kit";
import {
  elementOfPlacement,
  type useCanvasClient,
  type useSelection,
} from "@paged-media/shell";
import type { ElementId } from "@paged-media/client";
import { defineMessages } from "@paged-media/strings";

export const RM = defineMessages("app.dataPanel.records", {
  removed:
    "{count, plural, one {# placed record is gone from the data} other {# placed records are gone from the data}}",
  added: "new in the data since it was placed",
  changed: "changed in the data since it was placed",
  placed: "placed in the document",
  selectHint: "double-click to select where this record is placed",
});

/** Whether the grid numbers the records of `table` (a query, on a service
 *  that reports their status). */
export function numbersRecords(
  service: DataService,
  table: DataTableInfo,
): boolean {
  return table.kind === "query" && typeof service.recordStatus === "function";
}

/** The status of the records of `table`, read again when the data changes;
 *  null for a table whose records have none. */
export function useRecordStatus(
  service: DataService,
  table: DataTableInfo,
  revision: number,
): DataRecordStatus | null {
  const [st, setSt] = useState<DataRecordStatus | null>(null);
  const on = numbersRecords(service, table);
  const name = table.name;
  useEffect(() => {
    if (!on) return;
    let live = true;
    service.recordStatus!(name).then(
      (s) => live && setSt(s),
      () => live && setSt(null),
    );
    return () => {
      live = false;
    };
  }, [service, name, on, revision]);
  return on ? st : null;
}

export interface RecordCue {
  tone: "added" | "changed" | null;
  placed: boolean;
}

/** What a row shows for its record. */
export function recordCue(
  st: DataRecordStatus | null,
  record: number | null,
): RecordCue {
  if (!st || record === null) return { tone: null, placed: false };
  return {
    tone: st.added.includes(record)
      ? "added"
      : st.changed.includes(record)
        ? "changed"
        : null,
    placed: st.placed.includes(record),
  };
}

/** A row's colours: new in the approved green, changed in the review amber
 *  (a tint of each), placed with a bar in the info blue at its start. */
export function recordStyle(cue: RecordCue): CSSProperties {
  const tint =
    cue.tone === "added"
      ? status.ok
      : cue.tone === "changed"
        ? status.warn
        : null;
  return {
    ...(tint
      ? { background: `color-mix(in srgb, ${tint} 16%, transparent)` }
      : {}),
    boxShadow: cue.placed ? `inset 3px 0 0 ${status.info}` : undefined,
  };
}

/** A row's `data-*` attributes and title. */
export function recordAttrs(
  cue: RecordCue,
  t: (m: (typeof RM)[keyof typeof RM]) => string,
  hint?: string,
): Record<string, string | undefined> {
  const said = [
    hint ?? null,
    cue.tone === "added" ? t(RM.added) : null,
    cue.tone === "changed" ? t(RM.changed) : null,
    cue.placed ? `${t(RM.placed)} · ${t(RM.selectHint)}` : null,
  ].filter((x): x is string => x !== null);
  return {
    "data-record-status": cue.tone ?? undefined,
    "data-record-placed": cue.placed ? "" : undefined,
    title: said.length > 0 ? said.join(" · ") : undefined,
  };
}

/** What `selectRecord` acts through: the grid's hooks, handed over. */
export interface RecordSelectDeps {
  service: DataService;
  client: ReturnType<typeof useCanvasClient>;
  setElementSelection: ReturnType<typeof useSelection>["setElementSelection"];
  setElementGeometry: ReturnType<typeof useSelection>["setElementGeometry"];
}

/** Select the page items that show `record` of the query `table`: the
 *  placements naming that record, of a binding over the query or of the
 *  query's Data Merge (`merge-<query>`). Nothing happens when none is
 *  placed. Outside the component: the React Compiler does not compile a
 *  conditional inside a `try` (ADR 229). */
export async function selectRecord(
  {
    service,
    client,
    setElementSelection,
    setElementGeometry,
  }: RecordSelectDeps,
  statuses: readonly DataBindingStatus[],
  table: string,
  record: number,
): Promise<void> {
  if (typeof service.placements !== "function") return;
  const over = new Set(
    statuses.filter((b) => b.query === table).map((b) => b.id),
  );
  over.add(`merge-${table}`);
  try {
    const ids: ElementId[] = [];
    const seen = new Set<string>();
    for (const p of await service.placements()) {
      if (p.record !== record || !over.has(p.binding)) continue;
      const id = elementOfPlacement(p.address);
      if (!id || seen.has(p.address)) continue;
      seen.add(p.address);
      ids.push(id);
    }
    if (ids.length === 0) return;
    const applied = await client.setElementSelection(ids, "replace");
    setElementSelection(applied);
    setElementGeometry(await client.elementGeometry(applied));
  } catch {
    // A placement that vanished meanwhile: the selection stays as it was.
  }
}
