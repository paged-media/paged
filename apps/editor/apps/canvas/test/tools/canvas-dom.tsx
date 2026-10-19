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

// The canvas, mounted: PagedShell with the app's CanvasPanel in its canvas
// slot, the built-in tools on the rail, over the real engine (the test
// kit's in-process render worker, gesture SAB drain included), in
// happy-dom. Plus the gesture DSL's DOM backend: document points become
// pointer events on the viewport host (`data-testid="viewport-canvas-host"`),
// through the live camera, as a browser would deliver them.
//
// For the tools that carry no gesture handler (Selection, Direct Selection,
// Hand, Zoom): their behaviour IS the canvas's own pointer path
// (ViewportCanvas), so the unit backend over a fake editor cannot reach
// it. From main.tsx's canvas integration only `usePathEditMode` is mounted
// (Direct Selection is the Selection click plus that hook); nothing paints.
//
// happy-dom gives every element a zero box, so the viewport host sits at
// client (0, 0) and the camera is never fitted (the fit needs a size):
// it starts at the identity and a test zooms with `g.zoom(scale)`.

import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useLayoutEffect } from "react";

import {
  CanvasClient,
  GestureBuffer,
  type Camera,
  type DocumentHandle,
  type ElementId,
} from "@paged-media/client";
import {
  PagedShell,
  useCamera,
  useDocument,
  usePaged,
  useRegistries,
  useSelection,
  type ModeContribution,
  type PagedEditor,
  type ShellRegistries,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";
import {
  createGestureDsl,
  type DblclickTapeSample,
  type GestureBackend,
  type GestureDsl,
  type GesturePoint,
  type KeyTapeSample,
  type ModifierName,
  type PointerTapeSample,
  type ToolRef,
  type WheelTapeSample,
} from "@paged-media/plugin-sdk/gesture-kit";
import {
  createEngineWorker,
  headlessEngineModule,
  modelDump,
  type EngineWorker,
  type ModelDump,
} from "@paged-media/test-kit/headless";

import { CanvasPanel } from "../../src/panels/canvas-panel";
import { usePathEditMode } from "../../src/ui/usePathEditMode";
import { layoutPages } from "../../src/ui/layout";

const HOST = '[data-testid="viewport-canvas-host"]';

const MODES: ModeContribution[] = [
  { id: "design", title: "Design", icon: "mode-design", order: 0 },
];

interface Bridge {
  paged: PagedEditor;
  registries: ShellRegistries;
  camera: Camera;
  setCamera(c: Camera): void;
  elementSelection: readonly ElementId[];
  pathEditMode: boolean;
  handle: DocumentHandle | null;
}

/** What main.tsx's canvas integration mounts that these tools need, plus
 *  the document seed and a window onto the shell's state. */
function Integration({
  handle,
  onBridge,
}: {
  handle: DocumentHandle;
  onBridge(b: Bridge): void;
}) {
  usePathEditMode();
  const paged = usePaged();
  const registries = useRegistries();
  const { camera, setCamera } = useCamera();
  const { elementSelection, pathEditMode } = useSelection();
  const doc = useDocument();
  const { setHandle } = doc;
  useLayoutEffect(() => {
    setHandle(handle);
  }, [handle, setHandle]);
  useEffect(() => {
    onBridge({
      paged,
      registries,
      camera,
      setCamera,
      elementSelection,
      pathEditMode,
      handle: doc.handle,
    });
  });
  return null;
}

let stubbed = false;
/** The DOM members happy-dom lacks that the canvas calls. */
function stubDom(): void {
  if (stubbed) return;
  stubbed = true;
  const canvas = HTMLCanvasElement.prototype as unknown as Record<
    string,
    unknown
  >;
  // The worker owns the bitmap; the in-process worker ignores it.
  canvas.transferControlToOffscreen = () => ({});
  const el = Element.prototype as unknown as Record<string, unknown>;
  if (typeof el.setPointerCapture !== "function")
    el.setPointerCapture = () => {};
  if (typeof el.releasePointerCapture !== "function")
    el.releasePointerCapture = () => {};
}

export interface MountedCanvas {
  /** The gesture DSL over the DOM backend. */
  g: GestureDsl;
  client: CanvasClient;
  worker: EngineWorker;
  /** The shell's live state. */
  readonly state: Bridge;
  host(): HTMLElement;
  /** The engine and React have gone quiet. */
  settle(): Promise<void>;
  dump(): Promise<ModelDump>;
  invoke(id: string, payload?: unknown): Promise<unknown>;
  /** Page-local bounds `[top, left, bottom, right]` of an element. */
  bounds(id: ElementId): Promise<[number, number, number, number]>;
  dispose(): void;
}

export async function mountCanvas(idml: Uint8Array): Promise<MountedCanvas> {
  stubDom();
  const engines = await headlessEngineModule();
  const worker = createEngineWorker(engines.create(), {
    gestureReader: (buffer) => new GestureBuffer(buffer),
  });
  const client = new CanvasClient({
    workerFactory: () => worker as unknown as Worker,
  });
  const handle = await client.loadDocument(idml);

  let bridge: Bridge | null = null;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        panels={[]}
        tools={BUILT_IN_TOOLS}
        modes={MODES}
        initialMode="design"
        canvasComponent={CanvasPanel}
      >
        <Integration handle={handle} onBridge={(b) => (bridge = b)} />
      </PagedShell>,
    );
  });

  const state = (): Bridge => {
    if (!bridge) throw new Error("canvas harness: not mounted");
    return bridge;
  };
  const settle = async () => {
    let quiet = 0;
    for (let i = 0; i < 400 && quiet < 3; i++) {
      await act(async () => {
        await worker.idle();
        await new Promise((r) => setTimeout(r, 0));
      });
      const pending =
        (client as unknown as { pending?: Map<unknown, unknown> }).pending
          ?.size ?? 0;
      quiet = pending === 0 ? quiet + 1 : 0;
    }
  };
  await settle();
  const host = () => {
    const el = view.container.querySelector(HOST) as HTMLElement | null;
    if (!el) throw new Error("canvas harness: no viewport host");
    return el;
  };

  const pages = () => {
    const h = state().handle ?? handle;
    return layoutPages(h.pageSizesPt).map((r, i) => ({
      ...r,
      id: h.pageIds[i],
    }));
  };
  // The camera a gesture's points are mapped through, read at its press
  // and kept until the next one (as the browser backend does): a pan
  // moves the camera under the pointer, and the pointer must not follow.
  let pressCamera: Camera | null = null;
  const toClient = (pos: readonly [number, number]): [number, number] => {
    const c = (pressCamera ??= state().camera);
    return [pos[0] * c.scale + c.tx, pos[1] * c.scale + c.ty];
  };
  const modifierInit = (mods: readonly ModifierName[]) => ({
    shiftKey: mods.includes("shift"),
    altKey: mods.includes("alt"),
    metaKey: mods.includes("cmd"),
    ctrlKey: mods.includes("ctrl"),
  });
  const fire = async (event: Event, target: EventTarget = host()) => {
    await act(async () => {
      target.dispatchEvent(event);
    });
  };

  const backend: GestureBackend = {
    name: "dom",
    async tool(ref: ToolRef) {
      if (typeof ref !== "string")
        throw new Error("dom backend: mount a registered tool by id");
      const tools = state().registries.tools.list();
      const found =
        tools.find((t) => t.id === ref) ??
        tools.find((t) => t.id.endsWith(`.tool.${ref}`));
      if (!found) throw new Error(`dom backend: no tool ${ref}`);
      await act(async () => {
        await state().registries.commands.invoke(
          `paged.tool.activate.${found.id}`,
        );
      });
      await settle();
      if (state().paged.tool.effectiveTool !== found.id)
        throw new Error(`dom backend: ${found.id} did not become active`);
      return found.id;
    },
    async resolve(point: GesturePoint) {
      if (Array.isArray(point)) return [point[0], point[1]];
      const p = point as { page: string | number; at: [number, number] };
      const all = pages();
      const pg =
        typeof p.page === "number"
          ? all[p.page]
          : all.find((x) => x.id === p.page);
      if (!pg) throw new Error(`dom backend: no page ${String(p.page)}`);
      return [pg.x + p.at[0], pg.y + p.at[1]];
    },
    async cursorAt() {
      return host().style.cursor || undefined;
    },
    async scale() {
      return state().camera.scale;
    },
    async zoom(scale: number) {
      await act(async () => {
        state().setCamera({ scale, tx: 0, ty: 0 });
      });
      await settle();
      pressCamera = null;
    },
    async pointer(s: PointerTapeSample) {
      if (s.type === "pointerdown") pressCamera = null;
      const [clientX, clientY] = toClient(s.pos);
      await fire(
        new PointerEvent(s.type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: s.type === "pointermove" ? -1 : s.button,
          buttons: s.buttons,
          pointerId: s.pointerId,
          pointerType: s.device,
          pressure: s.pressure,
          ...modifierInit(s.mods),
        }),
      );
    },
    async key(s: KeyTapeSample) {
      await fire(
        new KeyboardEvent(s.type, {
          bubbles: true,
          cancelable: true,
          key: s.key,
          ...modifierInit(s.mods),
        }),
        document,
      );
    },
    async wheel(s: WheelTapeSample) {
      pressCamera = null;
      const [clientX, clientY] = toClient(s.pos);
      await fire(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          deltaX: s.deltaX,
          deltaY: s.deltaY,
          ...modifierInit(s.mods),
        }),
      );
    },
    async dblclick(s: DblclickTapeSample) {
      pressCamera = null;
      const [clientX, clientY] = toClient(s.pos);
      await fire(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          ...modifierInit(s.mods),
        }),
      );
    },
    settle,
  };

  return {
    g: createGestureDsl(backend),
    client,
    worker,
    get state() {
      return state();
    },
    host,
    settle,
    dump: () => modelDump(client.send.bind(client) as never),
    async invoke(id, payload) {
      let result: unknown;
      await act(async () => {
        result = await state().registries.commands.invoke(id, payload);
      });
      await settle();
      return result;
    },
    async bounds(id) {
      const [item] = await client.elementGeometry([id]);
      if (!item) throw new Error(`no geometry for ${JSON.stringify(id)}`);
      return item.bounds as [number, number, number, number];
    },
    dispose() {
      cleanup();
      worker.terminate();
    },
  };
}
