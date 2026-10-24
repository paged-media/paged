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

// WP4.6 — the isolation veil: drawn while an edit context or an entered
// group is active, with the scope root's outline cut out of it, and gone
// when the scope is left.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CanvasClient,
  ElementGeometryItem,
  ElementId,
  PageId,
  WorkerToMain,
} from "@paged-media/client";

import {
  isolationDimContribution,
  isolationOutline,
  isolationScopeRoot,
  isolationVeilPath,
} from "../../src/overlays/isolation-dim";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  EditContextStackProvider,
  useEditContextStack,
  type EditContextStackValue,
} from "../../src/state/edit-context-stack";
import {
  SelectionProvider,
  useSelection,
} from "../../src/state/selection-context";

afterEach(cleanup);

const PAGE = "p1" as PageId;
const pageRects = new Map([[PAGE, { x: 0, y: 1000, w: 612, h: 792 }]]);

function geometry(id: ElementId): ElementGeometryItem {
  return {
    id,
    pageId: PAGE,
    bounds: [100, 50, 200, 150],
    itemTransform: [1, 0, 0, 1, 10, 0],
  } as ElementGeometryItem;
}

function fakeClient() {
  const listeners = new Set<(m: WorkerToMain) => void>();
  const asked: ElementId[][] = [];
  const client = {
    subscribe(fn: (m: WorkerToMain) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async elementGeometry(ids: ElementId[]) {
      asked.push(ids);
      return ids.map(geometry);
    },
    async collection() {
      return [];
    },
  };
  return {
    client: client as unknown as CanvasClient,
    asked,
    emit: (m: WorkerToMain) => listeners.forEach((l) => l(m)),
  };
}

function mount() {
  const fake = fakeClient();
  let stack: EditContextStackValue | null = null;
  let selection: ReturnType<typeof useSelection> | null = null;
  const Render = isolationDimContribution.render;
  function Probe() {
    stack = useEditContextStack();
    selection = useSelection();
    return null;
  }
  const view = render(
    <CanvasClientProvider client={fake.client}>
      <SelectionProvider>
        <EditContextStackProvider>
          <Probe />
          <svg>
            <Render
              paged={null as never}
              camera={{ scale: 1, tx: 0, ty: 0 }}
              pageRects={pageRects}
            />
          </svg>
        </EditContextStackProvider>
      </SelectionProvider>
    </CanvasClientProvider>,
  );
  const veil = () => view.container.querySelector("[data-isolation-dim]");
  return { ...fake, stack: () => stack!, selection: () => selection!, veil };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("isolation dimming", () => {
  test("the scope root: the edit context's, else the entered group", () => {
    const frame = { kind: "polygon", id: "u1" } as ElementId;
    expect(isolationScopeRoot(frame, "g1")).toBe(frame);
    expect(isolationScopeRoot(null, "g1")).toEqual({ kind: "group", id: "g1" });
    expect(isolationScopeRoot(null, null)).toBeNull();
  });

  test("the hole is the root's outline in document space; the veil cuts it out", () => {
    const hole = isolationOutline(
      geometry({ kind: "rectangle", id: "r" } as ElementId),
      pageRects,
    )!;
    expect(hole).toEqual([
      [60, 1100],
      [160, 1100],
      [160, 1200],
      [60, 1200],
    ]);
    expect(isolationVeilPath(hole)).toContain(
      "M60,1100L160,1100L160,1200L60,1200Z",
    );
    expect(
      isolationOutline(
        {
          ...geometry({ kind: "rectangle", id: "r" } as ElementId),
          pageId: null,
        },
        pageRects,
      ),
    ).toBeNull();
  });

  test("an entered group veils everything else; leaving it lifts the veil", async () => {
    const h = mount();
    await settle();
    expect(h.veil()).toBeNull();
    await act(() => h.selection().setActiveGroup("g1"));
    await settle();
    const veil = h.veil()!;
    expect(veil.getAttribute("data-isolation-dim")).toBe("group:g1");
    expect(veil.getAttribute("fill-rule")).toBe("evenodd");
    expect(veil.getAttribute("pointer-events")).toBe("none");
    expect((veil as SVGElement).style.fill).toBe(
      "var(--overlay-isolation-dim)",
    );
    expect(h.asked.at(-1)).toEqual([{ kind: "group", id: "g1" }]);
    await act(() => h.selection().setActiveGroup(null));
    await settle();
    expect(h.veil()).toBeNull();
  });

  test("an edit context veils outside its scope root, and follows edits", async () => {
    const h = mount();
    const frame = { kind: "polygon", id: "u7" } as ElementId;
    await act(() => {
      h.stack().enter(
        {
          type: "vectorGraphic",
          title: "Vector",
          entry: "doubleClick",
        } as never,
        frame,
      );
    });
    await settle();
    expect(h.veil()?.getAttribute("data-isolation-dim")).toBe("polygon:u7");
    const before = h.asked.length;
    await act(() =>
      h.emit({ kind: "mutationApplied", payload: { pageIds: [] } } as never),
    );
    await settle();
    expect(h.asked.length).toBe(before + 1);
    await act(() => {
      h.stack().pop();
    });
    await settle();
    expect(h.veil()).toBeNull();
  });
});
