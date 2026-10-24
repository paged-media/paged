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

/** What the app does with a field dropped on the document viewport. */
export type DataFieldDropHandler = (
  drag: DataFieldDrag,
  at: { clientX: number; clientY: number },
) => void;

interface DataDoorStore {
  source: DataDoorSource | null;
  drop: DataFieldDropHandler | null;
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

/** Where a field dropped on the viewport goes: the app hit-tests the point
 *  and asks the data service to place it there. */
export function setDataDropHandler(
  scope: EditorScope,
  handler: DataFieldDropHandler | null,
): void {
  scope.get(DATA_DOOR).drop = handler;
}

/** The viewport's side of drag to place: `accepts` says whether a drag
 *  carries a field this editor can place, `drop` places it. Both read the
 *  handler when they run (an event), never during render. */
export function useDataFieldDrop(): {
  accepts(types: readonly string[]): boolean;
  drop(data: string, at: { clientX: number; clientY: number }): boolean;
} {
  const store = useScoped(DATA_DOOR);
  return {
    accepts: (types) => !!store.drop && types.includes(DATA_FIELD_DRAG_TYPE),
    drop(data, at) {
      if (!store.drop) return false;
      let drag: Partial<DataFieldDrag>;
      try {
        drag = JSON.parse(data) as Partial<DataFieldDrag>;
      } catch {
        return false;
      }
      if (typeof drag.query !== "string" || typeof drag.field !== "string")
        return false;
      store.drop({ query: drag.query, field: drag.field }, at);
      return true;
    },
  };
}
