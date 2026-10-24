// The Layers panel's Photoshop-parity sections as components (the DOM
// lane, WP5.3): the filter bar narrows the rows, the active layer's strip
// reads its fill, locks, label and link and hands each change over, the
// verbs row calls the verb it names, the Properties draw one form per
// adjustment and fill kind over the kind's own block, Layer Comps record
// and apply, and the Blending Options dialog edits fill, knockout and the
// Blend If sliders (a split slider's halves stay in order).
// [image.layers.photoshop-parity]

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  ADJUSTMENT_KINDS,
  PLAIN_LAYER_PARITY,
  type LayerInfo,
  type LayerParams,
} from "../src/engine";
import { NO_LAYER_FILTER } from "../src/session";
import {
  ActiveLayerStrip,
  BlendingOptionsDialog,
  blendIfSliders,
  LayerCompsSection,
  LayerFilterBar,
  LayerPropertiesSection,
  LayerVerbs,
  matchesLayerFilter,
} from "../src/panels/sections/layer-parity";
import { LayersSection } from "../src/panels/image-panel";

afterEach(() => cleanup());

const layer = (over: Partial<LayerInfo> = {}): LayerInfo => ({
  index: 0,
  id: 1,
  name: "Background",
  visible: true,
  locked: false,
  opacity: 1,
  blend: "normal",
  kind: "pixels",
  hasMask: false,
  maskEnabled: true,
  clipped: false,
  group: null,
  ...PLAIN_LAYER_PARITY,
  locks: { ...PLAIN_LAYER_PARITY.locks },
  ...over,
});

const noop = () => {};

describe("the Layers list's filter", () => {
  it("matches by name, kind and colour label", () => {
    const l = layer({ name: "Sky glow", kind: "fill", color: "blue" });
    expect(matchesLayerFilter(l, NO_LAYER_FILTER)).toBe(true);
    expect(matchesLayerFilter(l, { ...NO_LAYER_FILTER, query: "glow" })).toBe(
      true,
    );
    expect(matchesLayerFilter(l, { ...NO_LAYER_FILTER, query: "sea" })).toBe(
      false,
    );
    expect(matchesLayerFilter(l, { ...NO_LAYER_FILTER, kind: "fill" })).toBe(
      true,
    );
    expect(matchesLayerFilter(l, { ...NO_LAYER_FILTER, kind: "pixels" })).toBe(
      false,
    );
    expect(matchesLayerFilter(l, { ...NO_LAYER_FILTER, color: "red" })).toBe(
      false,
    );
  });

  it("the bar hands every change over and says how many rows it shows", () => {
    const onFilter = mock((_p: object) => {});
    const view = render(
      <LayerFilterBar
        filter={NO_LAYER_FILTER}
        shown={1}
        total={3}
        disabled={false}
        onFilter={onFilter}
      />,
    );
    const q = (s: string) => view.container.querySelector(s)!;
    fireEvent.change(q("[data-image-layer-search]"), {
      target: { value: "logo" },
    });
    fireEvent.change(q("[data-image-layer-filter-kind]"), {
      target: { value: "adjustment" },
    });
    fireEvent.change(q("[data-image-layer-filter-color]"), {
      target: { value: "green" },
    });
    expect(onFilter.mock.calls.map((c) => c[0])).toEqual([
      { query: "logo" },
      { kind: "adjustment" },
      { color: "green" },
    ]);
    expect(q("[data-image-layer-filtered]").textContent).toBe(
      "1 of 3 layers shown",
    );
  });

  it("the Layers section lists only the rows the filter passes, and labels them", () => {
    const onColor = mock((_i: number, _c: string) => {});
    const view = render(
      <LayersSection
        layers={[
          layer(),
          layer({ index: 1, id: 2, name: "Logo", color: "red", link: 9 }),
        ]}
        active={1}
        history={null}
        blendModes={["normal"]}
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
        onUndoTo={noop}
        onRedoTo={noop}
        onBake={noop}
        onUndo={noop}
        onRedo={noop}
        filter={{ ...NO_LAYER_FILTER, query: "log" }}
        onFilter={noop}
        onColor={onColor}
      />,
    );
    const rows = [...view.container.querySelectorAll("[data-image-layer-row]")];
    expect(rows.map((r) => r.getAttribute("data-image-layer-row"))).toEqual([
      "1",
    ]);
    expect(rows[0]!.textContent).toContain("⛓");
    fireEvent.change(
      view.container.querySelector('[data-image-layer-row-color="1"]')!,
      { target: { value: "violet" } },
    );
    expect(onColor.mock.calls[0]).toEqual([1, "violet"]);
  });
});

describe("the active layer's strip", () => {
  it("shows fill, the four locks, the label and the link, and hands each over", () => {
    const onFill = mock((_v: number) => {});
    const onLocks = mock((_p: object) => {});
    const onLink = mock(() => {});
    const onBlendingOptions = mock(() => {});
    const view = render(
      <ActiveLayerStrip
        layer={layer({
          index: 1,
          fillOpacity: 0.4,
          locks: { transparency: true, position: false, all: false },
        })}
        below={layer()}
        disabled={false}
        onFill={onFill}
        onLocks={onLocks}
        onColor={noop}
        onLink={onLink}
        onUnlink={noop}
        onBlendingOptions={onBlendingOptions}
        onRasterize={noop}
      />,
    );
    const q = (s: string) => view.container.querySelector(s) as HTMLElement;
    expect(
      (q("[data-image-layer-fill-opacity]") as HTMLInputElement).value,
    ).toBe("0.4");
    expect(
      q('[data-image-layer-lock-kind="transparency"]').getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    fireEvent.change(q("[data-image-layer-fill-opacity]"), {
      target: { value: "0.75" },
    });
    fireEvent.click(q('[data-image-layer-lock-kind="position"]'));
    fireEvent.click(q('[data-image-layer-lock-kind="all"]'));
    fireEvent.click(q('[data-image-layer-lock-kind="transparency"]'));
    fireEvent.click(q("[data-image-layer-link]"));
    fireEvent.click(q("[data-image-open-blending-options]"));
    expect(onFill.mock.calls[0]).toEqual([0.75]);
    expect(onLocks.mock.calls.map((c) => c[0])).toEqual([
      { position: true },
      { all: true },
      { transparency: false },
    ]);
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onBlendingOptions).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("[data-image-layer-rasterize]")).toBe(
      null,
    );
  });

  it("offers Rasterize on a fill layer and Unlink on a linked one", () => {
    const onRasterize = mock(() => {});
    const onUnlink = mock(() => {});
    const view = render(
      <ActiveLayerStrip
        layer={layer({ kind: "fill", fillKind: "solid", link: 3 })}
        below={null}
        disabled={false}
        onFill={noop}
        onLocks={noop}
        onColor={noop}
        onLink={noop}
        onUnlink={onUnlink}
        onBlendingOptions={noop}
        onRasterize={onRasterize}
      />,
    );
    fireEvent.click(
      view.container.querySelector("[data-image-layer-rasterize]")!,
    );
    fireEvent.click(view.container.querySelector("[data-image-layer-unlink]")!);
    expect(onRasterize).toHaveBeenCalledTimes(1);
    expect(onUnlink).toHaveBeenCalledTimes(1);
  });
});

describe("the verbs row", () => {
  it("creates fills and adjustments of every kind, and calls each verb it names", () => {
    const onNewFill = mock((_k: string) => {});
    const onNewAdjustment = mock((_k: string) => {});
    const onVerb = mock((_v: string) => {});
    const onAlign = mock((_e: string) => {});
    const onDistribute = mock((_a: string) => {});
    const onAlignTo = mock((_t: string) => {});
    const view = render(
      <LayerVerbs
        disabled={false}
        gpu
        inGroup
        hasSelection
        alignTo="canvas"
        onAlignTo={onAlignTo}
        onNewFill={onNewFill}
        onNewAdjustment={onNewAdjustment}
        onVerb={onVerb}
        onAlign={onAlign}
        onDistribute={onDistribute}
      />,
    );
    const q = (s: string) => view.container.querySelector(s)!;
    for (const k of ["solid", "gradient", "pattern"])
      fireEvent.change(q("[data-image-new-fill]"), { target: { value: k } });
    for (const k of ADJUSTMENT_KINDS)
      fireEvent.change(q("[data-image-new-adjustment]"), {
        target: { value: k },
      });
    expect(onNewFill.mock.calls.map((c) => c[0])).toEqual([
      "solid",
      "gradient",
      "pattern",
    ]);
    expect(onNewAdjustment.mock.calls.map((c) => c[0])).toEqual([
      ...ADJUSTMENT_KINDS,
    ]);
    const verbs = [
      ...view.container.querySelectorAll("[data-image-layer-verb]"),
    ];
    verbs.forEach((b) => fireEvent.click(b));
    expect(onVerb.mock.calls.map((c) => c[0])).toEqual([
      "mergeDown",
      "mergeVisible",
      "stampVisible",
      "flatten",
      "mergeGroup",
      "viaCopy",
      "viaCut",
    ]);
    for (const b of view.container.querySelectorAll("[data-image-layer-align]"))
      fireEvent.click(b);
    expect(onAlign.mock.calls.map((c) => c[0])).toEqual([
      "left",
      "hcenter",
      "right",
      "top",
      "vcenter",
      "bottom",
    ]);
    for (const b of view.container.querySelectorAll(
      "[data-image-layer-distribute]",
    ))
      fireEvent.click(b);
    expect(onDistribute.mock.calls.map((c) => c[0])).toEqual([
      "horizontal",
      "vertical",
    ]);
    fireEvent.change(q("[data-image-layer-align-to]"), {
      target: { value: "selection" },
    });
    expect(onAlignTo.mock.calls[0]).toEqual(["selection"]);
  });

  it("disables the GPU verbs without WebGPU and Layer via without a selection", () => {
    const view = render(
      <LayerVerbs
        disabled={false}
        gpu={false}
        inGroup={false}
        hasSelection={false}
        alignTo="canvas"
        onAlignTo={noop}
        onNewFill={noop}
        onNewAdjustment={noop}
        onVerb={noop}
        onAlign={noop}
        onDistribute={noop}
      />,
    );
    const off = [
      ...view.container.querySelectorAll<HTMLButtonElement>(
        "[data-image-layer-verb]",
      ),
    ]
      .filter((b) => b.disabled)
      .map((b) => b.getAttribute("data-image-layer-verb"));
    expect(off).toEqual([
      "mergeDown",
      "mergeVisible",
      "stampVisible",
      "flatten",
      "mergeGroup",
      "viaCopy",
      "viaCut",
    ]);
    expect(
      (
        view.container.querySelector(
          "[data-image-new-fill]",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
  });
});

/** The Rust `Adjustment::default_for(kind).values()` blocks. */
const DEFAULT_BLOCKS: Record<string, number[]> = {
  brightnessContrast: [0, 0],
  levels: Array.from({ length: 4 }, () => [0, 255, 1, 0, 255]).flat(),
  curves: [0, 0, 0, 0],
  exposure: [0, 0, 1],
  vibrance: [0, 0],
  hueSaturation: [0, 0, 25, 0, 0, 0, 0, ...Array(18).fill(0)],
  colorBalance: Array(9).fill(0),
  blackWhite: [40, 60, 40, 60, 20, 80],
  photoFilter: [236, 138, 0, 25, 1],
  channelMixer: [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100, 0, 0],
  colorLookup: [],
  invert: [],
  posterize: [4],
  threshold: [128],
  gradientMap: [0, 2, 0, 0, 0, 0, 1, 255, 255, 255],
  selectiveColor: [0, ...Array(36).fill(0)],
};

describe("the Properties of a typed adjustment or fill layer", () => {
  const properties = (
    params: LayerParams | null,
    over: Partial<LayerInfo> = {},
  ) => {
    const onAdjust = mock((_v: number[], _c?: number[], _l?: string) => {});
    const onFill = mock((_k: string, _v: number[]) => {});
    const view = render(
      <LayerPropertiesSection
        layer={layer({ kind: "adjustment", ...over })}
        params={params}
        disabled={false}
        onAdjust={onAdjust}
        onFill={onFill}
      />,
    );
    return { view, onAdjust, onFill };
  };

  it("draws a form for every kind over its own block", () => {
    for (const kind of ADJUSTMENT_KINDS) {
      const { view } = properties({
        adjustment: kind,
        values: DEFAULT_BLOCKS[kind]!,
        label: "",
      });
      const root = view.container.querySelector(
        "[data-image-layer-properties]",
      )!;
      expect(root.getAttribute("data-kind")).toBe(kind);
      const controls = root.querySelectorAll("input, select");
      // Invert alone has no settings.
      if (kind === "invert") expect(controls.length).toBe(0);
      else expect(controls.length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it("an edit sends the whole block with the one value changed", () => {
    const { view, onAdjust } = properties({
      adjustment: "brightnessContrast",
      values: [0, 0],
    });
    const contrast = view.container.querySelector(
      '[data-image-prop-field="1"] input[type="number"]',
    )!;
    fireEvent.change(contrast, { target: { value: "35" } });
    expect(onAdjust.mock.calls[0]![0]).toEqual([0, 35]);
  });

  it("Levels edits the channel the picker shows", () => {
    const { view, onAdjust } = properties({
      adjustment: "levels",
      values: DEFAULT_BLOCKS.levels!,
    });
    fireEvent.change(view.container.querySelector("[data-image-prop-part]")!, {
      target: { value: "2" },
    });
    fireEvent.change(
      view.container.querySelector(
        '[data-image-prop-field="10"] input[type="number"]',
      )!,
      { target: { value: "20" } },
    );
    const block = onAdjust.mock.calls[0]![0];
    expect(block[10]).toBe(20);
    expect(block.length).toBe(20);
  });

  it("a Gradient Map adds a stop and a Curves channel a point", () => {
    const gm = properties({
      adjustment: "gradientMap",
      values: DEFAULT_BLOCKS.gradientMap!,
    });
    fireEvent.click(
      gm.view.container.querySelector("[data-image-prop-stop-add]")!,
    );
    const block = gm.onAdjust.mock.calls[0]![0];
    expect(block[1]).toBe(3);
    expect(block.length).toBe(2 + 3 * 4);
    cleanup();
    const cv = properties({ adjustment: "curves", values: [0, 0, 0, 0] });
    fireEvent.click(
      cv.view.container.querySelector("[data-image-prop-curve-add]")!,
    );
    expect(cv.onAdjust.mock.calls[0]![0]).toEqual([
      3, 0, 0, 128, 128, 255, 255, 0, 0, 0,
    ]);
  });

  it("a fill layer's solid colour and gradient take their own blocks", () => {
    const solid = properties(
      { fill: "solid", values: [10, 20, 30] },
      { kind: "fill", fillKind: "solid" },
    );
    fireEvent.change(
      solid.view.container.querySelector('[data-image-prop-color="0"]')!,
      {
        target: { value: "#ff8000" },
      },
    );
    expect(solid.onFill.mock.calls[0]).toEqual(["solid", [255, 128, 0]]);
    cleanup();
    const grad = properties(
      {
        fill: "gradient",
        values: [0, 90, 100, 0, 0, 0, 2, 0, 0, 0, 0, 1, 255, 255, 255],
      },
      { kind: "fill", fillKind: "gradient" },
    );
    fireEvent.change(
      grad.view.container.querySelector("[data-image-prop-gradient-style]")!,
      { target: { value: "1" } },
    );
    expect(grad.onFill.mock.calls[0]![1][0]).toBe(1);
  });

  it("says what to select when the active layer has no properties, and that a chain is edited above", () => {
    const none = properties(null, { kind: "pixels" });
    expect(none.view.container.textContent).toContain(
      "Select an adjustment or fill layer",
    );
    cleanup();
    const chain = properties({ adjustment: "chain", values: [1, 2, 3] });
    expect(chain.view.container.textContent).toContain("stored chain");
  });
});

describe("Layer Comps", () => {
  it("records with the chosen options, and applies, updates, renames and deletes", () => {
    const onNew = mock((_n: string, _r: object) => {});
    const onApply = mock((_id: number) => {});
    const onUpdate = mock((_id: number) => {});
    const onDelete = mock((_id: number) => {});
    const onRename = mock((_id: number, _n: string) => {});
    const view = render(
      <LayerCompsSection
        comps={[
          {
            id: 7,
            name: "Day",
            visibility: true,
            position: true,
            appearance: false,
          },
        ]}
        disabled={false}
        onNew={onNew}
        onApply={onApply}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onRename={onRename}
      />,
    );
    const q = (s: string) => view.container.querySelector(s)!;
    fireEvent.change(q("[data-image-comp-new-name]"), {
      target: { value: "Night" },
    });
    fireEvent.click(q('[data-image-comp-record="position"]'));
    fireEvent.click(q("[data-image-comp-new]"));
    fireEvent.click(q('[data-image-comp-apply="7"]'));
    fireEvent.click(q('[data-image-comp-update="7"]'));
    fireEvent.change(q('[data-image-comp-name="7"]'), {
      target: { value: "Daylight" },
    });
    fireEvent.click(q('[data-image-comp-delete="7"]'));
    expect(onNew.mock.calls[0]).toEqual([
      "Night",
      { visibility: true, position: false, appearance: true },
    ]);
    expect(onApply.mock.calls[0]).toEqual([7]);
    expect(onUpdate.mock.calls[0]).toEqual([7]);
    expect(onRename.mock.calls[0]).toEqual([7, "Daylight"]);
    expect(onDelete.mock.calls[0]).toEqual([7]);
  });
});

describe("the Blending Options dialog", () => {
  it("edits fill and knockout, and Blend If keeps a split slider's halves in order", () => {
    const onFill = mock((_v: number) => {});
    const onKnockout = mock((_k: string) => {});
    const onBlendIf = mock((_s: number[] | null) => {});
    const onClose = mock(() => {});
    const l = layer({ name: "Glow", blendIf: null });
    const view = render(
      <BlendingOptionsDialog
        layer={l}
        disabled={false}
        onFill={onFill}
        onKnockout={onKnockout}
        onBlendIf={onBlendIf}
        onClose={onClose}
      />,
    );
    const q = (s: string) => view.container.querySelector(s)!;
    expect(q("[data-image-blending-options]").getAttribute("aria-label")).toBe(
      "Blending options — Glow",
    );
    fireEvent.change(q("[data-image-blending-fill]"), {
      target: { value: "0.3" },
    });
    fireEvent.change(q("[data-image-blending-knockout]"), {
      target: { value: "deep" },
    });
    // This Layer's black LOW past its high: the high follows.
    fireEvent.change(q('[data-image-blend-if-slider="0:0"]'), {
      target: { value: "90" },
    });
    // Underlying (red channel): the white HIGH below its low drags it.
    fireEvent.change(q("[data-image-blend-if-channel]"), {
      target: { value: "1" },
    });
    fireEvent.change(q('[data-image-blend-if-slider="1:3"]'), {
      target: { value: "60" },
    });
    expect(onFill.mock.calls[0]).toEqual([0.3]);
    expect(onKnockout.mock.calls[0]).toEqual(["deep"]);
    const first = onBlendIf.mock.calls[0]![0]!;
    expect(first.slice(0, 4)).toEqual([90, 90, 255, 255]);
    const second = onBlendIf.mock.calls[1]![0]!;
    expect(second.slice(12, 16)).toEqual([0, 0, 60, 60]);
    fireEvent.click(q("[data-image-blending-close]"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(blendIfSliders(l)).toHaveLength(32);
  });
});
