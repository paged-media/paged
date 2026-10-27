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

// WP5.8 as components (the DOM lane): the Content-Aware Fill workspace
// draws its sampling, fill and output settings and its preview, and what a
// control says is what reaches the session; the Clone Source panel shows
// five sources, the active one's transform and the overlay options; the
// Content-Aware Move / Healing section and its pending transform.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import {
  CloneSourceBody,
  ContentAwareFillWorkspace,
  makeCloneSourcePanel,
  RetouchOptionsSection,
} from "../src/panels/sections/retouch-sections";
import { DEFAULT_CAF, initialRetouch, type CafWorkspace } from "../src/retouch";
import type { ImageSession } from "../src/session";

afterEach(() => cleanup());

const caf = (over: Partial<CafWorkspace> = {}): CafWorkspace => ({
  ...DEFAULT_CAF,
  fill: { ...DEFAULT_CAF.fill },
  preview: null,
  previewNote: null,
  sampledFraction: 0.25,
  ...over,
});

const q = (root: HTMLElement, sel: string) =>
  root.querySelector(sel) as HTMLInputElement;

describe("the Content-Aware Fill workspace", () => {
  it("hands every setting to the session and shows the preview", () => {
    const onChange = mock((_p: unknown) => {});
    const onOk = mock(() => {});
    const onCancel = mock(() => {});
    const onReset = mock(() => {});
    const view = render(
      <ContentAwareFillWorkspace
        caf={caf({
          preview: {
            x: 0,
            y: 0,
            regionW: 8,
            regionH: 4,
            width: 4,
            height: 2,
            rgba: new Uint8Array(32),
          },
        })}
        busy={false}
        onChange={onChange}
        onReset={onReset}
        onOk={onOk}
        onCancel={onCancel}
      />,
    );
    const root = view.container;
    expect(q(root, "[data-image-caf-sampled]").textContent).toContain("25");
    fireEvent.click(q(root, '[data-image-caf-sampling="rect"]'));
    expect(onChange).toHaveBeenLastCalledWith({ sampling: "rect" });
    fireEvent.change(q(root, "[data-image-caf-colour]"), {
      target: { value: "very-high" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      fill: { colour: "very-high" },
    });
    fireEvent.change(q(root, "[data-image-caf-rotation]"), {
      target: { value: "full" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ fill: { rotation: "full" } });
    fireEvent.click(q(root, "[data-image-caf-scale]"));
    expect(onChange).toHaveBeenLastCalledWith({ fill: { scale: true } });
    fireEvent.click(q(root, "[data-image-caf-mirror]"));
    expect(onChange).toHaveBeenLastCalledWith({ fill: { mirror: true } });
    fireEvent.change(q(root, "[data-image-caf-output]"), {
      target: { value: "new-layer" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ output: "new-layer" });
    fireEvent.click(q(root, "[data-image-caf-sample-all]"));
    expect(onChange).toHaveBeenLastCalledWith({ sampleAll: true });
    fireEvent.change(q(root, "[data-image-caf-opacity]"), {
      target: { value: "30" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ overlayOpacity: 0.3 });
    fireEvent.click(q(root, "[data-image-caf-show]"));
    expect(onChange).toHaveBeenLastCalledWith({ showSampling: false });
    const canvas = q(root, "[data-image-caf-preview]");
    expect(canvas.getAttribute("data-width")).toBe("4");
    fireEvent.click(q(root, "[data-image-caf-ok]"));
    fireEvent.click(q(root, "[data-image-caf-cancel]"));
    fireEvent.click(q(root, "[data-image-caf-reset]"));
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("says why there is no preview", () => {
    const view = render(
      <ContentAwareFillWorkspace
        caf={caf({ previewNote: "No preview: nothing to fill from" })}
        busy
        onChange={() => {}}
        onReset={() => {}}
        onOk={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      q(view.container, "[data-image-caf-no-preview]").textContent,
    ).toContain("nothing to fill from");
    expect(q(view.container, "[data-image-caf-ok]").disabled).toBe(true);
  });
});

describe("the Clone Source panel", () => {
  it("five sources, the active one's transform, the overlay and the sample", () => {
    const cs = initialRetouch().cloneSource;
    cs.slots[1] = { ...cs.slots[1], anchor: [12, 7], scaleW: -100 };
    cs.active = 1;
    const onSelect = mock((_i: number) => {});
    const onSlot = mock((_i: number, _p: unknown) => {});
    const onOverlay = mock((_p: unknown) => {});
    const onSample = mock((_s: string) => {});
    const onReset = mock((_i: number) => {});
    const view = render(
      <CloneSourceBody
        cs={cs}
        aligned
        busy={false}
        onSelect={onSelect}
        onSlot={onSlot}
        onReset={onReset}
        onOverlay={onOverlay}
        onSample={onSample}
        onAligned={() => {}}
      />,
    );
    const root = view.container;
    expect(root.querySelectorAll("[data-image-clone-slot]")).toHaveLength(5);
    expect(q(root, "[data-image-clone-slot-anchor]").textContent).toBe("12, 7");
    expect(q(root, "[data-image-clone-flip-h]").checked).toBe(true);
    fireEvent.click(q(root, '[data-image-clone-slot="3"]'));
    expect(onSelect).toHaveBeenLastCalledWith(3);
    fireEvent.change(q(root, "[data-image-clone-angle]"), {
      target: { value: "45" },
    });
    expect(onSlot).toHaveBeenLastCalledWith(1, { angle: 45 });
    fireEvent.change(q(root, "[data-image-clone-scale-h]"), {
      target: { value: "50" },
    });
    expect(onSlot).toHaveBeenLastCalledWith(1, { scaleH: 50 });
    fireEvent.change(q(root, "[data-image-clone-offset-x]"), {
      target: { value: "9" },
    });
    expect(onSlot).toHaveBeenLastCalledWith(1, { offset: [9, 0] });
    fireEvent.click(q(root, "[data-image-clone-flip-v]"));
    expect(onSlot).toHaveBeenLastCalledWith(1, { scaleH: -100 });
    fireEvent.click(q(root, '[data-image-clone-overlay-option="invert"]'));
    expect(onOverlay).toHaveBeenLastCalledWith({ invert: true });
    fireEvent.change(q(root, "[data-image-clone-sample]"), {
      target: { value: "all" },
    });
    expect(onSample).toHaveBeenLastCalledWith("all");
    fireEvent.click(q(root, "[data-image-clone-reset]"));
    expect(onReset).toHaveBeenLastCalledWith(1);
    expect(q(root, "[data-image-clone-frame-offset]").textContent).toMatch(
      /not applicable/,
    );
  });

  it("the panel factory reads the live session", () => {
    covers("panel:media.paged.image.panel.cloneSource");
    const state = {
      retouch: initialRetouch(),
      cloneSource: { x: 3, y: 4, aligned: false },
      busy: false,
    };
    state.retouch.cloneSource.slots[0].anchor = [3, 4];
    const selected: number[] = [];
    const session = {
      state: () => state,
      onDidChange: () => ({ dispose() {} }),
      selectCloneSource: (i: number) => selected.push(i),
    } as unknown as ImageSession;
    const Panel = makeCloneSourcePanel(session);
    const view = render(<Panel />);
    expect(
      q(view.container, "[data-image-clone-slot-anchor]").textContent,
    ).toBe("3, 4");
    expect(q(view.container, "[data-image-clone-panel-aligned]").checked).toBe(
      false,
    );
    fireEvent.click(q(view.container, '[data-image-clone-slot="4"]'));
    expect(selected).toEqual([4]);
  });
});

describe("Content-Aware Move and healing options", () => {
  it("the options and the pending transform reach the session", () => {
    const r = initialRetouch();
    const onMove = mock((_p: unknown) => {});
    const onTransform = mock((_p: unknown) => {});
    const onCommit = mock(() => {});
    const onHeal = mock((_p: unknown) => {});
    const view = render(
      <RetouchOptionsSection
        move={r.move}
        pending={{ dx: 4, dy: 2, scale: 100, angle: 0 }}
        heal={r.heal}
        busy={false}
        onMove={onMove}
        onTransform={onTransform}
        onCommit={onCommit}
        onCancel={() => {}}
        onHeal={onHeal}
      />,
    );
    const root = view.container;
    fireEvent.change(q(root, "[data-image-cam-mode]"), {
      target: { value: "extend" },
    });
    expect(onMove).toHaveBeenLastCalledWith({ mode: "extend" });
    fireEvent.change(q(root, "[data-image-cam-structure]"), {
      target: { value: "6" },
    });
    expect(onMove).toHaveBeenLastCalledWith({ structure: 6 });
    fireEvent.change(q(root, "[data-image-cam-scale]"), {
      target: { value: "150" },
    });
    expect(onTransform).toHaveBeenLastCalledWith({ scale: 150 });
    fireEvent.click(q(root, "[data-image-cam-commit]"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.change(q(root, "[data-image-heal-diffusion]"), {
      target: { value: "2" },
    });
    expect(onHeal).toHaveBeenLastCalledWith({ diffusion: 2 });
    fireEvent.change(q(root, "[data-image-heal-spot]"), {
      target: { value: "create-texture" },
    });
    expect(onHeal).toHaveBeenLastCalledWith({ spotType: "create-texture" });
  });
});
