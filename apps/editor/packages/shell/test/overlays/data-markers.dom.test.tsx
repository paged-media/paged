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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Editor ADR 291 — the data field markers: nothing drawn or read while
// View ▸ Show data markers is off; on, a bracket on every frame the data is
// placed in, stroked in its binding's sync state (the worst of several),
// and redrawn when the data changes.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CanvasClient,
  ElementGeometryItem,
  ElementId,
  PageId,
} from "@paged-media/client";
import type {
  DataChange,
  DataPlacement,
  DataService,
} from "@paged-media/plugin-api";

import {
  dataMarkersContribution,
  elementOfPlacement,
  markersOf,
} from "../../src/overlays/data-markers";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import { setDataDoorSource } from "../../src/state/data-door";
import {
  createEditorScope,
  EditorScopeProvider,
} from "../../src/state/editor-scope";
import { setViewToggle } from "../../src/state/view-toggles";

afterEach(cleanup);

const PAGE = "p1" as PageId;
const pageRects = new Map([[PAGE, { x: 0, y: 1000, w: 612, h: 792 }]]);

function fakeClient() {
  const asked: ElementId[][] = [];
  const client = {
    subscribe: () => () => undefined,
    async elementGeometry(ids: ElementId[]) {
      asked.push(ids);
      return ids.map(
        (id) =>
          ({
            id,
            pageId: PAGE,
            bounds: [100, 50, 200, 150],
            itemTransform: [1, 0, 0, 1, 0, 0],
          }) as ElementGeometryItem,
      );
    },
  };
  return { client: client as unknown as CanvasClient, asked };
}

function mount(initial: DataPlacement[]) {
  let placements = initial;
  let reads = 0;
  const service: DataService = {
    tables: () => [],
    records: async () => ({ schema: { fields: [] }, columns: [], rowCount: 0 }),
    async placements() {
      reads++;
      return placements;
    },
  };
  const changeListeners = new Set<(c: DataChange) => void>();
  const scope = createEditorScope();
  setDataDoorSource(scope, {
    current: () => ({ service }),
    onDidChange(l) {
      changeListeners.add(l);
      return { dispose: () => changeListeners.delete(l) };
    },
    onDidChangeService: () => ({ dispose() {} }),
  });
  const fake = fakeClient();
  const Render = dataMarkersContribution.render;
  const view = render(
    <EditorScopeProvider scope={scope}>
      <CanvasClientProvider client={fake.client}>
        <svg>
          <Render
            paged={null as never}
            camera={{ scale: 1, tx: 0, ty: 0 }}
            pageRects={pageRects}
          />
        </svg>
      </CanvasClientProvider>
    </EditorScopeProvider>,
  );
  const layer = () => view.container.querySelector("[data-data-markers]");
  const markers = () =>
    [...view.container.querySelectorAll("[data-data-marker]")].map((m) => [
      m.getAttribute("data-data-marker"),
      m.getAttribute("data-tone"),
      m.getAttribute("stroke"),
    ]);
  return {
    scope,
    layer,
    markers,
    asked: fake.asked,
    reads: () => reads,
    view,
    set(next: DataPlacement[]) {
      placements = next;
      for (const l of changeListeners) l({ table: "q", revision: "2" });
    },
  };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("data field markers [editor-shell.data-panel]", () => {
  test("an address names a page item, or nothing", () => {
    expect(elementOfPlacement("rectangle:u12")).toEqual({
      kind: "rectangle",
      id: "u12",
    });
    expect(elementOfPlacement("textFrame:u3")).toEqual({
      kind: "textFrame",
      id: "u3",
    });
    expect(elementOfPlacement("story:u1@0..4")).toBeNull();
    expect(elementOfPlacement("rectangle[label=x]")).toBeNull();
  });

  test("a frame several bindings place into takes the worst state", () => {
    const m = markersOf([
      { binding: "a", address: "rectangle:u1", status: "linked" },
      { binding: "b", address: "rectangle:u1", status: "stale" },
      { binding: "c", address: "textFrame:u2", status: "pinned" },
      { binding: "d", address: "textFrame:u2", status: "error" },
      { binding: "e", address: "oval:u3", status: "linked" },
    ]);
    expect([...m].map(([k, v]) => [k, v.tone])).toEqual([
      ["rectangle:u1", "warn"],
      ["textFrame:u2", "error"],
      ["oval:u3", "ok"],
    ]);
  });

  test("off: nothing drawn, nothing read; on: brackets in the status colours", async () => {
    const h = mount([
      { binding: "a", address: "rectangle:u1", status: "linked" },
      { binding: "b", address: "textFrame:u2", status: "overridden" },
      { binding: "c", address: "oval:u3", status: "error" },
      { binding: "d", address: "story:u9@0..3", status: "linked" },
    ]);
    await settle();
    expect(h.layer()?.getAttribute("data-data-markers")).toBe("off");
    expect(h.reads()).toBe(0);
    expect(h.asked).toEqual([]);

    await act(async () => setViewToggle(h.scope, "dataMarkers", true));
    await settle();
    expect(h.layer()?.getAttribute("data-data-markers")).toBe("ready");
    expect(h.markers()).toEqual([
      ["rectangle:u1", "ok", "var(--status-approved)"],
      ["textFrame:u2", "warn", "var(--status-review)"],
      ["oval:u3", "error", "var(--status-error)"],
    ]);
    // The story range is no page item: only the three frames are asked for.
    expect(h.asked.at(-1)?.map((id) => `${id.kind}:${String(id.id)}`)).toEqual([
      "rectangle:u1",
      "textFrame:u2",
      "oval:u3",
    ]);
    // Four brackets, on the frame's page-space corners (page at y 1000).
    const d = h.view.container
      .querySelector("[data-data-marker='rectangle:u1']")!
      .getAttribute("d")!;
    expect(d.match(/M/g)?.length).toBe(4);
    expect(d).toContain("L50 1100");
    expect(d).toContain("L150 1200");

    // The data changes: the markers follow.
    await act(async () =>
      h.set([{ binding: "a", address: "rectangle:u1", status: "stale" }]),
    );
    await settle();
    expect(h.markers()).toEqual([
      ["rectangle:u1", "warn", "var(--status-review)"],
    ]);

    await act(async () => setViewToggle(h.scope, "dataMarkers", false));
    await settle();
    expect(h.layer()?.getAttribute("data-data-markers")).toBe("off");
  });
});
