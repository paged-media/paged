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

import type { Disposable } from "./types";

/**
 * Page geometry resolved into document-space rects, keyed by id.
 * Contributions iterate this when their visuals reference page
 * positions (caret, marquee, page captions). Each rect's origin is
 * the document-space top-left in points. The contract's
 * `OverlayPageRect`.
 */
export type OverlayPageRect = Api.OverlayPageRect;

/**
 * Props every overlay contribution receives: the editor handle
 * (`paged`, resolved to `PagedEditor` at the bind site), the camera at
 * the current frame (the client's `Camera` shape) and the page
 * rectangles in document space, in page-id order. Kept intentionally
 * thin — most overlays read their own data from shell contexts
 * (selection, hover, document, gesture state). The contract's
 * `OverlayProps`.
 */
export type OverlayProps = Api.OverlayProps;

/**
 * Declarative overlay manifest. Mirrors PanelContribution: a stable
 * id, a React render component, plus z-order + visibility metadata.
 * The contract's `OverlayContribution` as is (one definition,
 * `@paged-media/plugin-api`); the shell adds nothing.
 *
 * Each contribution renders into a shared SVG root the OverlayHost
 * provides — they should return SVG nodes (or a fragment of them).
 * Z-order (`z`, default 100) is the registry's only ordering hint; ties
 * break on insertion order. When `when` is false the host skips
 * mounting the component (its hooks don't run).
 */
export type OverlayContribution = Api.OverlayContribution;

export type OverlayRegistryEvent =
  | { kind: "registered"; contribution: OverlayContribution }
  | { kind: "unregistered"; id: string };

export interface OverlayRegistry extends Api.OverlayRegistry {
  register(contribution: OverlayContribution): Disposable;
  unregister(id: string): void;
  get(id: string): OverlayContribution | undefined;
  list(): OverlayContribution[];
  onChange(handler: (event: OverlayRegistryEvent) => void): Disposable;
}

/**
 * Default in-memory `OverlayRegistry`. Same insertion-order +
 * Disposable contract as `createPanelRegistry`.
 */
export function createOverlayRegistry(): OverlayRegistry {
  const byId = new Map<string, OverlayContribution>();
  const listeners = new Set<(event: OverlayRegistryEvent) => void>();

  function emit(event: OverlayRegistryEvent) {
    for (const fn of listeners) fn(event);
  }

  return {
    register(contribution) {
      if (byId.has(contribution.id)) {
        throw new Error(
          `OverlayRegistry: id "${contribution.id}" already registered`,
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
