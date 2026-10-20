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

// The top ruler as drawn (UX audit F-31, ADR 263): at the least zoom
// the labels are thinned so none runs into the next, and the numbers
// left of the origin read with their minus sign.

import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import type { Camera, CanvasClient } from "@paged-media/client";

import { HRuler } from "../../src/cockpit/canvas-frame/Rulers";
import {
  RULER_LABEL_GAP,
  RULER_LABEL_INSET,
  rulerLabelWidth,
} from "../../src/cockpit/canvas-frame/ruler-marks";
import { CameraProvider, useCamera } from "../../src/state/camera-context";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";

afterEach(() => cleanup());

function View({ camera }: { camera: Camera }) {
  const { setCamera, setViewportSize } = useCamera();
  useEffect(() => {
    setViewportSize([1400, 900]);
    setCamera(camera);
  }, [camera, setCamera, setViewportSize]);
  return <HRuler />;
}

function mount(camera: Camera) {
  const client = { setCamera() {} } as unknown as CanvasClient;
  return render(
    <CanvasClientProvider client={client}>
      <CameraProvider>
        <View camera={camera} />
      </CameraProvider>
    </CanvasClientProvider>,
  );
}

function marks(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-ruler-mark]")].map(
    (el) => ({
      value: Number(el.dataset["rulerMark"]),
      px: parseFloat(el.style.left),
      label: el.querySelector("[data-ruler-label]")?.textContent ?? null,
    }),
  );
}

describe("the top ruler (F-31)", () => {
  test("at 5 % the labels are thinned so none overlaps the next", async () => {
    const { container } = mount({ scale: 0.05, tx: 600, ty: 0 });
    await act(async () => {});
    const m = marks(container);
    expect(m.length).toBeGreaterThan(2);
    for (let i = 1; i < m.length; i++) {
      expect(m[i]!.px - m[i - 1]!.px).toBeGreaterThanOrEqual(
        RULER_LABEL_INSET + rulerLabelWidth(m[i - 1]!.value) + RULER_LABEL_GAP,
      );
    }
    // Left of the origin the numbers carry their minus sign.
    const negative = m.filter((x) => x.value < 0 && x.label !== null);
    expect(negative.length).toBeGreaterThan(0);
    for (const x of negative) expect(x.label!.startsWith("−")).toBe(true);
  });

  test("at 100 % the step is fine-grained again", async () => {
    const { container } = mount({ scale: 1, tx: 40, ty: 0 });
    await act(async () => {});
    const m = marks(container);
    expect(m[1]!.value - m[0]!.value).toBeLessThanOrEqual(100);
    expect(m.find((x) => x.value === 0)?.label).toBe("0");
  });
});
