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

// The recovery journal's start (editor ADR 1204): one session per editor,
// the crashed sessions' work offered, the `paged.recovery` flag read
// through the editor's storage adapter.

import { describe, expect, test } from "bun:test";

import {
  memoryFs,
  memoryLiveness,
  RecoveryJournal,
  type RecoveryLiveness,
} from "@paged-media/repository";
import {
  createEditorScope,
  memoryStorage,
  recoveryAttached,
  recoveryOffers,
  setEditorStorage,
} from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import { startRecovery } from "../../../src/app/recovery-start";

const identify = () => ({ key: "t:1", stable: false });

/** A crashed session on the shared storage: written, its lock gone. */
async function crashedSession(fs = memoryFs()) {
  const held = memoryLiveness();
  const releases: (() => void)[] = [];
  const liveness: RecoveryLiveness = {
    async hold(name) {
      const r = await held.hold(name);
      releases.push(r);
      return r;
    },
    tryHold: (name) => held.tryHold(name),
    held: () => held.held(),
  };
  const session = await new RecoveryJournal(fs, { liveness }).begin();
  await session.write({
    document: {
      key: "lib:a",
      stable: true,
      name: "Annual",
      source: { kind: "library", documentId: "a" },
      openedAt: 1,
      savedAt: null,
    },
    bytes: new Uint8Array([1, 2, 3]),
    reason: "idle",
    edits: 5,
    pages: 4,
  });
  for (const r of releases) r();
  return { fs, liveness: held };
}

describe("startRecovery", () => {
  test('"off" keeps the journal from starting', async () => {
    covers("setting:paged.recovery");
    const scope = createEditorScope();
    const storage = memoryStorage();
    storage.setItem("paged.recovery", "off");
    setEditorStorage(scope, storage);
    const { fs, liveness } = await crashedSession();
    const stop = await startRecovery(scope, identify, {
      liveness,
      fs: async () => fs,
    });
    expect(stop).toBeNull();
    expect(recoveryAttached(scope)).toBe(false);
  });

  test("absent, it begins this editor's session and offers the crashed one's work", async () => {
    covers("setting:paged.recovery");
    const scope = createEditorScope();
    setEditorStorage(scope, memoryStorage());
    const { fs, liveness } = await crashedSession();
    const stop = await startRecovery(scope, identify, {
      liveness,
      fs: async () => fs,
    });
    expect(stop).not.toBeNull();
    expect(recoveryAttached(scope)).toBe(true);
    const offer = recoveryOffers(scope).current();
    expect(offer?.document.name).toBe("Annual");
    expect(offer?.edits).toBe(5);
    await stop!();
    expect(recoveryAttached(scope)).toBe(false);
    // The offered work stays in the journal: the stop let it go unanswered.
    expect(await new RecoveryJournal(fs, { liveness }).orphans()).toHaveLength(
      1,
    );
  });

  test("without locks no journal is kept: a live tab would read as crashed", async () => {
    const scope = createEditorScope();
    setEditorStorage(scope, memoryStorage());
    const stop = await startRecovery(scope, identify, {
      liveness: null,
      fs: async () => memoryFs(),
    });
    expect(stop).toBeNull();
  });
});
