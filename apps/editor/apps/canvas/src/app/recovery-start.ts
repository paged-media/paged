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

// Editor ADR 1204 — this editor's recovery journal. Begun with the local
// library (the page entry and the plain editor; an embedded editor keeps
// none unless its host asks, so it never writes to its host's origin
// storage unasked, ADR 277), in the origin-private file system under
// `paged-recovery`, with Web Locks telling a live editor's session from one
// that crashed. `localStorage["paged.recovery"] = "off"`, read through the
// editor's storage adapter, keeps it from starting.
//
// Per editor: the session, its lock and the offers it claimed are this
// instance's; the returned stop ends them (a clean close purges).

import {
  opfsFs,
  RecoveryJournal,
  webLocksLiveness,
  type RecoveryLiveness,
  type RepoFs,
} from "@paged-media/repository";
import {
  attachRecovery,
  editorStorage,
  type EditorScope,
} from "@paged-media/shell";

const RECOVERY_FLAG = "paged.recovery";

/** The journal's root in the origin-private file system. */
export const RECOVERY_ROOT = "paged-recovery";

type Locks = Parameters<typeof webLocksLiveness>[0];

export interface RecoveryPlatform {
  /** Which sessions live: Web Locks, when the browser has them. */
  liveness: RecoveryLiveness | null;
  /** The journal's storage, when the browser has an origin-private file
   *  system. */
  fs: (() => Promise<RepoFs>) | null;
}

function browserPlatform(): RecoveryPlatform {
  const nav = globalThis.navigator as
    | (Navigator & { locks?: Locks; storage?: { getDirectory?: unknown } })
    | undefined;
  return {
    liveness: nav?.locks ? webLocksLiveness(nav.locks) : null,
    fs:
      typeof nav?.storage?.getDirectory === "function"
        ? () => opfsFs(RECOVERY_ROOT)
        : null,
  };
}

/**
 * Begin `scope`'s recovery session and offer what crashed sessions left.
 * Resolves to the clean close, or null when no journal is kept (switched
 * off, no Web Locks, no origin-private file system, or the storage
 * refused). Never throws.
 */
export async function startRecovery(
  scope: EditorScope,
  identify: () => { key: string; stable: boolean },
  platform: RecoveryPlatform = browserPlatform(),
): Promise<(() => Promise<void>) | null> {
  try {
    if (editorStorage(scope).getItem(RECOVERY_FLAG) === "off") return null;
  } catch {
    /* storage blocked — the journal needs it no more than the check does */
  }
  // Without locks a live editor in another tab would read as crashed:
  // keeping no journal is the safe answer.
  if (!platform.liveness || !platform.fs) return null;
  let journal: RecoveryJournal;
  try {
    journal = new RecoveryJournal(await platform.fs(), {
      liveness: platform.liveness,
    });
  } catch (err) {
    console.warn("recovery: no journal:", err);
    return null;
  }
  return begin(scope, journal, identify).catch((err: unknown) => {
    console.warn("recovery: the journal did not start:", err);
    return null;
  });
}

async function begin(
  scope: EditorScope,
  journal: RecoveryJournal,
  identify: () => { key: string; stable: boolean },
): Promise<() => Promise<void>> {
  const session = await journal.begin();
  await journal.prune();
  const offers = [];
  for (const checkpoint of await journal.orphans()) {
    // Claimed while offered, so a second tab does not offer it too.
    const release = await journal.claim(checkpoint.session);
    if (release) offers.push({ checkpoint, release });
  }
  return attachRecovery(scope, { journal, session, identify, offers });
}
