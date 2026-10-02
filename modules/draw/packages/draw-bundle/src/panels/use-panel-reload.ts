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

// The React half of `./reload.ts`: what every expert-leaf panel in this
// folder mounts instead of wiring `() => void reload()` to two events.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";
import * as React from "react";

import { linkIndex } from "../link-index";
import { createReloader, type Reload, type Reloader } from "./reload";

/** The journal code of one started panel reload. */
export const PANEL_RELOAD_JOURNAL_CODE = "media.paged.draw.panel.reload";

/**
 * One reloader per mounted panel. It reloads on
 *   · a selection change (with the ids the host handed over),
 *   · a document change or a RECIPE WRITE (`linkIndex.onDidChange` — the
 *     second is the event a `.paged` part write never had, so a command
 *     run from the menu reaches an open panel exactly as its own button
 *     does),
 *   · and whenever the panel asks: the returned function, which a button
 *     calls after its command. It is a request like any other, so it
 *     coalesces with the events that command caused.
 *
 * `reload` may be a new closure on every render; the newest one runs.
 *
 * Every STARTED reload records one journal entry: the host's flight
 * recorder is where "how often does this panel reload" belongs, and it
 * is the count the render tests' budgets pin.
 */
export function usePanelReload(
  host: BundleHost,
  name: string,
  reload: Reload,
): () => void {
  const latest = React.useRef(reload);
  latest.current = reload;
  const reloader = React.useRef<Reloader | null>(null);

  React.useEffect(() => {
    const scheduler = createReloader(host, `${name} panel`, (context) => {
      try {
        host.journal.record({
          code: PANEL_RELOAD_JOURNAL_CODE,
          data: { panel: name },
        });
      } catch {
        /* the recorder is never a reason not to reload */
      }
      return latest.current(context);
    });
    reloader.current = scheduler;
    const subs: Disposable[] = [
      host.selection.onDidChange((ids) => scheduler.request(ids)),
      linkIndex(host).onDidChange(() => scheduler.request()),
    ];
    scheduler.request();
    return () => {
      reloader.current = null;
      scheduler.dispose();
      for (const sub of subs) sub.dispose();
    };
  }, [host, name]);

  return React.useCallback(() => reloader.current?.request(), []);
}

/**
 * A form whose fields FOLLOW a saved record without being overwritten by
 * it: `follow(id, params)` loads `params` into the draft only when the
 * record being followed, or what is saved for it, has CHANGED since the
 * last call — not on every reload.
 *
 * The bug this replaces: every reload ended in `if (saved)
 * setDraft(saved.params)`, and with exactly one record in the library
 * `resolve*` answers that record whatever is selected. So the selection
 * change a Make REQUIRES threw away the options typed for it.
 */
export function useFollowedDraft<P>(
  initial: P,
): [
  P,
  React.Dispatch<React.SetStateAction<P>>,
  (id: string, params: P) => void,
] {
  const [draft, setDraft] = React.useState<P>(initial);
  const followed = React.useRef<string | null>(null);
  const follow = React.useCallback((id: string, params: P) => {
    const key = `${id}\u0000${JSON.stringify(params)}`;
    if (followed.current === key) return;
    followed.current = key;
    setDraft(params);
  }, []);
  return [draft, setDraft, follow];
}
