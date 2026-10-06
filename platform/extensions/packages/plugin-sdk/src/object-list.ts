/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// publishObjectList — feed a schema `list` row from the object model, so a
// panel can pick ONE object (a layer, a template variable, a placeholder)
// and edit it with property rows addressed `{ bind: <select> }`:
//
//   list row:      items { kind: "binding", bind: rows }, selectionBinding: select
//   property rows: { field: "property", address: { bind: select }, kind, path }
//
// The rows are `{ selfId: <address>, name, secondary? }`, re-read when the
// selection or the object model changes. The selection binding is kept
// valid: it falls back to the first row when its object is gone. Pure data
// over `host.objects` + `host.bindings`; no React.

import type { Address, BundleHost, Disposable, ElementId } from "@paged-media/plugin-api";

import { fromElementId } from "./object-address";

export interface ObjectListRow {
  selfId: Address;
  name: string;
  secondary?: string;
}

export interface PublishObjectListOptions {
  /** Binding the rows are published under (the list row's `items.bind`). */
  rows: string;
  /** Binding holding the chosen address (the list row's
   *  `selectionBinding`, the property rows' `{ bind }`). */
  select: string;
  /** The selector to list, from the selection's addresses; `null` = no
   *  list (empty rows). E.g. `(sel) => sel.length === 1 ? `${sel[0]} > plugin:x/layer` : null`. */
  selector(selection: readonly Address[]): string | null;
  /** Path read for the row label (default `name`; the address id else). */
  labelPath?: string;
  /** Path read for the secondary line. */
  secondaryPath?: string;
}

const text = (v: { kind: string; value?: unknown }): string | null =>
  v.kind === "value" && v.value !== null && v.value !== undefined ? String(v.value) : null;

/** Publish the list and keep it live. Dispose to stop. */
export function publishObjectList(host: BundleHost, opts: PublishObjectListOptions): Disposable & {
  /** Re-read now (resolves when published). */
  refresh(): Promise<void>;
} {
  let disposed = false;
  let generation = 0;
  const labelPath = opts.labelPath ?? "name";

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    const selection = host.selection.get().map((id: ElementId) => fromElementId(id));
    const selector = opts.selector(selection);
    let rows: ObjectListRow[] = [];
    if (selector) {
      const addresses = await host.objects.query(selector).catch(() => [] as Address[]);
      rows = await Promise.all(
        addresses.map(async (selfId) => {
          const name = text(await host.objects.get(selfId, labelPath).catch(() => ({ kind: "absent" })));
          const secondary = opts.secondaryPath
            ? text(await host.objects.get(selfId, opts.secondaryPath).catch(() => ({ kind: "absent" })))
            : null;
          return {
            selfId,
            name: name ?? selfId.slice(selfId.lastIndexOf("/") + 1),
            ...(secondary !== null ? { secondary } : {}),
          };
        }),
      );
    }
    if (disposed || mine !== generation) return;
    host.bindings.publish(opts.rows, rows);
    const chosen = host.bindings.get(opts.select);
    if (!rows.some((r) => r.selfId === chosen)) {
      if (rows[0]) host.bindings.publish(opts.select, rows[0].selfId);
      else host.bindings.delete(opts.select);
    }
  };

  const subs: Disposable[] = [
    host.selection.onDidChange(() => void refresh()),
    host.objects.onDidChange(() => void refresh()),
  ];
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      for (const s of subs) s.dispose();
    },
  };
}
