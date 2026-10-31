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
 * Module views (extensions ADR 345, editor ADR 306): a bundle's work
 * surface that replaces the document canvas while it is shown (a slide
 * sorter). The registry holds the views and which one is shown; the
 * cockpit layout reads it and puts the view where the canvas was, keeping
 * the canvas mounted (hidden) behind it.
 */
export type ViewContribution = Api.ViewContribution;
export type ViewProps = Api.ViewProps;

export interface ViewRegistry extends Api.ViewRegistry {
  register(contribution: ViewContribution): Disposable;
  get(id: string): ViewContribution | undefined;
  list(): ViewContribution[];
}

export function createViewRegistry(): ViewRegistry {
  const byId = new Map<string, ViewContribution>();
  const listeners = new Set<() => void>();
  let active: string | null = null;
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  return {
    register(contribution) {
      if (byId.has(contribution.id)) {
        throw new Error(
          `ViewRegistry: a view "${contribution.id}" is already registered`,
        );
      }
      byId.set(contribution.id, contribution);
      emit();
      return {
        dispose() {
          if (byId.get(contribution.id) !== contribution) return;
          byId.delete(contribution.id);
          // A view that goes away gives the canvas back.
          if (active === contribution.id) active = null;
          emit();
        },
      };
    },
    show(id) {
      if (id !== null && !byId.has(id)) return false;
      if (active === id) return false;
      active = id;
      emit();
      return true;
    },
    active: () => active,
    get: (id) => byId.get(id),
    list: () => Array.from(byId.values()),
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
