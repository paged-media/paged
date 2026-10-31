/*
 * This file is part of paged (https://paged.media).
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

// Free Transform of a layer (Edit ▸ Free Transform; WP5.6) through the real
// SDK adapter: the tool opens the host's transform box over the layer's
// canvas extent placed on the page, the box's page-space matrix reaches
// the session as the SAME map in image px (F⁻¹·M·F), once, on commit — and
// the session resamples through `geom.warp_projective` with the forward
// matrix, as one journaled edit. Node has no WebGPU, so the resample
// itself is pinned by the kernel's parity tests (image-conformance); this
// pins the glue.

import { describe, expect, it, vi } from "bun:test";

import { applyMatrix3, createBundleHost } from "@paged-media/plugin-sdk";
import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
  PluginManifest,
  ProjectiveMatrix,
} from "@paged-media/plugin-api";

import manifestJson from "@paged-media/image-manifest/manifest.json";

import {
  layerQuadOnPage,
  makeTransformGesture,
  pageToImageMatrix,
} from "../src/transform-tool";
import type { ImageSession } from "../src/session";
import { mapBacking, silentConsole } from "./helpers";

const TOOL = "media.paged.image.tool.transform";
const FIT = { pageId: "pg1", originX: 50, originY: 40, scale: 0.5 };

/** A 400 × 200 px image fit into a 200 × 100 pt frame at (50, 40). */
function setup() {
  const layers = new Map<string, unknown[]>();
  const tools = new Map<string, { gesture?: () => GestureHandler }>();
  let baseTool = "";
  const editor = {
    registries: {
      tools: {
        register(c: { id: string }) {
          tools.set(c.id, c as never);
          return { dispose: () => tools.delete(c.id) };
        },
      },
    },
    camera: { camera: { scale: 1, tx: 0, ty: 0 } },
    overlaySignals: {
      setToolPreview() {},
      setOverlayLayer: (k: string, s: unknown[]) => void layers.set(k, s),
      removeOverlayLayer: (k: string) => void layers.delete(k),
    },
    tool: { setBaseTool: (id: string) => void (baseTool = id) },
    client: {
      elementGeometry: async () => [
        {
          id: { kind: "rectangle", id: "f1" },
          pageId: "pg1",
          bounds: [40, 50, 140, 250],
        },
      ],
      subscribe: () => () => {},
    },
    selection: { elementSelection: [] },
  } as unknown as PagedEditor;
  const { host } = createBundleHost(
    () => editor,
    manifestJson as PluginManifest,
    {
      console: silentConsole,
      storage: mapBacking(),
    },
  );
  const transformLayer = vi.fn(async (_m: readonly number[]) => true);
  const session = {
    state: () => ({
      source: { elementId: "f1", width: 400, height: 200, handle: 1 },
    }),
    transformLayer,
  } as unknown as ImageSession;
  host.contribute.tool({
    id: TOOL,
    title: "Free transform",
    icon: "tool-freeTransform",
    group: TOOL,
    section: "transform",
    gesture: () => makeTransformGesture(host, session, TOOL),
  });
  const handler = tools.get(TOOL)!.gesture!();
  return { host, handler, transformLayer, layers, baseTool: () => baseTool };
}

const ev = (p: [number, number], cmd = false): CanvasPointerEvent => ({
  pageId: "pg1",
  pagePoint: p,
  docPoint: p,
  modifiers: { shift: false, alt: false, cmd, ctrl: false },
  maxDelta: 10,
  button: 0,
  target: null,
  pressure: 0.5,
  tiltX: 0,
  tiltY: 0,
  pointerType: "mouse",
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("image Free Transform glue [image.editor.transform-warp]", () => {
  it("the page matrix seen through the fit is the same map in image px", () => {
    // A page-space scale ×2 about (50, 40) — the image's top-left — is a
    // ×2 scale about image px (0, 0).
    const m: ProjectiveMatrix = [2, 0, -50, 0, 2, -40, 0, 0, 1];
    const img = pageToImageMatrix(FIT, m);
    const [x, y] = applyMatrix3(img, [400, 200]);
    expect(x).toBeCloseTo(800);
    expect(y).toBeCloseTo(400);
    // And a pure page translate by (10, 0) pt is 20 px.
    const t = pageToImageMatrix(FIT, [1, 0, 10, 0, 1, 0, 0, 0, 1]);
    expect(applyMatrix3(t, [0, 0])[0]).toBeCloseTo(20);
  });

  it("the box opens over the layer's canvas on the page", () => {
    expect(layerQuadOnPage(FIT, 400, 200)).toEqual([
      [50, 40],
      [250, 40],
      [250, 140],
      [50, 140],
    ]);
  });

  it("activating the tool opens the host box; a corner drag and a commit resample once with the image-px matrix", async () => {
    const { host, handler, transformLayer, layers } = setup();
    handler.onActivate({} as PagedEditor);
    await settle();
    await settle();
    const box = host.transformBox.active();
    expect(box).not.toBeNull();
    expect(layers.has("media.paged.image/transformBox")).toBe(true);
    // Scale the SE corner from (250, 140) to (350, 190) — ×1.5 about NW.
    handler.onPointerDown(ev([250, 140]));
    handler.onPointerMove(ev([350, 190]));
    handler.onPointerUp(ev([350, 190]));
    expect(transformLayer).not.toHaveBeenCalled();
    box!.commit();
    expect(transformLayer).toHaveBeenCalledTimes(1);
    const m = transformLayer.mock.calls[0]![0] as ProjectiveMatrix;
    const [x, y] = applyMatrix3(m, [400, 200]);
    expect(x).toBeCloseTo(600);
    expect(y).toBeCloseTo(300);
    const [ox, oy] = applyMatrix3(m, [0, 0]);
    expect(ox).toBeCloseTo(0);
    expect(oy).toBeCloseTo(0);
  });

  it("Cmd on a corner distorts: the matrix handed over is projective", async () => {
    const { host, handler, transformLayer } = setup();
    handler.onActivate({} as PagedEditor);
    await settle();
    await settle();
    handler.onPointerDown(ev([250, 140], true));
    handler.onPointerMove(ev([270, 170], true));
    handler.onPointerUp(ev([270, 170], true));
    host.transformBox.active()!.commit();
    const m = transformLayer.mock.calls[0]![0] as ProjectiveMatrix;
    expect(Math.abs(m[6]) + Math.abs(m[7])).toBeGreaterThan(0);
    const [x, y] = applyMatrix3(m, [400, 200]);
    // (270, 170) pt is image px ((270−50)·2, (170−40)·2).
    expect(x).toBeCloseTo(440);
    expect(y).toBeCloseTo(260);
  });

  it("a press outside the box commits it; Escape-style cancel applies nothing", async () => {
    const a = setup();
    a.handler.onActivate({} as PagedEditor);
    await settle();
    await settle();
    a.handler.onPointerDown(ev([150, 90]));
    a.handler.onPointerMove(ev([170, 90]));
    a.handler.onPointerUp(ev([170, 90]));
    a.handler.onPointerDown(ev([600, 600]));
    expect(a.transformLayer).toHaveBeenCalledTimes(1);

    const b = setup();
    b.handler.onActivate({} as PagedEditor);
    await settle();
    await settle();
    b.host.transformBox.active()!.cancel();
    expect(b.transformLayer).not.toHaveBeenCalled();
  });
});
