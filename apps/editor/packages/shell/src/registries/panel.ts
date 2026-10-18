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

import type * as Api from "@paged-media/plugin-api";

import type { Disposable, Registrable } from "./types";

/**
 * Lifecycle handle the substrate passes into a panel. Bundles never
 * read this directly — the substrate wraps it so panel code only
 * sees the high-level `paged` handle. The contract's `PanelApi`.
 */
export type PanelApi = Api.PanelApi;

/**
 * Props every panel component receives: the editor handle (`paged`,
 * resolved to `PagedEditor` in the editor module) and the substrate's
 * lifecycle (`api`). The contract's `PanelProps`.
 */
export type PanelProps = Api.PanelProps;

/**
 * Declarative panel manifest. Panels are data: a stable id, a title, a
 * React component, and placement / visibility metadata — the contract's
 * `PanelContribution` (one definition, `@paged-media/plugin-api`) plus
 * the one field only the editor's own panels set.
 *
 * `source` is the contract's too: provenance, the display name of the
 * owning bundle, which the SDK adapter STAMPS from the manifest when a
 * bundle registers (whatever the bundle passed is overwritten). The
 * editor's built-in panels leave it unset, and `PanelHost` renders them
 * as `host`.
 */
export interface PanelContribution extends Api.PanelContribution {
  /** E6 — a DEVELOPER surface: kept out of the Window menu.
   *
   *  The menu listed every registered panel, so an end user browsing it
   *  found the REPL, the script editor and two panels titled "Swatch
   *  list (schema)" and "Structure (schema tree)" — which exist to give
   *  the schema tiers a real consumer for their tests. Four developer
   *  tools in a designer's Window menu, indistinguishable from the
   *  ninety real ones.
   *
   *  It stays REGISTERED and openable — `__canvas.openPanel`, the
   *  command palette, and any test that wants it — because the panel is
   *  not the problem; offering it to a designer browsing for a workspace
   *  is. */
  devOnly?: boolean;
}

/** A contract-authored panel registers here unchanged. */
export type _PanelRegistrable = Registrable<
  PanelContribution,
  Api.PanelContribution
>;

export type PanelRegistryEvent =
  | { kind: "registered"; contribution: PanelContribution }
  | { kind: "unregistered"; id: string };

export interface PanelRegistry extends Api.PanelRegistry {
  register(contribution: PanelContribution): Disposable;
  unregister(id: string): void;
  get(id: string): PanelContribution | undefined;
  list(): PanelContribution[];
  onChange(handler: (event: PanelRegistryEvent) => void): Disposable;
}

/**
 * Default in-memory `PanelRegistry`. Insertion order is preserved so
 * the substrate can rely on a deterministic mount sequence.
 */
export function createPanelRegistry(): PanelRegistry {
  const byId = new Map<string, PanelContribution>();
  const listeners = new Set<(event: PanelRegistryEvent) => void>();

  function emit(event: PanelRegistryEvent) {
    for (const fn of listeners) fn(event);
  }

  return {
    register(contribution) {
      if (byId.has(contribution.id)) {
        throw new Error(
          `PanelRegistry: id "${contribution.id}" already registered`,
        );
      }
      byId.set(contribution.id, contribution);
      emit({ kind: "registered", contribution });
      return {
        dispose() {
          if (byId.delete(contribution.id)) {
            emit({ kind: "unregistered", id: contribution.id });
          }
        },
      };
    },
    unregister(id) {
      if (byId.delete(id)) {
        emit({ kind: "unregistered", id });
      }
    },
    get(id) {
      return byId.get(id);
    },
    list() {
      return Array.from(byId.values());
    },
    onChange(handler) {
      listeners.add(handler);
      return {
        dispose() {
          listeners.delete(handler);
        },
      };
    },
  };
}
