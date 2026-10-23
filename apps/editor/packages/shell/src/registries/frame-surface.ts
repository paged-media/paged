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
 * Frame surfaces (extensions ADR 334, editor ADR 281): a bundle's live DOM
 * editing surface for one of its edit contexts, mounted by the canvas over
 * the active frame. Keyed by the edit-context type: one surface per
 * context. The contract's `FrameSurfaceContribution`, as is.
 */
export type FrameSurfaceContribution = Api.FrameSurfaceContribution;
export type FrameSurfaceProps = Api.FrameSurfaceProps;

export interface FrameSurfaceRegistry extends Api.FrameSurfaceRegistry {
  register(contribution: FrameSurfaceContribution): Disposable;
  /** The surface for an edit-context type, if one is registered. */
  get(contextType: string): FrameSurfaceContribution | undefined;
  list(): FrameSurfaceContribution[];
  onChange(handler: () => void): Disposable;
}

export function createFrameSurfaceRegistry(): FrameSurfaceRegistry {
  const byType = new Map<string, FrameSurfaceContribution>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  return {
    // The canvas shows a surface full screen (editor ADR 283).
    fullscreen: true,
    register(contribution) {
      if (byType.has(contribution.contextType)) {
        throw new Error(
          `FrameSurfaceRegistry: a surface for "${contribution.contextType}" is already registered`,
        );
      }
      byType.set(contribution.contextType, contribution);
      emit();
      return {
        dispose() {
          if (byType.get(contribution.contextType) === contribution) {
            byType.delete(contribution.contextType);
            emit();
          }
        },
      };
    },
    get(contextType) {
      return byType.get(contextType);
    },
    list() {
      return Array.from(byType.values());
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
