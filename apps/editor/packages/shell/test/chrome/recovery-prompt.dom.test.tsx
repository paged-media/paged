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

// The recovery prompt (editor ADR 1204, UX audit F-06): a crashed
// session's work is offered back; Compare says what the copy holds against
// the saved version; Discard forgets it; Not now keeps it for the next
// start. Restore is the e2e's (tests/e2e/uxi-documents.spec.ts): it needs
// the engine.

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  memoryFs,
  memoryLiveness,
  RecoveryJournal,
  type RecoveryLiveness,
  type RepoFs,
} from "@paged-media/repository";

import { RecoveryPrompt } from "../../src/chrome/RecoveryPrompt";
import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";
import { attachRecovery } from "../../src/state/recovery";

afterEach(() => cleanup());

const sinks = { setStatus: () => undefined, pushWarning: () => undefined };

/** A session that crashed with unsaved work in "Annual". */
async function crashed(fs: RepoFs, liveness: RecoveryLiveness) {
  const releases: (() => void)[] = [];
  const session = await new RecoveryJournal(fs, {
    liveness: {
      async hold(name) {
        const r = await liveness.hold(name);
        releases.push(r);
        return r;
      },
      tryHold: (n) => liveness.tryHold(n),
      held: () => liveness.held(),
    },
  }).begin();
  await session.write({
    document: {
      key: "fh:1",
      stable: true,
      name: "Annual",
      source: { kind: "file", name: "Annual.paged" },
      openedAt: 1,
      savedAt: null,
    },
    bytes: new Uint8Array([1, 2, 3]),
    reason: "idle",
    edits: 7,
    pages: 12,
  });
  for (const r of releases) r();
}

async function mount() {
  const fs = memoryFs();
  const liveness = memoryLiveness();
  await crashed(fs, liveness);
  const journal = new RecoveryJournal(fs, { liveness });
  const session = await journal.begin();
  const offers = [];
  for (const checkpoint of await journal.orphans()) {
    const release = await journal.claim(checkpoint.session);
    if (release) offers.push({ checkpoint, release });
  }
  const scope: EditorScope = createEditorScope();
  attachRecovery(scope, {
    journal,
    session,
    identify: () => ({ key: "t:2", stable: false }),
    offers,
  });
  render(
    <EditorScopeProvider scope={scope}>
      <RecoveryPrompt sinks={sinks} />
    </EditorScopeProvider>,
  );
  return { fs, liveness };
}

const dialog = () =>
  document.body.querySelector<HTMLElement>('[data-testid="recovery-dialog"]');
const button = (id: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe("the recovery prompt", () => {
  test("offers the crashed session's copy, and Compare says what it holds against the saved version", async () => {
    await mount();
    expect(dialog()).not.toBeNull();
    expect(button("recovery-body").textContent).toContain(
      "Annual had unsaved changes when the editor last closed.",
    );
    act(() => {
      fireEvent.click(button("recovery-compare-toggle"));
    });
    const compare = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>(
        '[data-testid="recovery-compare"]',
      );
      if (!el?.querySelector('[data-recovery-saved="file"]'))
        throw new Error("not yet");
      return el;
    });
    expect(compare.textContent).toContain("7 unsaved changes; 12 pages");
    expect(compare.textContent).toContain("The file Annual.paged");
    expect(compare.textContent).toContain(
      "Restoring opens the copy as a new document, Annual (recovered). The saved version is not changed.",
    );
  });

  test("Discard forgets the copy", async () => {
    const { fs, liveness } = await mount();
    await act(async () => {
      fireEvent.click(button("recovery-discard"));
    });
    await waitFor(() => {
      if (dialog()) throw new Error("still open");
    });
    expect(await new RecoveryJournal(fs, { liveness }).orphans()).toHaveLength(
      0,
    );
  });

  test("Not now keeps the copy for the next start", async () => {
    const { fs, liveness } = await mount();
    act(() => {
      fireEvent.click(button("recovery-later"));
    });
    expect(dialog()).toBeNull();
    expect(await new RecoveryJournal(fs, { liveness }).orphans()).toHaveLength(
      1,
    );
  });
});
