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

// The page-thumbnail keeper (page-thumbnails.ts): the document state's
// snapshots follow the edits. A change reply names the pages it touched;
// once the edits settle (250 ms) each touched page is re-snapshotted, once,
// in page order. A page that left the document loses its thumbnail; a
// page without one gets one. Nothing is taken before the load's own
// snapshot pass has finished.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CanvasClient,
  DocumentHandle,
  WorkerToMain,
} from "@paged-media/client";

import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  DocumentProvider,
  useDocument,
} from "../../src/state/document-context";
import { usePageThumbnails } from "../../src/state/page-thumbnails";

const handleOf = (docId: string, pageIds: string[]) =>
  ({
    docId,
    pageIds,
    pageCount: pageIds.length,
    pageSizesPt: pageIds.map(() => [612, 792]),
  }) as unknown as DocumentHandle;

function fakeClient() {
  const listeners = new Set<(m: WorkerToMain) => void>();
  const shots: string[] = [];
  const client = {
    subscribe(l: (m: WorkerToMain) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async requestSnapshot(pageId: string) {
      shots.push(pageId);
      return { pageId, pngBytes: [137, 80], widthPx: 256, heightPx: 1 };
    },
  } as unknown as CanvasClient;
  const emit = (kind: string, pageIds: string[]) => {
    for (const l of listeners)
      l({ kind, payload: { pageIds } } as unknown as WorkerToMain);
  };
  return { client, shots, emit };
}

function mount(client: CanvasClient) {
  return renderHook(
    () => {
      usePageThumbnails();
      return useDocument();
    },
    {
      wrapper: ({ children }: PropsWithChildren) => (
        <CanvasClientProvider client={client}>
          <DocumentProvider>{children}</DocumentProvider>
        </CanvasClientProvider>
      ),
    },
  );
}

/** A loaded document whose load pass already snapshotted every page. */
function loaded(
  result: { current: ReturnType<typeof useDocument> },
  h: DocumentHandle,
) {
  act(() => {
    result.current.setHandle(h);
    result.current.setSnapshots(
      new Map(h.pageIds.map((id) => [id, `blob:load-${id}`])),
    );
    result.current.setSnapshotsReady(true);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => cleanup());

describe("page thumbnails follow the edits", () => {
  test("a burst of edits re-snapshots each touched page once, in page order, after it settles", async () => {
    const c = fakeClient();
    const { result } = mount(c.client);
    loaded(result, handleOf("d1", ["p1", "p2", "p3"]));
    act(() => {
      c.emit("mutationApplied", ["p3"]);
      c.emit("gestureCommitted", ["p1", "p3"]);
      c.emit("undoApplied", ["p3"]);
    });
    await wait(100);
    expect(c.shots).toEqual([]);
    await waitFor(() => expect(c.shots).toEqual(["p1", "p3"]));
    await waitFor(() =>
      expect(result.current.snapshots.get("p1")).not.toBe("blob:load-p1"),
    );
    expect(result.current.snapshots.get("p2")).toBe("blob:load-p2");
  });

  test("a reply that names no page takes no thumbnail", async () => {
    const c = fakeClient();
    const { result } = mount(c.client);
    loaded(result, handleOf("d1", ["p1"]));
    act(() => {
      c.emit("mutationApplied", []);
      c.emit("documentMeta", ["p1"]);
    });
    await wait(400);
    expect(c.shots).toEqual([]);
  });

  test("nothing is taken before the load's own pass is ready", async () => {
    const c = fakeClient();
    const { result } = mount(c.client);
    act(() => result.current.setHandle(handleOf("d1", ["p1"])));
    act(() => c.emit("mutationApplied", ["p1"]));
    await wait(400);
    expect(c.shots).toEqual([]);
  });

  test("a page that left the document loses its thumbnail; a new page gets one", async () => {
    const c = fakeClient();
    const { result } = mount(c.client);
    loaded(result, handleOf("d1", ["p1", "p2"]));
    act(() => result.current.setHandle(handleOf("d1", ["p1", "p3"])));
    await waitFor(() => expect(c.shots).toEqual(["p3"]));
    await waitFor(() =>
      expect([...result.current.snapshots.keys()].sort()).toEqual(["p1", "p3"]),
    );
  });

  test("after unmount nothing more is requested", async () => {
    const c = fakeClient();
    const view = mount(c.client);
    loaded(view.result, handleOf("d1", ["p1"]));
    act(() => c.emit("mutationApplied", ["p1"]));
    view.unmount();
    await wait(400);
    expect(c.shots).toEqual([]);
  });
});
