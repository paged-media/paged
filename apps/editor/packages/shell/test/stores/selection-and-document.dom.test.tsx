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

// The selection mirror (selection-context.tsx), the document state
// (document-context.tsx) and the content selection
// (content-selection-context.tsx): the main-thread copies of what the
// worker holds, which the chrome draws from and the commands read.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CanvasClient,
  ContentSelection,
  DocumentHandle,
  ElementId,
  WorkerToMain,
} from "@paged-media/client";

import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  ContentSelectionProvider,
  useContentSelection,
} from "../../src/state/content-selection-context";
import {
  DocumentProvider,
  useDocument,
  useOptionalDocument,
} from "../../src/state/document-context";
import {
  SelectionProvider,
  useSelection,
} from "../../src/state/selection-context";
import {
  TEXT_TOOL_ID,
  ToolProvider,
  useTool,
} from "../../src/state/tool-context";

afterEach(() => cleanup());

const A = { kind: "rectangle", id: "a" } as ElementId;
const B = { kind: "textFrame", id: "b" } as ElementId;

describe("selection mirror", () => {
  test("defaults: nothing selected, select tool, no path edit, no entered group", () => {
    const { result } = renderHook(() => useSelection(), {
      wrapper: SelectionProvider,
    });
    expect(result.current.elementSelection).toEqual([]);
    expect(result.current.elementGeometry).toEqual([]);
    expect(result.current.activeTool).toBe("select");
    expect(result.current.pathEditMode).toBe(false);
    expect(result.current.selectedAnchors).toEqual([]);
    expect(result.current.selectedAnchorIndex).toBeNull();
    expect(result.current.activeGroup).toBeNull();
  });

  test("selection and geometry are set as given", () => {
    const { result } = renderHook(() => useSelection(), {
      wrapper: SelectionProvider,
    });
    act(() => result.current.setElementSelection([A, B]));
    expect(result.current.elementSelection).toEqual([A, B]);
    const geometry = [{ id: A, pageId: "p1", bounds: [0, 0, 10, 10] }] as never;
    act(() => result.current.setElementGeometry(geometry));
    expect(result.current.elementGeometry).toBe(geometry);
  });

  test("with a ToolProvider, the legacy select/text tool IS the effective tool", () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <ToolProvider>
        <SelectionProvider>{children}</SelectionProvider>
      </ToolProvider>
    );
    const { result } = renderHook(
      () => ({ sel: useSelection(), tool: useTool() }),
      { wrapper },
    );
    act(() => result.current.sel.setActiveTool("text"));
    expect(result.current.tool.effectiveTool).toBe(TEXT_TOOL_ID);
    expect(result.current.sel.activeTool).toBe("text");
    act(() => result.current.tool.setBaseTool("paged.tool.pen"));
    // Any tool that is not Type reads as "select" for the legacy readers.
    expect(result.current.sel.activeTool).toBe("select");
  });

  test("without a ToolProvider the legacy tool is kept locally", () => {
    const { result } = renderHook(() => useSelection(), {
      wrapper: SelectionProvider,
    });
    act(() => result.current.setActiveTool("text"));
    expect(result.current.activeTool).toBe("text");
  });

  test("selected anchors: the single-anchor view, and an equal set keeps its identity", () => {
    const { result } = renderHook(() => useSelection(), {
      wrapper: SelectionProvider,
    });
    act(() => result.current.setSelectedAnchors([2]));
    expect(result.current.selectedAnchorIndex).toBe(2);
    act(() => result.current.setSelectedAnchors([1, 4]));
    expect(result.current.selectedAnchorIndex).toBeNull();
    const kept = result.current.selectedAnchors;
    act(() => result.current.setSelectedAnchors([1, 4]));
    expect(result.current.selectedAnchors).toBe(kept);
    act(() => result.current.setSelectedAnchorIndex(null));
    expect(result.current.selectedAnchors).toEqual([]);
    act(() => result.current.setSelectedAnchorIndex(3));
    expect(result.current.selectedAnchors).toEqual([3]);
  });

  test("path edit mode and the entered group are plain view state", () => {
    const { result } = renderHook(() => useSelection(), {
      wrapper: SelectionProvider,
    });
    act(() => {
      result.current.setPathEditMode(true);
      result.current.setActiveGroup("g-7");
    });
    expect(result.current.pathEditMode).toBe(true);
    expect(result.current.activeGroup).toBe("g-7");
  });

  test("a script's selection change reaches the mirror through the client", async () => {
    const listeners = new Set<(m: WorkerToMain) => void>();
    const client = {
      subscribe(l: (m: WorkerToMain) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      setElementSelection: async () => [B],
      elementGeometry: async (ids: ElementId[]) =>
        ids.map((id) => ({ id, pageId: "p1", bounds: [0, 0, 1, 1] })),
      pageSummaries: async () => [],
    } as unknown as CanvasClient;
    const wrapper = ({ children }: PropsWithChildren) => (
      <CanvasClientProvider client={client}>
        <SelectionProvider>{children}</SelectionProvider>
      </CanvasClientProvider>
    );
    const { result, unmount } = renderHook(() => useSelection(), { wrapper });
    act(() => {
      for (const l of listeners)
        l({ kind: "scriptResult", payload: {} } as unknown as WorkerToMain);
    });
    await waitFor(() => expect(result.current.elementSelection).toEqual([B]));
    unmount();
    expect(listeners.size).toBe(0);
  });
});

describe("document state", () => {
  const HANDLE = {
    docId: "d1",
    pageIds: ["p1"],
    pageCount: 1,
    pageSizesPt: [[612, 792]],
  } as unknown as DocumentHandle;

  test("defaults: no document, nothing loading, no snapshots", () => {
    const { result } = renderHook(() => useDocument(), {
      wrapper: DocumentProvider,
    });
    expect(result.current.handle).toBeNull();
    expect(result.current.sourceName).toBeNull();
    expect(result.current.loading).toBeNull();
    expect(result.current.snapshots.size).toBe(0);
    expect(result.current.snapshotsReady).toBe(false);
    expect(result.current.resolution).toBeNull();
  });

  test("resetForNewDocument clears the per-document fields, revokes thumbnails, keeps the handle", () => {
    const revoked: string[] = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (u: string) => void revoked.push(u);
    try {
      const { result } = renderHook(() => useDocument(), {
        wrapper: DocumentProvider,
      });
      act(() => {
        result.current.setHandle(HANDLE);
        result.current.setSourceName("Annual");
        result.current.setSnapshots(new Map([["p1", "blob:one"]]));
        result.current.setSnapshotsReady(true);
        result.current.setResolution({} as never);
      });
      act(() => result.current.resetForNewDocument());
      expect(revoked).toEqual(["blob:one"]);
      expect(result.current.snapshots.size).toBe(0);
      expect(result.current.snapshotsReady).toBe(false);
      expect(result.current.resolution).toBeNull();
      expect(result.current.sourceName).toBeNull();
      // The loader replaces the handle when the new document lands.
      expect(result.current.handle).toBe(HANDLE);
    } finally {
      URL.revokeObjectURL = revoke;
    }
  });

  test("outside a provider the optional hook is null", () => {
    expect(renderHook(() => useOptionalDocument()).result.current).toBeNull();
  });
});

describe("content selection", () => {
  const SEL = (start: number, end: number) =>
    ({
      story: "s1",
      start,
      end,
      affinity: "downstream",
    }) as unknown as ContentSelection;

  function contentClient() {
    const sent: Array<ContentSelection | null> = [];
    const carets: Array<{
      sel: ContentSelection;
      resolve: (c: unknown) => void;
    }> = [];
    const client = {
      setSelection: async (s: ContentSelection | null) => void sent.push(s),
      caretGeometry: (sel: ContentSelection) =>
        new Promise((resolve) => carets.push({ sel, resolve })),
      selectionGeometry: async (sel: ContentSelection) => [
        { line: 0, from: sel.start, to: sel.end },
      ],
    } as unknown as CanvasClient;
    return { client, sent, carets };
  }

  const mount = (client: CanvasClient) =>
    renderHook(() => useContentSelection(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <CanvasClientProvider client={client}>
          <ContentSelectionProvider>{children}</ContentSelectionProvider>
        </CanvasClientProvider>
      ),
    });

  test("a caret posts the selection, then fetches its caret; a collapsed one has no rects", async () => {
    const c = contentClient();
    const { result } = mount(c.client);
    act(() => result.current.setContentSelection(SEL(3, 3)));
    expect(c.sent).toEqual([SEL(3, 3)]);
    expect(result.current.contentSelectionRef.current).toEqual(SEL(3, 3));
    await act(async () => c.carets[0].resolve({ x: 3 }));
    expect(result.current.caret).toEqual({ x: 3 });
    expect(result.current.selectionRects).toEqual([]);
  });

  test("a range also fetches its selection rects", async () => {
    const c = contentClient();
    const { result } = mount(c.client);
    act(() => result.current.setContentSelection(SEL(2, 9)));
    await waitFor(() =>
      expect(result.current.selectionRects).toEqual([
        { line: 0, from: 2, to: 9 },
      ]),
    );
  });

  test("clearing the selection clears caret and rects", async () => {
    const c = contentClient();
    const { result } = mount(c.client);
    act(() => result.current.setContentSelection(SEL(1, 4)));
    await act(async () => c.carets[0].resolve({ x: 1 }));
    act(() => result.current.setContentSelection(null));
    expect(c.sent.at(-1)).toBeNull();
    expect(result.current.caret).toBeNull();
    expect(result.current.selectionRects).toEqual([]);
  });

  // Finding SH-106: the caret answer is applied whenever it arrives,
  // without checking it still belongs to the current selection. Clear the
  // selection (Escape) while the caret request is in flight and the late
  // answer puts a caret back with no selection behind it — a blinking
  // caret in a story the user has left.
  test.failing(
    "SH-106: a late caret answer for a superseded selection is dropped",
    async () => {
      const c = contentClient();
      const { result } = mount(c.client);
      act(() => result.current.setContentSelection(SEL(5, 5)));
      act(() => result.current.setContentSelection(null));
      await act(async () => c.carets[0].resolve({ x: 5 }));
      expect(result.current.contentSelection).toBeNull();
      expect(result.current.caret).toBeNull();
    },
  );
});
