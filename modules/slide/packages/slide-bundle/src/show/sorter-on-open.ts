/*
 * This file is part of paged (https://paged.media).
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

// A deck opens in the slide sorter (slide ADR 725; UX audit F-47): the
// sorter is a deck's navigation. Once per opened document, when the store
// first says it is a deck of two or more slides, the sorter view is shown
// in the canvas's place; a one-slide deck (a new presentation) opens on its
// slide. The user's switch ("Open decks in the sorter", the bundle's
// storage key `sorterOnOpen`) turns it off.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

import type { SlidesStore } from "../slides-model.js";
import { SORTER_VIEW } from "./contribute.js";

/** The bundle storage key of the switch (absent: on). */
export const SORTER_ON_OPEN_KEY = "sorterOnOpen";

/** Whether decks open in the sorter (the user's switch; on by default). */
export function sorterOnOpen(host: Pick<BundleHost, "storage">): boolean {
  try {
    return host.storage.get<boolean>(SORTER_ON_OPEN_KEY) !== false;
  } catch {
    return true;
  }
}

/** Set the switch. */
export function setSorterOnOpen(
  host: Pick<BundleHost, "storage">,
  on: boolean,
): void {
  try {
    host.storage.set(SORTER_ON_OPEN_KEY, on);
  } catch {
    /* no storage: the default stays */
  }
}

/** Show the sorter once per opened deck. */
export function openDecksInSorter(
  host: Pick<BundleHost, "document" | "shell" | "storage" | "log">,
  store: Pick<SlidesStore, "isDeck" | "list" | "subscribe">,
): Disposable {
  // A document is pending until the store has read its pages: then it is
  // a deck or not, once.
  let pending = true;
  // The old document's slides, while the store has not read the new one.
  let stale: readonly unknown[] | null = null;
  const check = () => {
    if (!pending) return;
    const list = store.list();
    if (list === stale) return;
    stale = null;
    const count = list.length;
    if (count === 0) return; // the pages are not read yet
    pending = false;
    if (!store.isDeck() || count < 2 || !sorterOnOpen(host)) return;
    try {
      host.shell.showView(SORTER_VIEW);
    } catch (err) {
      host.log.debug(`paged.slide: the sorter did not open (${String(err)})`);
    }
  };
  // A new document: decided on the store's next reading of its pages (the
  // store still holds the old one's until then).
  const opened = host.document.onDidOpen(() => {
    pending = true;
    stale = store.list();
  });
  const off = store.subscribe(check);
  check();
  return {
    dispose() {
      opened.dispose();
      off();
    },
  };
}
