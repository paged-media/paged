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

// Extensions ADR 340 — an edit context's WORKSPACE drives the host's own
// rulers, guides and grid: the rulers count from the context's origin in
// its unit, its guides draw across it and a drag out of a ruler creates
// one through the provider (not on the spread), and the grid covers it at
// the image's resolution.

import type { OverlayProps } from "../../src/registries/overlay";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  Camera,
  CanvasClient,
  DocumentHandle,
  PageId,
} from "@paged-media/client";

import {
  BindingProviderProvider,
  type ShellBindingProviderHost,
  type ShellGuideEdit,
  type ShellWorkspace,
  type ShellWorkspaceView,
} from "../../src/catalog/binding-providers";
import { GuideDragController } from "../../src/cockpit/canvas-frame/GuideDragController";
import { HRuler } from "../../src/cockpit/canvas-frame/Rulers";
import { gridOverlayContribution } from "../../src/overlays/grid-overlay";
import { guideOverlayContribution } from "../../src/overlays/guide-overlay";
import { CameraProvider, useCamera } from "../../src/state/camera-context";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  baseToPage,
  pageToBase,
  ptPerRulerUnit,
  snapToGuideStep,
  workspaceDocRect,
  workspaceGridEvery,
} from "../../src/state/context-workspace";
import {
  DocumentProvider,
  useDocument,
} from "../../src/state/document-context";
import { detachedEditorScope } from "../../src/state/editor-scope";
import {
  GuideDragProvider,
  useGuideDrag,
} from "../../src/state/guide-drag-context";
import { setViewToggle } from "../../src/state/view-toggles";

afterEach(() => {
  cleanup();
  setViewToggle(detachedEditorScope(), "showGrid", false);
});

const PAGE = "p1" as PageId;

/** A 400×200 px image at 0.5 pt per pixel, 100 pt from the page's left. */
const WS: ShellWorkspace = {
  pageId: PAGE,
  origin: [100, 50],
  ptPerBase: 0.5,
  size: [400, 200],
  unit: { label: "px", basePerUnit: 1 },
  basePerPoint: 300 / 72,
  guideStep: 1,
  guides: [
    { id: "g0", orientation: "vertical", position: 40 },
    { id: "g1", orientation: "horizontal", position: 10 },
  ],
  guidesVisible: true,
  guidesLocked: false,
};

function fakeHost(ws: ShellWorkspace | null, edits: ShellGuideEdit[] = []) {
  const views: ShellWorkspaceView[] = [];
  const host = {
    activeProviders: () => [],
    readProperty: async () => ({ resolved: false, reason: "" }),
    writeProperty: async () => ({ handled: false, reason: "" }),
    readCollection: async () => ({ resolved: false, reason: "" }),
    applyMutation: async () => ({ handled: false, reason: "" }),
    onDidChange: () => ({ dispose() {} }),
    readWorkspace: async () =>
      ws
        ? { resolved: true, provider: "p", elementId: "e", workspace: ws }
        : { resolved: false, reason: "none" },
    editGuide: async (edit: ShellGuideEdit) => {
      edits.push(edit);
      return { handled: true, provider: "p", outcome: { applied: true } };
    },
    setWorkspaceView: (v: ShellWorkspaceView) => views.push(v),
    readReadouts: async () => ({ resolved: false, reason: "" }),
  } as unknown as ShellBindingProviderHost;
  return { host, views };
}

const HANDLE = {
  pageIds: [PAGE],
  pageSizesPt: [[612, 792]],
} as unknown as DocumentHandle;

function Setup({ camera, children }: { camera: Camera; children: ReactNode }) {
  const { setCamera, setViewportSize } = useCamera();
  const { setHandle } = useDocument();
  useEffect(() => {
    setViewportSize([1400, 900]);
    setCamera(camera);
    setHandle(HANDLE);
  }, [camera, setCamera, setViewportSize, setHandle]);
  return <>{children}</>;
}

const client = {
  setCamera() {},
  subscribe: () => () => {},
  collection: async () => [],
  mutate: async () => ({ kind: "mutationApplied" }),
} as unknown as CanvasClient;

function mount(
  host: ShellBindingProviderHost,
  children: ReactNode,
  camera: Camera = { scale: 1, tx: 0, ty: 0 },
) {
  return render(
    <CanvasClientProvider client={client}>
      <CameraProvider>
        <DocumentProvider>
          <BindingProviderProvider host={host}>
            <GuideDragProvider>
              <Setup camera={camera}>{children}</Setup>
            </GuideDragProvider>
          </BindingProviderProvider>
        </DocumentProvider>
      </CameraProvider>
    </CanvasClientProvider>,
  );
}

const pageRects = new Map([[PAGE, { x: 0, y: 0, w: 612, h: 792 }]]);
const overlayProps = {
  camera: { scale: 1, tx: 0, ty: 0 },
  pageRects,
} as unknown as OverlayProps;

describe("the workspace geometry", () => {
  test("maps base units to the page and the document, and rounds guides", () => {
    expect(workspaceDocRect(WS, { x: 0, y: 1000, w: 612, h: 792 })).toEqual({
      x: 100,
      y: 1050,
      w: 200,
      h: 100,
    });
    expect(
      ptPerRulerUnit({ ...WS, unit: { label: "in", basePerUnit: 300 } }),
    ).toBe(150);
    expect(pageToBase(WS, "x", 120)).toBe(40);
    expect(baseToPage(WS, "y", 10)).toBe(55);
    expect(snapToGuideStep(WS, 40.4)).toBe(40);
    expect(snapToGuideStep({ ...WS, guideStep: 0.5 }, 40.3)).toBe(40.5);
    expect(workspaceGridEvery(WS, 72)).toBeCloseTo(300, 9);
  });
});

describe("the rulers measure the workspace", () => {
  test("zero at the workspace's origin, counting in its unit", async () => {
    const { host } = fakeHost(WS);
    const { container } = mount(host, <HRuler />);
    await act(async () => {});
    const ruler = container.querySelector<HTMLElement>("[data-h-ruler]")!;
    expect(ruler.dataset["rulerUnit"]).toBe("px");
    const marks = [
      ...container.querySelectorAll<HTMLElement>("[data-ruler-mark]"),
    ].map((el) => [Number(el.dataset["rulerMark"]), parseFloat(el.style.left)]);
    // Base 0 is at document x 100; 100 px span 50 pt.
    expect(marks.find(([v]) => v === 0)?.[1]).toBe(100);
    expect(marks.find(([v]) => v === 100)?.[1]).toBe(150);
  });

  test("without a workspace the rulers stay the page's", async () => {
    const { host } = fakeHost(null);
    const { container } = mount(host, <HRuler />);
    await act(async () => {});
    const ruler = container.querySelector<HTMLElement>("[data-h-ruler]")!;
    expect(ruler.dataset["rulerUnit"]).toBeUndefined();
    const zero = container.querySelector<HTMLElement>('[data-ruler-mark="0"]')!;
    expect(parseFloat(zero.style.left)).toBe(0);
  });
});

describe("the context's guides", () => {
  const Render = guideOverlayContribution.render;

  test("draw across the workspace, with grab lines unless locked", async () => {
    const { host } = fakeHost(WS);
    const { container } = mount(
      host,
      <svg>
        <Render {...overlayProps} />
      </svg>,
    );
    await act(async () => {});
    const v = container.querySelector('[data-workspace-guide="vertical"]')!;
    // x = page 0 + origin 100 + 40 px × 0.5 pt; spans the image's height.
    expect([
      v.getAttribute("x1"),
      v.getAttribute("y1"),
      v.getAttribute("y2"),
    ]).toEqual(["120", "50", "150"]);
    const h = container.querySelector('[data-workspace-guide="horizontal"]')!;
    expect(h.getAttribute("y1")).toBe("55");
    expect(
      container.querySelectorAll("[data-workspace-guide-hit]"),
    ).toHaveLength(2);
  });

  test("locked guides have no grab line; hidden ones do not draw", async () => {
    const locked = fakeHost({ ...WS, guidesLocked: true }).host;
    const a = mount(
      locked,
      <svg>
        <Render {...overlayProps} />
      </svg>,
    );
    await act(async () => {});
    expect(a.container.querySelectorAll("[data-workspace-guide]")).toHaveLength(
      2,
    );
    expect(
      a.container.querySelectorAll("[data-workspace-guide-hit]"),
    ).toHaveLength(0);
    cleanup();
    const hidden = fakeHost({ ...WS, guidesVisible: false }).host;
    const b = mount(
      hidden,
      <svg>
        <Render {...overlayProps} />
      </svg>,
    );
    await act(async () => {});
    expect(b.container.querySelectorAll("[data-workspace-guide]")).toHaveLength(
      0,
    );
  });

  test("a guide dragged out of the ruler is created in the context, in base units", async () => {
    const edits: ShellGuideEdit[] = [];
    const { host } = fakeHost(WS, edits);
    const ref: { begin: ((o: "vertical", t: "workspace") => void) | null } = {
      begin: null,
    };
    function Probe() {
      const gd = useGuideDrag();
      useEffect(() => {
        ref.begin = (o, t) => gd.beginCreate(o, t);
      });
      return <div data-paged-viewport="" />;
    }
    mount(
      host,
      <>
        <Probe />
        <GuideDragController />
      </>,
    );
    await act(async () => {});
    await act(async () => ref.begin!("vertical", "workspace"));
    // Document x 150.3 → page-local 150.3 → (150.3 − 100) / 0.5 = 100.6 px.
    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          clientX: 150.3,
          clientY: 100,
        }) as never,
      );
      window.dispatchEvent(
        new MouseEvent("pointerup", { clientX: 150.3, clientY: 100 }) as never,
      );
    });
    expect(edits).toEqual([
      { kind: "create", orientation: "vertical", position: 101 },
    ]);
  });
});

describe("the grid covers the workspace", () => {
  test("from its origin, the physical spacing at its resolution", async () => {
    setViewToggle(detachedEditorScope(), "showGrid", true);
    const { host } = fakeHost(WS);
    const Render = gridOverlayContribution.render;
    const { container } = mount(
      host,
      <svg>
        <Render {...overlayProps} />
      </svg>,
    );
    await act(async () => {});
    const g = container.querySelector<SVGGElement>("[data-workspace-grid]")!;
    expect(g).not.toBeNull();
    // 72 pt every / 8 subdivisions = 9 pt → 37.5 px at 300 ppi → 18.75 pt.
    expect(Number(g.getAttribute("data-grid-step"))).toBeCloseTo(18.75, 9);
    // The page the workspace lies on draws no page grid of its own.
    expect(container.querySelector('[data-document-grid="p1"]')).toBeNull();
  });
});
