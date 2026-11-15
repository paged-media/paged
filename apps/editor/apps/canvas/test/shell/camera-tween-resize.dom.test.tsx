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

// A page jump and a resize (interaction contract UXI-CAM-003 with
// UXI-CAM-004; editor ADR "Navigation history and one current page"). A
// tween yields to whoever moves the camera next, but a resize anchor does
// not take the camera: it moves the view by a translation, and the tween
// moves its whole path by the same shift and arrives. A slide show's Esc
// asked for the slide it ended on while the chrome came back; the anchor's
// write stopped the jump half way, on another slide.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import type { Camera, CanvasClient } from "@paged-media/client";
import {
  CameraProvider,
  CanvasClientProvider,
  createEditorScope,
  EditorScopeProvider,
  RegistriesProvider,
  useCamera,
} from "@paged-media/shell";

import { useCameraTween } from "../../src/ui/useAnimatedCamera";

// Frames on `performance.now()`'s timeline, as a browser's are (happy-dom
// stamps its frames from another clock, and a tween read them as done).
const frames = {
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
};
beforeEach(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
});
afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = frames.raf;
  globalThis.cancelAnimationFrame = frames.caf;
});

const VIEW = [1000, 800] as const;
const START: Camera = { scale: 1, tx: 0, ty: 0 };
const TARGET: Camera = { scale: 2, tx: -600, ty: -400 };

type Api = ReturnType<typeof useCamera> & ReturnType<typeof useCameraTween>;

function mount() {
  const api: { current: Api | null } = { current: null };
  function Probe() {
    const camera = useCamera();
    const tween = useCameraTween(camera.camera, camera.setCamera);
    const { setCamera, setViewportSize } = camera;
    useEffect(() => {
      setViewportSize(VIEW);
      setCamera(START);
    }, [setCamera, setViewportSize]);
    api.current = { ...camera, ...tween };
    return null;
  }
  const client = { setCamera() {} } as unknown as CanvasClient;
  const scope = createEditorScope();
  render(
    <EditorScopeProvider scope={scope}>
      <RegistriesProvider getEditor={() => ({ scope })}>
        <CanvasClientProvider client={client}>
          <CameraProvider>
            <Probe />
          </CameraProvider>
        </CanvasClientProvider>
      </RegistriesProvider>
    </EditorScopeProvider>,
  );
  return () => api.current!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the jump and let a frame or two of it run. */
async function jumpPartWay(api: () => Api) {
  await act(async () => {
    api().animateTo(TARGET, { durationMs: 240 });
  });
  await act(async () => {
    await sleep(60);
  });
  // The jump is in flight: neither where it started nor where it goes.
  const mid = api().peekCamera();
  expect(mid.scale).toBeGreaterThan(START.scale);
  expect(mid.scale).toBeLessThan(TARGET.scale);
}

describe("a page jump and a resize", () => {
  test("the chrome coming back during a jump moves the jump; it still arrives", async () => {
    const api = mount();
    await jumpPartWay(api);
    // The docks come back: the canvas narrows by 400 px, and the anchor
    // keeps its centre (a translation by half the change).
    await act(async () => {
      api().setViewportSize([600, 800]);
      api().anchorViewportResize(VIEW, [600, 800]);
    });
    expect(api().destination()).toMatchObject({ scale: 2, tx: -800, ty: -400 });
    await act(async () => {
      await sleep(400);
    });
    const cam = api().peekCamera();
    expect(cam.scale).toBeCloseTo(TARGET.scale, 9);
    expect(cam.tx).toBeCloseTo(TARGET.tx - 200, 6);
    expect(cam.ty).toBeCloseTo(TARGET.ty, 6);
    // The document point the jump meant to centre is at the new centre.
    expect((300 - cam.tx) / cam.scale).toBeCloseTo((500 - TARGET.tx) / 2, 6);
  });

  test("someone else moving the camera during a jump still takes it", async () => {
    const api = mount();
    await jumpPartWay(api);
    const theirs: Camera = { scale: 1.5, tx: 10, ty: 20 };
    await act(async () => {
      api().setCamera(theirs);
    });
    await act(async () => {
      await sleep(400);
    });
    expect(api().peekCamera()).toMatchObject(theirs);
  });

  test("the viewport's size reads at once, before React renders it", async () => {
    const api = mount();
    await act(async () => {
      await sleep(0);
    });
    api().setViewportSize([640, 480]);
    expect(api().peekViewportSize()).toEqual([640, 480]);
  });
});
