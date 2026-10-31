// The SELECTION AND MASKING panel pieces as components (the DOM lane,
// WP5.5): the Color Range dialog (select, fuzziness, tonal limits,
// localized clusters, eyedropper modes, preview, invert, canvas preview),
// Focus Area, Load Selection, the Select and Mask workspace, the
// Channels and Paths sections and the selection toolbar. What a control
// says is what reaches its callback; German strings render.

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";
import { cleanup, fireEvent, render } from "@testing-library/react";

// Registers the bundle's German catalogue.
import "../src/activate";

import {
  defaultColorRange,
  defaultRefine,
  type MaskingInfo,
} from "../src/masking-engine";
import {
  ChannelsListSection,
  ColorRangeDialog,
  FocusAreaDialog,
  LoadSelectionDialog,
  PathsSection,
  SelectAndMaskWorkspace,
  SelectionToolbar,
} from "../src/panels/sections/masking-section";

afterEach(() => {
  cleanup();
  setActiveStrings(createStrings());
});

const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement;

const INFO: MaskingInfo = {
  channels: [
    {
      id: 1,
      name: "Sky",
      kind: "alpha",
      colour: null,
      solidity: null,
      coverage: 0.5,
    },
    {
      id: 2,
      name: "Varnish",
      kind: "spot",
      colour: [255, 255, 0],
      solidity: 0.5,
      coverage: 0.25,
    },
  ],
  paths: [{ id: 3, name: "Path 1", work: false, subpaths: 1, anchors: 4 }],
  quickMask: null,
  editChannel: null,
};

describe("[image.selection.select-and-mask] the Color Range dialog", () => {
  it("hands every control to its callback", () => {
    const onChange = mock(() => {});
    const onSample = mock(() => {});
    const onCanvasPreview = mock(() => {});
    const onOk = mock(() => {});
    const onCancel = mock(() => {});
    const { container } = render(
      <ColorRangeDialog
        opts={{ ...defaultColorRange(), localized: true }}
        preview={new Uint8Array([255, 0, 0, 255])}
        canvasPreview="none"
        width={2}
        height={2}
        onChange={onChange}
        onSample={onSample}
        onCanvasPreview={onCanvasPreview}
        onOk={onOk}
        onCancel={onCancel}
      />,
    );
    fireEvent.change(q(container, "[data-masking-select]"), {
      target: { value: "reds" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ select: "reds" });
    fireEvent.change(q(container, '[data-masking-slider="fuzziness"]'), {
      target: { value: "80" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ fuzziness: 80 });
    fireEvent.change(q(container, '[data-masking-slider="range"]'), {
      target: { value: "30" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ range: 30 });
    fireEvent.click(q(container, "[data-masking-invert]"));
    expect(onChange).toHaveBeenLastCalledWith({ invert: true });
    // The eyedropper mode picks what a click on the preview does.
    fireEvent.click(q(container, '[data-masking-sample-mode="add"]'));
    fireEvent.click(q(container, "[data-masking-thumb]"));
    expect(onSample).toHaveBeenCalledTimes(1);
    expect((onSample.mock.calls[0] as unknown[])[2]).toBe("add");
    fireEvent.change(q(container, "[data-masking-canvas-preview]"), {
      target: { value: "overlay" },
    });
    expect(onCanvasPreview).toHaveBeenLastCalledWith("overlay");
    fireEvent.click(q(container, '[data-masking-ok="colorRange"]'));
    fireEvent.click(q(container, '[data-masking-cancel="colorRange"]'));
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the tonal limits for a tonal preset and refuses Out of Gamut", () => {
    const onChange = mock(() => {});
    const { container, rerender } = render(
      <ColorRangeDialog
        opts={{
          ...defaultColorRange(),
          select: "shadows",
          fuzziness: 20,
          upper: 65,
        }}
        preview={null}
        canvasPreview="none"
        width={2}
        height={2}
        onChange={onChange}
        onSample={() => {}}
        onCanvasPreview={() => {}}
        onOk={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(q(container, "[data-masking-upper]"), {
      target: { value: "90" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ upper: 90 });
    expect(
      q(container, '[data-masking-slider="fuzziness"]').getAttribute("max"),
    ).toBe("100");
    rerender(
      <ColorRangeDialog
        opts={{ ...defaultColorRange(), select: "outOfGamut" }}
        preview={null}
        canvasPreview="none"
        width={2}
        height={2}
        onChange={onChange}
        onSample={() => {}}
        onCanvasPreview={() => {}}
        onOk={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      (q(container, '[data-masking-ok="colorRange"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(container.textContent).toContain("CMYK profile");
  });
});

describe("[image.selection.select-and-mask] Focus Area and Load Selection", () => {
  it("Focus Area's sliders speak 0…1 to the session", () => {
    const onChange = mock(() => {});
    const onOk = mock(() => {});
    const { container } = render(
      <FocusAreaDialog
        range={0.5}
        noise={0}
        preview={null}
        width={2}
        height={2}
        onChange={onChange}
        onOk={onOk}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(q(container, '[data-masking-slider="focusRange"]'), {
      target: { value: "70" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ range: 0.7 });
    fireEvent.change(q(container, '[data-masking-slider="noise"]'), {
      target: { value: "20" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ noise: 0.2 });
    fireEvent.click(q(container, '[data-masking-ok="focusArea"]'));
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it("Load Selection lists the channels and the four operations", () => {
    const onChange = mock(() => {});
    const { container } = render(
      <LoadSelectionDialog
        info={INFO}
        channel={1}
        mode="replace"
        invert={false}
        onChange={onChange}
        onOk={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      container.querySelectorAll("[data-masking-load-channel] option"),
    ).toHaveLength(2);
    fireEvent.click(q(container, '[data-masking-load-mode="intersect"]'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "intersect" });
    fireEvent.change(q(container, "[data-masking-load-channel]"), {
      target: { value: "2" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ channel: 2 });
  });
});

describe("[image.selection.select-and-mask] the Select and Mask workspace", () => {
  it("every slider, the view, the output and the brush", () => {
    const onChange = mock(() => {});
    const onView = mock(() => {});
    const onOutput = mock(() => {});
    const onBrush = mock(() => {});
    const { container } = render(
      <SelectAndMaskWorkspace
        opts={{ ...defaultRefine(), decontaminate: true }}
        view="overlay"
        opacity={0.5}
        output="selection"
        brushRadius={10}
        alpha={null}
        width={2}
        height={2}
        onChange={onChange}
        onView={onView}
        onOutput={onOutput}
        onBrush={onBrush}
        onOk={() => {}}
        onCancel={() => {}}
      />,
    );
    for (const [attr, key, v] of [
      ["radius", "radius", 12],
      ["smooth", "smooth", 30],
      ["feather", "feather", 2],
      ["contrast", "contrast", 40],
      ["shiftEdge", "shiftEdge", -20],
      ["amount", "amount", 60],
    ] as const) {
      fireEvent.change(q(container, `[data-masking-slider="${attr}"]`), {
        target: { value: String(v) },
      });
      expect(onChange).toHaveBeenLastCalledWith({ [key]: v });
    }
    fireEvent.click(q(container, "[data-masking-smart]"));
    expect(onChange).toHaveBeenLastCalledWith({ smartRadius: true });
    fireEvent.change(q(container, "[data-masking-view]"), {
      target: { value: "onWhite" },
    });
    expect(onView).toHaveBeenLastCalledWith("onWhite");
    fireEvent.change(q(container, '[data-masking-slider="opacity"]'), {
      target: { value: "80" },
    });
    expect(onView).toHaveBeenLastCalledWith("overlay", 0.8);
    fireEvent.change(q(container, "[data-masking-output]"), {
      target: { value: "newLayerWithMask" },
    });
    expect(onOutput).toHaveBeenLastCalledWith("newLayerWithMask");
    fireEvent.change(q(container, '[data-masking-slider="brush"]'), {
      target: { value: "25" },
    });
    expect(onBrush).toHaveBeenLastCalledWith(25);
  });
});

describe("[image.selection.select-and-mask] Channels, Paths and the toolbar", () => {
  it("the channel rows view, paint, load, duplicate, delete and recolour", () => {
    const calls: unknown[][] = [];
    const rec =
      (name: string) =>
      (...a: unknown[]) =>
        calls.push([name, ...a]);
    const { container } = render(
      <ChannelsListSection
        info={INFO}
        view={{ kind: "composite" }}
        disabled={false}
        hasSelection
        onView={rec("view")}
        onEdit={rec("edit")}
        onLoad={rec("load")}
        onRename={rec("rename")}
        onDuplicate={rec("duplicate")}
        onDelete={rec("delete")}
        onSave={rec("save")}
        onNewSpot={rec("newSpot")}
        onSpot={rec("spot")}
      />,
    );
    fireEvent.click(q(container, '[data-masking-view-component="red"]'));
    fireEvent.click(q(container, '[data-masking-channel-view="1"]'));
    fireEvent.click(q(container, '[data-masking-channel-paint="1"]'));
    fireEvent.click(q(container, '[data-masking-channel-load="1"]'));
    fireEvent.click(q(container, '[data-masking-channel-duplicate="1"]'));
    fireEvent.click(q(container, '[data-masking-channel-delete="2"]'));
    const name = q(
      container,
      '[data-masking-channel-name="1"]',
    ) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Clouds" } });
    fireEvent.blur(name);
    fireEvent.click(q(container, "[data-masking-save-selection]"));
    fireEvent.click(q(container, "[data-masking-new-spot]"));
    fireEvent.click(q(container, "[data-masking-show-spots]"));
    expect(calls).toEqual([
      ["view", { kind: "component", channel: "red" }],
      ["view", { kind: "channel", id: 1 }],
      ["edit", 1],
      ["load", 1],
      ["duplicate", 1],
      ["delete", 2],
      ["rename", 1, "Clouds"],
      ["save"],
      ["newSpot", [0, 160, 224], 0],
      ["view", { kind: "composite", spots: true }],
    ]);
  });

  it("the paths rows and Make Work Path", () => {
    const calls: unknown[][] = [];
    const { container } = render(
      <PathsSection
        info={INFO}
        disabled={false}
        hasSelection
        onMakeWorkPath={() => calls.push(["work"])}
        onMakeSelection={(id) => calls.push(["select", id])}
        onRename={(id, n) => calls.push(["rename", id, n])}
        onDuplicate={(id) => calls.push(["duplicate", id])}
        onDelete={(id) => calls.push(["delete", id])}
      />,
    );
    fireEvent.click(q(container, '[data-masking-path-select="3"]'));
    fireEvent.click(q(container, '[data-masking-path-duplicate="3"]'));
    fireEvent.click(q(container, '[data-masking-path-delete="3"]'));
    fireEvent.click(q(container, "[data-masking-make-work-path]"));
    expect(calls).toEqual([
      ["select", 3],
      ["duplicate", 3],
      ["delete", 3],
      ["work"],
    ]);
  });

  it("the toolbar's Quick Mask says when it is on; selection verbs wait for a selection", () => {
    const onQuickMask = mock(() => {});
    const { container } = render(
      <SelectionToolbar
        quickMask
        hasSelection={false}
        disabled={false}
        onColorRange={() => {}}
        onSelectAndMask={() => {}}
        onQuickMask={onQuickMask}
        onGrow={() => {}}
        onSimilar={() => {}}
        onFocusArea={() => {}}
      />,
    );
    const qm = q(container, '[data-masking-cmd="quickMask"]');
    expect(qm.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(qm);
    expect(onQuickMask).toHaveBeenCalledTimes(1);
    expect(
      (q(container, '[data-masking-cmd="grow"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("renders in German", () => {
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    const { container } = render(
      <SelectAndMaskWorkspace
        opts={defaultRefine()}
        view="overlay"
        opacity={0.5}
        output="selection"
        brushRadius={10}
        alpha={null}
        width={2}
        height={2}
        onChange={() => {}}
        onView={() => {}}
        onOutput={() => {}}
        onBrush={() => {}}
        onOk={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.textContent).toContain("Radius der Kantenerkennung");
    expect(container.textContent).toContain("Kante verschieben");
  });
});
