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

/**
 * Sub-contexts (extensions ADR 349, C6; editor ADR 301): a header, footer
 * or note edited in place on a page. Bundles register PROVIDERS per edit
 * context; the canvas offers a page double-click to the providers of the
 * active context (or the document context) before its own handling, and
 * the first answer is shown. One sub-context is shown at a time.
 */
export type SubContextRegistry = Api.SubContextRegistry;
export type SubContextState = Api.SubContextState;
export type SubContextSpec = Api.SubContextSpec;

export function createSubContextRegistry(): SubContextRegistry {
  const providers: Array<{
    pluginId: string;
    contribution: Api.SubContextProviderContribution;
  }> = [];
  let shown: SubContextState | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  const enter = (pluginId: string, spec: SubContextSpec): boolean => {
    shown = { ...spec, pluginId };
    emit();
    return true;
  };
  return {
    register(pluginId, contribution) {
      const entry = { pluginId, contribution };
      providers.push(entry);
      return {
        dispose() {
          const i = providers.indexOf(entry);
          if (i >= 0) providers.splice(i, 1);
        },
      };
    },
    async resolve(hit) {
      const asked = providers.filter(
        (p) => p.contribution.editContext === hit.editContext,
      );
      for (const p of asked) {
        // A provider that throws answers nothing; the next one is asked.
        const spec = await Promise.resolve()
          .then(() => p.contribution.resolve({ ...hit }))
          .catch(() => null);
        if (spec) {
          enter(p.pluginId, spec);
          return shown;
        }
      }
      return null;
    },
    enter,
    exit(pluginId) {
      if (!shown) return false;
      if (pluginId !== undefined && shown.pluginId !== pluginId) return false;
      shown = null;
      emit();
      return true;
    },
    current: () => shown,
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
