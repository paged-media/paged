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

// The document's data as the editor's own surfaces see it (extensions ADR
// 343; editor ADRs 291, 292): the Data panel and the bind popover read the
// service a bundle serves through `data@1` (paged.data), from the same
// shared backend every bundle host of this editor gets. The app points the
// editor's scope at that backend once (`setDataDoorSource`); React reads it
// through `useSyncExternalStore`, so a service coming or going, or a table
// changing, re-renders what shows it. Per editor: two editors on a page
// have two data doors.

import { useSyncExternalStore } from "react";

import type { DataChange, DataService } from "@paged-media/plugin-api";

import { scoped, useScoped, type EditorScope } from "./editor-scope";

/** What the app hands the shell: the shared data backend's three reads. */
export interface DataDoorSource {
  current(): { service: DataService } | null;
  onDidChange(listener: (change: DataChange) => void): { dispose(): void };
  onDidChangeService(listener: () => void): { dispose(): void };
}

/** The drag type of a Data panel field header (editor ADR 291, drag to
 *  place): its data is a {@link DataFieldDrag} as JSON. */
export const DATA_FIELD_DRAG_TYPE = "application/x-paged-data-field";

/** A field dragged out of the Data panel. */
export interface DataFieldDrag {
  query: string;
  field: string;
}

/** The drag type of a Data panel table tab: a {@link DataTableDrag} as
 *  JSON, placed as a table in the text frame it is dropped on. */
export const DATA_TABLE_DRAG_TYPE = "application/x-paged-data-table";

/** A query dragged out of the Data panel as a table: its shown fields, in
 *  the order the grid shows them. */
export interface DataTableDrag {
  query: string;
  fields: readonly string[];
}

/** The drag type of a Data panel grid row: a {@link DataRecordDrag} as
 *  JSON, filling the design (a group, a frame) it is dropped on. */
export const DATA_RECORD_DRAG_TYPE = "application/x-paged-data-record";

/** One record dragged out of the Data panel (0-based). */
export interface DataRecordDrag {
  query: string;
  record: number;
}

/** What was dropped on the document viewport. */
export type DataDrop =
  | ({ kind: "field" } & DataFieldDrag)
  | ({ kind: "table" } & DataTableDrag)
  | ({ kind: "record" } & DataRecordDrag);

/** What the app does with a field, a table or a record dropped on the
 *  document viewport. */
export type DataDropHandler = (
  drop: DataDrop,
  at: { clientX: number; clientY: number },
) => void;

/** The drag types the viewport takes, the most specific first. */
const DROP_TYPES = [
  DATA_RECORD_DRAG_TYPE,
  DATA_TABLE_DRAG_TYPE,
  DATA_FIELD_DRAG_TYPE,
] as const;

/** A drag's JSON as the drop it names, or null when it is malformed. */
function dropOf(type: string, data: string): DataDrop | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw.query !== "string") return null;
  const query = raw.query;
  if (type === DATA_FIELD_DRAG_TYPE)
    return typeof raw.field === "string"
      ? { kind: "field", query, field: raw.field }
      : null;
  if (type === DATA_TABLE_DRAG_TYPE)
    return Array.isArray(raw.fields) &&
      raw.fields.every((f) => typeof f === "string")
      ? { kind: "table", query, fields: raw.fields as string[] }
      : null;
  return Number.isInteger(raw.record) && (raw.record as number) >= 0
    ? { kind: "record", query, record: raw.record as number }
    : null;
}

interface DataDoorStore {
  source: DataDoorSource | null;
  drop: DataDropHandler | null;
  revision: number;
  listeners: Set<() => void>;
  unhook: (() => void) | null;
  subscribe(l: () => void): () => void;
}

const DATA_DOOR = scoped("dataDoor", (): DataDoorStore => {
  const store: DataDoorStore = {
    source: null,
    drop: null,
    revision: 0,
    listeners: new Set(),
    unhook: null,
    subscribe(l) {
      store.listeners.add(l);
      return () => store.listeners.delete(l);
    },
  };
  return store;
});

function notify(store: DataDoorStore) {
  store.revision++;
  for (const l of [...store.listeners]) l();
}

/** Point an editor's data surfaces at the shared backend (or at nothing). */
export function setDataDoorSource(
  scope: EditorScope,
  next: DataDoorSource | null,
): void {
  const store = scope.get(DATA_DOOR);
  store.unhook?.();
  store.unhook = null;
  store.source = next;
  if (next) {
    const a = next.onDidChange(() => notify(store));
    const b = next.onDidChangeService(() => notify(store));
    store.unhook = () => {
      a.dispose();
      b.dispose();
    };
  }
  notify(store);
}

/** The service serving the document's data now, or null. */
export function useDataService(): DataService | null {
  const store = useScoped(DATA_DOOR);
  return useSyncExternalStore(
    store.subscribe,
    () => store.source?.current()?.service ?? null,
    () => null,
  );
}

/** A number that moves whenever a table changes or the service does: a
 *  dependency for re-reading what the service answers. */
export function useDataRevision(): number {
  const store = useScoped(DATA_DOOR);
  return useSyncExternalStore(
    store.subscribe,
    () => store.revision,
    () => 0,
  );
}

/** Where a field, a table or a record dropped on the viewport goes: the app
 *  hit-tests the point and asks the data service to place it there. */
export function setDataDropHandler(
  scope: EditorScope,
  handler: DataDropHandler | null,
): void {
  scope.get(DATA_DOOR).drop = handler;
}

/** The viewport's side of drag to place: `accepts` says whether a drag
 *  carries a field, a table or a record this editor can place, `drop`
 *  places it (`get` reads the drag's data of a type, as
 *  `DataTransfer.getData`). Both read the handler when they run (an
 *  event), never during render. */
export function useDataDrop(): {
  accepts(types: readonly string[]): boolean;
  drop(
    get: (type: string) => string,
    types: readonly string[],
    at: { clientX: number; clientY: number },
  ): boolean;
} {
  const store = useScoped(DATA_DOOR);
  return {
    accepts: (types) =>
      !!store.drop && DROP_TYPES.some((t) => types.includes(t)),
    drop(get, types, at) {
      if (!store.drop) return false;
      const type = DROP_TYPES.find((t) => types.includes(t));
      const drop = type ? dropOf(type, get(type)) : null;
      if (!drop) return false;
      store.drop(drop, at);
      return true;
    },
  };
}
