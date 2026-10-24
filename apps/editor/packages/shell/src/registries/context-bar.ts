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
 * Extensions ADR 348, editor ADR 298 — the control-bar groups and the
 * status-bar items a bundle contributes for one of its edit contexts (C1,
 * C3), and the document context a bundle holds for the open document. The
 * contract's contribution types, as they are: the canvas app renders them
 * (`cockpit/control-bar.tsx`, `StatusBar`) while their scope is active.
 */
export type ControlBarGroupContribution = Api.ControlBarGroupContribution;
export type StatusItemContribution = Api.StatusItemContribution;

interface Scoped {
  id: string;
  order?: number;
  scope: { editContext: string };
}

export interface ScopedItemRegistry<T extends Scoped> {
  register(contribution: T): Disposable;
  /** Every registered item, in `order` (registration order breaks ties). */
  list(): T[];
  /** The items whose scope is `editContext`, in order. */
  forContext(editContext: string | null): T[];
  onChange(handler: () => void): Disposable;
}

function createScopedItemRegistry<T extends Scoped>(
  name: string,
): ScopedItemRegistry<T> {
  const items: T[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  const sorted = () =>
    items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100) || a.i - b.i)
      .map((e) => e.item);
  return {
    register(contribution) {
      if (items.some((c) => c.id === contribution.id)) {
        throw new Error(`${name}: "${contribution.id}" is already registered`);
      }
      items.push(contribution);
      emit();
      return {
        dispose() {
          const i = items.indexOf(contribution);
          if (i >= 0) {
            items.splice(i, 1);
            emit();
          }
        },
      };
    },
    list: sorted,
    forContext(editContext) {
      if (editContext === null) return [];
      return sorted().filter((c) => c.scope.editContext === editContext);
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

export type ControlBarGroupRegistry =
  ScopedItemRegistry<ControlBarGroupContribution>;
export type StatusItemRegistry = ScopedItemRegistry<StatusItemContribution>;

export function createControlBarGroupRegistry(): ControlBarGroupRegistry {
  return createScopedItemRegistry<ControlBarGroupContribution>(
    "ControlBarGroupRegistry",
  );
}

export function createStatusItemRegistry(): StatusItemRegistry {
  return createScopedItemRegistry<StatusItemContribution>(
    "StatusItemRegistry",
  );
}

/**
 * The document context (extensions ADR 348): the plugin content type the
 * open document IS, held by the plugin that said so. One per editor; the
 * shell drops it when a document loads (`PagedEditorBinder`).
 */
export interface DocumentContextStore {
  /** The held context, or null. */
  get(): { pluginId: string; type: string } | null;
  /** Hold `type` for `pluginId`, or (with `null`) drop it if `pluginId`
   *  holds it. Answers true: the editor always takes it. */
  set(pluginId: string, type: string | null): boolean;
  clear(): void;
  onChange(handler: () => void): Disposable;
}

export function createDocumentContextStore(): DocumentContextStore {
  let held: { pluginId: string; type: string } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  return {
    get: () => held,
    set(pluginId, type) {
      if (type === null) {
        if (held?.pluginId === pluginId) {
          held = null;
          emit();
        }
        return true;
      }
      if (held?.pluginId === pluginId && held.type === type) return true;
      held = { pluginId, type };
      emit();
      return true;
    },
    clear() {
      if (held === null) return;
      held = null;
      emit();
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

/** The context the scoped contributions follow in `state` (the
 *  `PagedEditor` handle): the active frame-level edit context, or, when
 *  none is active, the document context. Null when neither. */
export function activeScopeContext(state: unknown): string | null {
  const st = state as {
    editContext?: { type?: string } | null;
    documentContext?: string | null;
  } | null;
  if (st?.editContext) return st.editContext.type ?? null;
  return st?.documentContext ?? null;
}
