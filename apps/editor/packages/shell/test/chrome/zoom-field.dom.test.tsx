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

// The zoom field (interaction contract §13.2, UXI-CAM-007; editor ADR
// "Navigation history and one current page"): a typed percentage zooms
// about the viewport's centre inside the one range and reads back
// normalised; Escape restores the live value; a typed zoom is not a
// navigation, so Back has nothing new to return to.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import type { Camera, CanvasClient } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import { ZoomControl } from "../../src/chrome/ZoomControl";
import { CameraProvider, useCamera } from "../../src/state/camera-context";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  createEditorScope,
  EditorScopeProvider,
} from "../../src/state/editor-scope";
import { RegistriesProvider } from "../../src/state/registries-context";

afterEach(() => cleanup());

const VIEW: [number, number] = [1000, 800];

function mount(start: Camera) {
  const seen: { camera: Camera; back: number } = { camera: start, back: 0 };
  function Probe() {
    const { camera, setCamera, setViewportSize, navigation } = useCamera();
    useEffect(() => {
      setViewportSize(VIEW);
      setCamera(start);
    }, [setCamera, setViewportSize]);
    seen.camera = camera;
    seen.back = navigation.state().back;
    return null;
  }
  const client = { setCamera() {} } as unknown as CanvasClient;
  const scope = createEditorScope();
  const view = render(
    <EditorScopeProvider scope={scope}>
      <RegistriesProvider getEditor={() => ({ scope })}>
        <CanvasClientProvider client={client}>
          <CameraProvider>
            <Probe />
            <ZoomControl />
          </CameraProvider>
        </CanvasClientProvider>
      </RegistriesProvider>
    </EditorScopeProvider>,
  );
  const field =
    view.container.querySelector<HTMLInputElement>("[data-zoom-field]")!;
  return { view, field, seen };
}

/** The document point at the viewport's centre. */
const centre = (c: Camera): [number, number] => [
  (VIEW[0] / 2 - c.tx) / c.scale,
  (VIEW[1] / 2 - c.ty) / c.scale,
];

async function type(field: HTMLInputElement, text: string, key = "Enter") {
  await act(async () => {
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: text } });
    fireEvent.keyDown(field, { key });
  });
}

describe("the zoom field", () => {
  test("UXI-T48 — a typed percentage zooms about the centre inside the one range and reads back normalised @feat:editor-tools.nav.zoom @level:edge", async () => {
    covers("command:paged.view.zoom100");
    const { field, seen } = mount({ scale: 0.5, tx: 100, ty: 50 });
    await act(async () => {});
    expect(field.value).toBe("50%");
    const before = centre(seen.camera);

    await type(field, "150");
    expect(seen.camera.scale).toBe(1.5);
    const after = centre(seen.camera);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(field.value).toBe("150%");

    await type(field, "9000 %");
    expect(seen.camera.scale).toBe(40);
    expect(field.value).toBe("4000%");

    await type(field, "1");
    expect(seen.camera.scale).toBe(0.05);
    expect(field.value).toBe("5%");

    // Not a number: nothing changes, the field shows the live zoom.
    await type(field, "abc");
    expect(seen.camera.scale).toBe(0.05);
    expect(field.value).toBe("5%");

    // A typed zoom is a zoom, not a navigation.
    expect(seen.back).toBe(0);
  });

  test("Escape restores the live value without zooming", async () => {
    const { field, seen } = mount({ scale: 2, tx: 0, ty: 0 });
    await act(async () => {});
    await type(field, "300", "Escape");
    expect(field.value).toBe("200%");
    expect(seen.camera.scale).toBe(2);
  });
});
