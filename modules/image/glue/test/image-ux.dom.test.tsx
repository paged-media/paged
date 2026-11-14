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

// Image ADR 487 in the panel: the layer rows' kind badges, the context
// toolbar's "Editing: …" chip, the filter dialog's split and quality line,
// and the pixel view at 100 %.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import "../src/activate";
import type { LayerInfo } from "../src/engine";
import { filterDef, filterDefaults } from "../src/filters";
import type { FilterDialogState, ImageSession } from "../src/session";
import { LayersSection } from "../src/panels/image-panel";
import { FilterDialog } from "../src/panels/sections/filter-dialog";
import { EditKindBadge } from "../src/panels/sections/edit-kind-badge";
import { PixelViewSection } from "../src/panels/sections/pixel-view";

afterEach(() => cleanup());

const noop = () => {};

const layer = (index: number, kind: LayerInfo["kind"]): LayerInfo =>
  ({
    index,
    id: index,
    name: `Layer ${index}`,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    kind,
    hasMask: false,
    maskEnabled: false,
    clipped: false,
    group: null,
    style: [],
    styleOn: true,
    styleOptions: 0,
    fillOpacity: 1,
    knockout: "none",
    locks: {},
    color: "none",
    link: null,
    blendIf: null,
    adjustKind: null,
    fillKind: null,
  }) as unknown as LayerInfo;

describe("what an edit changes, in the panel (image ADR 487)", () => {
  it("every layer row names its kind; pixel layers solid, the others non-destructive", () => {
    const view = render(
      <LayersSection
        layers={[layer(0, "pixels"), layer(1, "adjustment"), layer(2, "smart")]}
        active={0}
        history={null}
        blendModes={[]}
        layersNote={null}
        gpu
        disabled={false}
        onSelect={noop}
        onAdd={noop}
        onDuplicate={noop}
        onRemove={noop}
        onMove={noop}
        onVisible={noop}
        onOpacity={noop}
        onBlend={noop}
        onLock={noop}
        onAddAdjustment={noop}
        onMaskFromSelection={noop}
        onMaskToggle={noop}
        onClip={noop}
        groups={[]}
        onGroup={noop}
        onUngroup={noop}
        onGroupVisible={noop}
        onGroupOpacity={noop}
        onGroupPassThrough={noop}
        onMaskClear={noop}
        onBake={noop}
        onUndo={noop}
        onRedo={noop}
      />,
    );
    const badges = [
      ...view.container.querySelectorAll<HTMLElement>(
        "[data-image-layer-kind]",
      ),
    ].map((b) => [
      b.dataset.imageLayerKind,
      b.dataset.destructive,
      b.textContent,
    ]);
    expect(badges).toContainEqual(["pixels", "true", "Pixels"]);
    expect(badges).toContainEqual(["adjustment", "false", "Adjustment"]);
    expect(badges).toContainEqual(["smart", "false", "Smart object"]);
  });

  it("the toolbar chip says what the next edit changes", () => {
    const view = render(
      <>
        <EditKindBadge kind="pixels" />
        <EditKindBadge kind="mask" />
      </>,
    );
    const chips = view.container.querySelectorAll("[data-image-edit-kind]");
    expect(chips[0]?.textContent).toBe("Editing: Pixels");
    expect(chips[1]?.textContent).toBe("Editing: Mask · non-destructive");
  });
});

describe("the filter dialog's split and quality line (image ADR 487)", () => {
  function harness(quality: FilterDialogState["quality"]) {
    const def = filterDef("gaussianBlur");
    const onSplit = mock((_s: number | null) => {});
    function Harness() {
      const [dialog, setDialog] = useState<FilterDialogState>({
        id: def.id,
        values: filterDefaults(def),
        preview: true,
        before: false,
        split: null,
        quality,
        applied: true,
        files: {},
      });
      return (
        <FilterDialog
          def={def}
          dialog={dialog}
          gpu
          busy={false}
          onChange={noop}
          onPreview={noop}
          onBefore={noop}
          onSplit={(sp) => {
            onSplit(sp);
            setDialog((d) => ({ ...d, split: sp }));
          }}
          onOk={noop}
          onCancel={noop}
        />
      );
    }
    return { view: render(<Harness />), onSplit };
  }

  it("Split view turns the split on at the middle; its slider moves the line", () => {
    const { view, onSplit } = harness("full");
    const q = (s: string) => view.container.querySelector<HTMLInputElement>(s);
    expect(q("[data-filter-split]")).toBeNull();
    act(() => q("[data-filter-split-toggle]")!.click());
    expect(onSplit).toHaveBeenLastCalledWith(0.5);
    const slider = q("[data-filter-split]")!;
    fireEvent.change(slider, { target: { value: "0.25" } });
    expect(onSplit).toHaveBeenLastCalledWith(0.25);
    act(() => q("[data-filter-split-toggle]")!.click());
    expect(onSplit).toHaveBeenLastCalledWith(null);
  });

  it("the quality line: draft, rendering with an indeterminate bar, full", () => {
    const draft = harness("draft").view.container;
    expect(
      draft
        .querySelector("[data-filter-quality]")
        ?.getAttribute("data-filter-quality"),
    ).toBe("draft");
    cleanup();
    const rendering = harness("rendering").view.container;
    expect(rendering.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(
      rendering
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBeNull();
    cleanup();
    const full = harness("full").view.container;
    expect(full.querySelector("[data-filter-quality]")?.textContent).toBe(
      "Full resolution",
    );
    expect(full.querySelector('[role="progressbar"]')).toBeNull();
  });
});

describe("the pixel view (image ADR 487)", () => {
  it("reads the image's own pixels around the pointer and says size and resolution", () => {
    const reads: Array<[number, number, number, number]> = [];
    let cursor: { at: [number, number]; rgba: number[] } | null = null;
    const listeners = new Set<() => void>();
    const state = {
      source: { width: 2000, height: 1000 },
      ptPerPx: 0.24,
      layers: { layers: [], active: 0, editTarget: "pixels" },
      history: null,
    };
    const session = {
      state: () => state,
      workspace: () => ({ state: () => ({ cursor }) }),
      onDidChange: (l: () => void) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
      readPixels: (x: number, y: number, w: number, h: number) => {
        reads.push([x, y, w, h]);
        return { rgba: new Uint8Array(w * h * 4), x, y, width: w, height: h };
      },
    } as unknown as ImageSession;
    const view = render(<PixelViewSection session={session} />);
    // Open the (collapsed) section.
    const summary = view.container.querySelector("summary");
    if (summary) act(() => summary.click());
    expect(view.container.textContent).toContain("2000 × 1000 px");
    // 72 / 0.24 pt per px = 300 ppi in the layout.
    expect(view.container.textContent).toContain("300 ppi in the layout");
    const canvas = view.container.querySelector<HTMLCanvasElement>(
      "[data-pixel-view-canvas]",
    )!;
    expect(canvas.dataset.pixelCenter).toBe("1000,500");
    // The pointer over the image: the view follows it.
    cursor = { at: [120.5, 80.2], rgba: [10, 20, 30, 255] };
    act(() => {
      for (const l of [...listeners]) l();
    });
    expect(canvas.dataset.pixelCenter).toBe("120,80");
    expect(
      view.container.querySelector("[data-pixel-view-at]")?.textContent,
    ).toBe("x 120, y 80 · 10 20 30");
    // 800 %: fewer pixels read.
    fireEvent.change(view.container.querySelector("[data-pixel-view-zoom]")!, {
      target: { value: "8" },
    });
    expect(canvas.dataset.pixelZoom).toBe("8");
  });
});
