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

// The header's save status (editor ADR 1203, UX audit F-07, D-10): the
// label is what the last save really did, the popover says where and why,
// Retry runs the save again.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CanvasClient,
  DocumentHandle,
  WorkerToMain,
} from "@paged-media/client";
import type { SaveEvent } from "@paged-media/repository";

import { SaveStatus } from "../../src/chrome/SaveStatus";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  DocumentProvider,
  useDocument,
} from "../../src/state/document-context";
import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";
import { setDocumentSaver } from "../../src/state/replace-guard";
import { SaveStateController } from "../../src/state/save-state-controller";
import { saveStateOf } from "../../src/state/save-status";

afterEach(() => cleanup());

const HANDLE = {
  docId: "d1",
  pageIds: ["p1"],
  pageCount: 1,
  pageSizesPt: [[612, 792]],
} as unknown as DocumentHandle;

/** A client whose dirty flag the test sets. */
function fakeClient(state: { dirty: boolean }) {
  const listeners = new Set<(m: WorkerToMain) => void>();
  const saved = new Set<() => void>();
  return {
    client: {
      documentMeta: async () => ({ dirty: state.dirty, documentName: null }),
      subscribe: (l: (m: WorkerToMain) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      onSaved: (l: () => void) => {
        saved.add(l);
        return () => saved.delete(l);
      },
      setSessionPolicy: async () => undefined,
    } as unknown as CanvasClient,
    edit() {
      state.dirty = true;
      for (const l of listeners)
        l({ kind: "mutationApplied", payload: {} } as unknown as WorkerToMain);
    },
  };
}

function Open({ name }: { name: string | null }) {
  const { setHandle, setSourceName } = useDocument();
  useEffect(() => {
    setSourceName(name);
    setHandle(HANDLE);
  }, [name, setHandle, setSourceName]);
  return null;
}

function mount(scope: EditorScope, client: CanvasClient, name: string | null) {
  return render(
    <EditorScopeProvider scope={scope}>
      <CanvasClientProvider client={client}>
        <DocumentProvider>
          <Open name={name} />
          <SaveStateController />
          <SaveStatus />
        </DocumentProvider>
      </CanvasClientProvider>
    </EditorScopeProvider>,
  );
}

const status = () =>
  document.body.querySelector<HTMLElement>("[data-save-status]");

const send = (scope: EditorScope, events: SaveEvent[]) =>
  act(() => {
    for (const e of events) saveStateOf(scope).dispatch(e);
  });

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("the save status", () => {
  test("an opened document reads No changes; an edit reads Unsaved changes", async () => {
    const scope = createEditorScope();
    const { client, edit } = fakeClient({ dirty: false });
    mount(scope, client, "Annual");
    await settle();
    expect(status()?.dataset.saveState).toBe("new");
    expect(status()?.getAttribute("aria-label")).toBe("No changes");
    act(() => edit());
    await settle();
    expect(status()?.dataset.saveState).toBe("editing");
    expect(status()?.getAttribute("aria-label")).toBe("Unsaved changes");
  });

  test("UXI-T67: a local commit whose write-back failed reads not synced, offers Retry, and never Saved", async () => {
    const scope = createEditorScope();
    const { client } = fakeClient({ dirty: true });
    mount(scope, client, "Annual");
    await settle();
    let retried = 0;
    setDocumentSaver(scope, () => {
      retried += 1;
    });
    const seen: string[] = [];
    const off = saveStateOf(scope).subscribe(() =>
      seen.push(saveStateOf(scope).get().kind),
    );
    const file = { kind: "file", name: "Annual.paged" } as const;
    send(scope, [
      { type: "save-started", at: 1 },
      { type: "stored", destination: { kind: "library" } },
      { type: "sync-started", target: file },
      {
        type: "sync-failed",
        target: file,
        code: "permission-denied",
        detail: "NotAllowedError: denied",
        at: 2,
      },
      {
        type: "stored",
        destination: { kind: "download", name: "Annual.paged" },
      },
      { type: "dirty", dirty: false },
      { type: "save-finished", at: 3 },
    ]);
    off();
    expect(seen).not.toContain("synced");
    expect(status()?.dataset.saveState).toBe("not-synced");
    expect(status()?.getAttribute("aria-label")).toBe(
      "Saved locally · Not synced",
    );
    act(() => {
      fireEvent.click(status()!);
    });
    const details = document.body.querySelector<HTMLElement>(
      "[data-save-status-details]",
    );
    expect(details?.textContent).toContain(
      "Could not write to Annual.paged: permission to write it was not granted.",
    );
    expect(
      [...details!.querySelectorAll("[data-save-destination]")].map(
        (li) => (li as HTMLElement).dataset.saveDestination,
      ),
    ).toEqual(["library", "download"]);
    const retry = details!.querySelector<HTMLElement>("[data-save-retry]");
    expect(retry).not.toBeNull();
    act(() => {
      fireEvent.click(retry!);
    });
    expect(retried).toBe(1);
  });

  test("a write-back that landed reads Saved and names the file", async () => {
    const scope = createEditorScope();
    const { client } = fakeClient({ dirty: true });
    mount(scope, client, "Annual");
    await settle();
    const file = { kind: "file", name: "Annual.paged" } as const;
    send(scope, [
      { type: "save-started", at: 1 },
      { type: "stored", destination: { kind: "library" } },
      { type: "sync-started", target: file },
    ]);
    expect(status()?.dataset.saveState).toBe("syncing");
    send(scope, [
      { type: "stored", destination: file },
      { type: "dirty", dirty: false },
      { type: "save-finished", at: 2 },
    ]);
    expect(status()?.dataset.saveState).toBe("synced");
    expect(status()?.getAttribute("aria-label")).toBe("Saved");
    act(() => {
      fireEvent.click(status()!);
    });
    expect(
      document.body.querySelector("[data-save-status-details]")?.textContent,
    ).toContain("In Annual.paged");
    expect(document.body.querySelector("[data-save-retry]")).toBeNull();
  });

  test("a save that stored nothing reads Couldn't save, with the reason and Retry", async () => {
    const scope = createEditorScope();
    const { client } = fakeClient({ dirty: true });
    mount(scope, client, null);
    await settle();
    send(scope, [
      { type: "save-started", at: 1 },
      { type: "save-failed", code: "export-failed", detail: "boom", at: 2 },
    ]);
    expect(status()?.dataset.saveState).toBe("failed");
    expect(status()?.getAttribute("aria-label")).toBe("Couldn't save");
    act(() => {
      fireEvent.click(status()!);
    });
    const details = document.body.querySelector("[data-save-status-details]");
    expect(details?.textContent).toContain(
      "The document was not saved: the document could not be written out.",
    );
    expect(details?.querySelector("[data-save-retry]")).not.toBeNull();
  });

  test("a document restored from the journal reads Recovered until it is saved", async () => {
    const scope = createEditorScope();
    const { client } = fakeClient({ dirty: false });
    mount(scope, client, "Annual");
    await settle();
    send(scope, [
      {
        type: "opened",
        origin: { kind: "recovered", name: "Annual", checkpointAt: 5 },
        at: 6,
      },
    ]);
    expect(status()?.dataset.saveState).toBe("recovered");
    expect(status()?.getAttribute("aria-label")).toBe("Recovered · Not saved");
  });
});
