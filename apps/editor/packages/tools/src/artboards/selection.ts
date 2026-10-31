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

// Engine ADR 1011 — which artboard is selected, per editor. The Artboard
// tool writes it (a click selects a board) and the Artboards panel reads
// and writes it (a row is the board), so they agree without a round trip.
// Keyed by the editor's client: one per editor, gone with it.

type Listener = () => void;

export interface ArtboardSelection {
  get(): string | null;
  set(pageId: string | null): void;
  subscribe(listener: Listener): () => void;
}

const stores = new WeakMap<object, ArtboardSelection>();

function createSelection(): ArtboardSelection {
  let current: string | null = null;
  const listeners = new Set<Listener>();
  return {
    get: () => current,
    set(pageId) {
      if (pageId === current) return;
      current = pageId;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The artboard selection of the editor `client` belongs to. */
export function artboardSelectionOf(client: object): ArtboardSelection {
  let s = stores.get(client);
  if (!s) {
    s = createSelection();
    stores.set(client, s);
  }
  return s;
}
