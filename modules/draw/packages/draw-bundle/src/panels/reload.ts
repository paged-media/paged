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

// WHEN A PANEL RELOADS — the one scheduler every panel and both binding
// drivers in this folder share. No React here: the binding drivers are
// pure data + a subscription, and `use-panel-reload.ts` is the hook over
// this for the React panels.
//
// What it replaces, in all ten: `() => void reload()` wired straight to
// `selection.onDidChange` and `document.onDidChange`. Measured
// (`test/panels/*.spec.tsx`): a burst of 20 changes started 20 reloads,
// every one ran to the end, and whichever FINISHED last was what the
// panel showed — so an older, slower reload could overwrite a newer one.
//
// Three rules, and each one is a measured bug's fix:
//
//  1. COALESCE. A request arms one timer for the next task; requests
//     that arrive before it fires are the same reload. A command that
//     selects, mutates and selects again is one reload, and so is a
//     burst of twenty changes. The delay is zero — a turn of the event
//     loop, not a wait — and it has to be a TASK: a microtask would run
//     between two awaited mutations of the same burst.
//
//  2. THE LAST RELOAD TO START WINS. Each run takes a ticket; `live()`
//     is true only for the newest one, and only until the owner is
//     disposed. A reload asks it after every await and before it shows
//     anything, so a stale answer is dropped instead of displayed.
//
//  3. THE SELECTION IS THE ONE THE HOST HANDED OVER. The SDK adapter's
//     `selection.set` delivers `elementSelectionApplied` to subscribers
//     BEFORE it stores the new selection, so a listener that re-reads
//     `host.selection.get()` inside the event sees the previous one. The
//     ids the event carries are kept and given to the reload.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

/** What a reload is given. */
export interface ReloadContext {
  /** Is this still the newest reload of a live owner? Ask after every
   *  await; show nothing once it answers false. */
  live(): boolean;
  /** The selection as the host last reported it. */
  selection: readonly ElementId[];
}

export type Reload = (context: ReloadContext) => Promise<void> | void;

export interface Reloader {
  /** Ask for a reload. Any number of requests before the next task are
   *  ONE reload. `selection` — the ids a selection event handed over —
   *  replaces the remembered selection. */
  request(selection?: readonly ElementId[]): void;
  /** Run one reload NOW, uncoalesced: the first one, when whatever reads
   *  the result must not see a gap. */
  now(): void;
  /** Stop: a pending reload never starts and one in flight is no longer
   *  live. */
  dispose(): void;
}

/**
 * `bindings.publish`, minus the publishes that would change nothing.
 *
 * A binding driver derives its gates again on every selection and
 * document change, and most of the time most of them have not moved:
 * measured, a burst of 20 selection changes re-published 100 values of
 * which 96 were the value already there, and every one makes the host
 * look its schema rows up again. The driver is the only writer of its
 * gates, so what it last published IS what the host holds.
 */
export function publishChanges(
  host: Pick<BundleHost, "bindings">,
): (name: string, value: unknown) => void {
  const published = new Map<string, unknown>();
  return (name, value) => {
    if (published.has(name) && Object.is(published.get(name), value)) return;
    published.set(name, value);
    host.bindings.publish(name, value);
  };
}

/** The scheduler. `name` is what a failure log carries. */
export function createReloader(
  host: Pick<BundleHost, "selection" | "log">,
  name: string,
  reload: Reload,
): Reloader {
  let ticket = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The last selection an event handed over; null until one has. */
  let handed: readonly ElementId[] | null = null;

  const run = (): void => {
    timer = null;
    if (disposed) return;
    const mine = ++ticket;
    const context: ReloadContext = {
      live: () => !disposed && mine === ticket,
      selection: handed ?? host.selection.get(),
    };
    void (async () => {
      try {
        await reload(context);
      } catch (e) {
        host.log.warn(`${name}: reload failed (${String(e)})`);
      }
    })();
  };

  return {
    request(selection) {
      if (disposed) return;
      if (selection !== undefined) handed = selection;
      if (timer === null) timer = setTimeout(run, 0);
    },
    now() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      run();
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
