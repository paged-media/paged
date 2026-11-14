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

// A push of the open document to paged.server is the save status's remote
// step (editor ADR 1203, decision 3): syncing, then synced; a refused push
// reads saved locally · not synced, with the server's words; a push of
// another library document leaves the open one's status alone.

import { describe, expect, test } from "bun:test";

import type { DocumentEntry } from "@paged-media/repository";
import {
  createEditorScope,
  saveStateOf,
  setCurrentLibraryDocument,
} from "@paged-media/shell";

import { pushReported } from "../../../src/panels/library-panel";

const DOC: DocumentEntry = {
  id: "d1",
  name: "annual",
  createdAt: 1,
  updatedAt: 2,
  head: "c1",
};
const REMOTE = { url: "https://server.test", repo: "annual", token: "t" };

function openScope() {
  const scope = createEditorScope();
  setCurrentLibraryDocument(scope, DOC);
  const store = saveStateOf(scope);
  store.dispatch({
    type: "opened",
    origin: { kind: "opened", name: "annual.paged" },
    at: 1,
  });
  return { scope, store };
}

describe("a library push reports to the save status", () => {
  test("syncing while it runs, then synced to the repository", async () => {
    const { scope, store } = openScope();
    let during = "";
    await pushReported(scope, DOC, REMOTE, async () => {
      during = store.get().kind;
      return { sent: 1, bytes: 10 };
    });
    expect(during).toBe("syncing");
    const s = store.get();
    expect(s.kind).toBe("synced");
    expect(s.saved?.where).toContainEqual({ kind: "remote", repo: "annual" });
  });

  test("a refused push reads not synced, never synced", async () => {
    const { scope, store } = openScope();
    await expect(
      pushReported(scope, DOC, REMOTE, async () => {
        throw new Error("403 forbidden");
      }),
    ).rejects.toThrow("403");
    const s = store.get();
    expect(s.kind).toBe("not-synced");
    expect(s.missed?.code).toBe("remote-failed");
    expect(s.missed?.detail).toBe("403 forbidden");
  });

  test("another library document's push leaves the open one alone", async () => {
    const { scope, store } = openScope();
    const before = store.get();
    await pushReported(scope, { ...DOC, id: "other" }, REMOTE, async () => ({
      sent: 0,
      bytes: 0,
    }));
    expect(store.get()).toBe(before);
  });
});
