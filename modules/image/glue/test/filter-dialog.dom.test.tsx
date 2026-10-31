// The Filter dialog and the Image dialogs as components (the DOM lane):
// the dialog draws its filter's whole schema — a slider per range, an
// angle dial, a choice, a switch, a colour — and what a control says is
// what reaches the session; OK / Cancel / Preview / Before call through;
// OK waits for a GPU. Image Size keeps proportions and converts printed
// lengths at the resolution; with Resample off only the resolution moves.
// Trim and Rotate hand over their choice. The Curves tools arm one
// eyedropper at a time.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import { FILTERS, filterDef, filterDefaults } from "../src/filters";
import type { FilterValue } from "../src/filters";
import type { CurvesPick, FilterDialogState } from "../src/session";
import {
  dialAngle,
  FilterDialog,
  paramShown,
} from "../src/panels/sections/filter-dialog";
import { GALLERY_EFFECTS } from "../src/filters";
import {
  ImageSizeDialog,
  IndexedColorDialog,
  lengthToPx,
  pxToLength,
  RotateDialog,
  TrimDialog,
} from "../src/panels/sections/image-dialogs";
import { CurvesTools } from "../src/panels/sections/curves-tools";
import { MoreFilters } from "../src/panels/sections/more-filters";
import { galleryLayers } from "../src/filters-gallery";

afterEach(() => cleanup());

function filterHarness(id: Parameters<typeof filterDef>[0], gpu = true) {
  const def = filterDef(id);
  const onChange = mock((_p: Record<string, FilterValue>) => {});
  const onPreview = mock((_on: boolean) => {});
  const onBefore = mock((_b: boolean) => {});
  const onOk = mock(() => {});
  const onCancel = mock(() => {});
  const onChooseImage = mock((_k: string, _c: 0 | 1) => {});
  function Harness() {
    const [dialog, setDialog] = useState<FilterDialogState>({
      id,
      values: filterDefaults(def),
      preview: true,
      before: false,
      applied: true,
      files: {},
    });
    return (
      <FilterDialog
        def={def}
        dialog={dialog}
        gpu={gpu}
        busy={false}
        onChange={(p) => {
          onChange(p);
          setDialog((d) => ({ ...d, values: { ...d.values, ...p } }));
        }}
        onPreview={(on) => {
          onPreview(on);
          setDialog((d) => ({ ...d, preview: on }));
        }}
        onBefore={(b) => {
          onBefore(b);
          setDialog((d) => ({ ...d, before: b }));
        }}
        onOk={onOk}
        onCancel={onCancel}
        onChooseImage={onChooseImage}
        effects={GALLERY_EFFECTS}
      />
    );
  }
  const view = render(<Harness />);
  const q = (sel: string) =>
    view.container.querySelector(sel) as HTMLInputElement | null;
  return {
    view,
    q,
    onChange,
    onPreview,
    onBefore,
    onOk,
    onCancel,
    onChooseImage,
  };
}

describe("the Filter dialog component", () => {
  it("draws every parameter of every filter's schema", () => {
    for (const def of FILTERS) {
      // The workspace draws its stack, not parameters (its own tests).
      if (def.id === "filterGallery") continue;
      const { view } = filterHarness(def.id);
      const shown = [
        ...view.container.querySelectorAll("[data-filter-param]"),
      ].map((e) => e.getAttribute("data-filter-param"));
      const defaults = filterDefaults(def);
      // At the defaults: every parameter whose condition holds; on-canvas
      // points and data (WP5.6's pins, strokes, mesh) show as a count
      // instead of a control.
      expect(shown).toEqual(
        def.params
          .filter(
            (p) =>
              paramShown(p, defaults) &&
              p.kind !== "points" &&
              p.kind !== "data",
          )
          .map((p) => p.key),
      );
      expect(
        view.container.querySelector(`[data-filter-dialog="${def.id}"]`),
      ).not.toBeNull();
      cleanup();
    }
  });

  it("counts the on-canvas data of the warps, with a reset [image.editor.transform-warp]", () => {
    const { q } = filterHarness("puppetWarp");
    expect(q('[data-filter-data="pins"]')!.textContent).toBe("0 pins");
    expect(q('[data-filter-data-reset="pins"]')!.disabled).toBe(true);
    cleanup();
    const h = filterHarness("liquify");
    expect(h.q('[data-filter-data="strokes"]')!.textContent).toBe("0 strokes");
    cleanup();
    const w = filterHarness("warp");
    expect(w.q('[data-filter-data="mesh"]')!.textContent).toBe("style mesh");
    expect(w.q('[data-filter-data="rect"]')).toBeNull();
  });

  it("sends a slider's, a choice's and a switch's value, not a constant", () => {
    const { q, onChange } = filterHarness("addNoise");
    fireEvent.change(q('[data-filter-param="amount"]')!, {
      target: { value: "0.4" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ amount: 0.4 });
    fireEvent.change(q('[data-filter-param="gaussian"]')!, {
      target: { value: "0" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ gaussian: 0 });
    fireEvent.click(q('[data-filter-param="mono"]')!);
    expect(onChange).toHaveBeenLastCalledWith({ mono: true });
    // The readout follows the value.
    expect(q('[data-filter-param="amount"]')!.value).toBe("0.4");
  });

  it("has an angle dial and a colour well where the schema asks", () => {
    const { view, q, onChange } = filterHarness("emboss");
    expect(view.container.querySelector("[data-filter-dial]")).not.toBeNull();
    fireEvent.change(q('[data-filter-param="angle"]')!, {
      target: { value: "-30" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ angle: -30 });
    cleanup();
    const g = filterHarness("gradientMap");
    fireEvent.change(g.q('[data-filter-param="shadow"]')!, {
      target: { value: "#ff0000" },
    });
    expect(g.onChange).toHaveBeenLastCalledWith({ shadow: [1, 0, 0] });
    // The dial reads 0° to the right and counter-clockwise positive.
    expect(dialAngle(10, 0)).toBe(0);
    expect(dialAngle(0, -10)).toBe(90);
    expect(dialAngle(-10, 0)).toBe(180);
  });

  it("OK, Cancel, Preview and Before call through; OK needs a GPU", () => {
    const { q, onOk, onCancel, onPreview, onBefore } = filterHarness("emboss");
    fireEvent.click(q("[data-filter-before]")!);
    expect(onBefore).toHaveBeenLastCalledWith(true);
    expect(q("[data-filter-before]")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(q("[data-filter-preview]")!);
    expect(onPreview).toHaveBeenLastCalledWith(false);
    // Before is meaningless without a preview.
    expect(q("[data-filter-before]")!.disabled).toBe(true);
    fireEvent.click(q("[data-filter-ok]")!);
    fireEvent.click(q("[data-filter-cancel]")!);
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    cleanup();
    const nogpu = filterHarness("emboss", false);
    expect(nogpu.q("[data-filter-ok]")!.disabled).toBe(true);
    expect(nogpu.view.container.textContent).toMatch(/WebGPU/);
  });
});

describe("the Image Size dialog", () => {
  function sizeHarness(gpu = true) {
    const onResample = mock(
      (_w: number, _h: number, _f: string, _ppi: number) => {},
    );
    const onResolution = mock((_ppi: number) => {});
    const onCancel = mock(() => {});
    const view = render(
      <ImageSizeDialog
        width={400}
        height={200}
        ppi={300}
        gpu={gpu}
        busy={false}
        onResample={onResample}
        onResolution={onResolution}
        onCancel={onCancel}
      />,
    );
    const q = (sel: string) =>
      view.container.querySelector(sel) as HTMLInputElement;
    return { view, q, onResample, onResolution, onCancel };
  }

  it("keeps proportions, picks the method, and resamples on OK", () => {
    const { q, onResample } = sizeHarness();
    fireEvent.change(q("[data-image-resize-w]"), { target: { value: "200" } });
    expect(q("[data-image-resize-h]").value).toBe("100");
    fireEvent.change(q("[data-image-resize-filter]"), {
      target: { value: "nearest" },
    });
    fireEvent.click(q("[data-image-resize-apply]"));
    expect(onResample).toHaveBeenCalledWith(200, 100, "nearest", 300);
  });

  it("shows the printed size at the resolution; without Resample a length moves the resolution only", () => {
    const { q, onResolution, onResample } = sizeHarness();
    // 400 px at 300 ppi = 1.333 in = 3.39 cm.
    expect(Number(q("[data-image-size-length-w]").value)).toBeCloseTo(3.39, 2);
    fireEvent.click(q("[data-image-size-resample]"));
    expect(q("[data-image-resize-w]").disabled).toBe(true);
    fireEvent.change(q("[data-image-size-unit]"), { target: { value: "in" } });
    fireEvent.change(q("[data-image-size-length-w]"), {
      target: { value: "2" },
    });
    // 400 px across 2 in is 200 ppi.
    expect(Number(q("[data-image-size-ppi]").value)).toBe(200);
    fireEvent.click(q("[data-image-resize-apply]"));
    expect(onResolution).toHaveBeenCalledWith(200);
    expect(onResample).not.toHaveBeenCalled();
    expect(pxToLength(300, 300, "in")).toBe(1);
    expect(lengthToPx(2.54, 100, "cm")).toBe(100);
  });

  it("a pixel change waits for a GPU; Constrain off sizes each side alone", () => {
    const { q } = sizeHarness(false);
    fireEvent.click(q("[data-image-size-constrain]"));
    fireEvent.change(q("[data-image-resize-w]"), { target: { value: "300" } });
    expect(q("[data-image-resize-h]").value).toBe("200");
    expect(q("[data-image-resize-apply]").disabled).toBe(true);
  });
});

describe("the Trim and Rotate dialogs", () => {
  it("Trim hands over the chosen basis", () => {
    const onTrim = mock((_by: string) => {});
    const view = render(
      <TrimDialog busy={false} onTrim={onTrim} onCancel={() => {}} />,
    );
    const q = (sel: string) =>
      view.container.querySelector(sel) as HTMLInputElement;
    fireEvent.click(q('[data-image-trim-by="bottom-right"]'));
    fireEvent.click(q("[data-image-trim-apply]"));
    expect(onTrim).toHaveBeenCalledWith("bottom-right");
  });

  it("Indexed Color hands over its palette; only Adaptive takes a colour count", () => {
    const onApply = mock((_p: string, _n: number) => {});
    const view = render(
      <IndexedColorDialog busy={false} onApply={onApply} onCancel={() => {}} />,
    );
    const q = (sel: string) =>
      view.container.querySelector(sel) as HTMLInputElement;
    fireEvent.change(q("[data-image-indexed-colours]"), {
      target: { value: "64" },
    });
    fireEvent.click(q("[data-image-indexed-apply]"));
    expect(onApply).toHaveBeenLastCalledWith("adaptive", 64);
    fireEvent.change(q("[data-image-indexed-palette]"), {
      target: { value: "web" },
    });
    expect(q("[data-image-indexed-colours]").disabled).toBe(true);
    fireEvent.click(q("[data-image-indexed-apply]"));
    expect(onApply).toHaveBeenLastCalledWith("web", 64);
  });

  it("Rotate signs the angle by direction; without a GPU only quarter turns go", () => {
    const onRotate = mock((_d: number) => {});
    const view = render(
      <RotateDialog
        gpu={false}
        busy={false}
        onRotate={onRotate}
        onCancel={() => {}}
      />,
    );
    const q = (sel: string) =>
      view.container.querySelector(sel) as HTMLInputElement;
    expect(q("[data-image-rotate-apply]").disabled).toBe(true);
    fireEvent.change(q("[data-image-rotate-angle]"), {
      target: { value: "90" },
    });
    fireEvent.click(q('[data-image-rotate-dir="ccw"]'));
    fireEvent.click(q("[data-image-rotate-apply]"));
    expect(onRotate).toHaveBeenCalledWith(-90);
  });
});

describe("the Curves tools", () => {
  it("Auto calls through and the eyedroppers arm one at a time", () => {
    const onAuto = mock(() => {});
    const onArm = mock((_k: CurvesPick | null) => {});
    function Harness() {
      const [armed, setArmed] = useState<CurvesPick | null>(null);
      return (
        <CurvesTools
          armed={armed}
          disabled={false}
          onAuto={onAuto}
          onArm={(k) => {
            onArm(k);
            setArmed(k);
          }}
        />
      );
    }
    const view = render(<Harness />);
    const q = (sel: string) =>
      view.container.querySelector(sel) as HTMLButtonElement;
    fireEvent.click(q("[data-image-curves-auto]"));
    expect(onAuto).toHaveBeenCalledTimes(1);
    fireEvent.click(q('[data-image-curves-pick="grey"]'));
    expect(onArm).toHaveBeenLastCalledWith("grey");
    expect(
      q('[data-image-curves-pick="grey"]').getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(q('[data-image-curves-pick="black"]'));
    expect(onArm).toHaveBeenLastCalledWith("black");
    expect(
      q('[data-image-curves-pick="grey"]').getAttribute("aria-pressed"),
    ).toBe("false");
    // A second click disarms.
    fireEvent.click(q('[data-image-curves-pick="black"]'));
    expect(onArm).toHaveBeenLastCalledWith(null);
  });
});

describe("the WP5.2 dialog parts", () => {
  it("sections head their parameters; a switch shows its blur's settings", () => {
    const { view, q } = filterHarness("blurGallery");
    expect(
      view.container.querySelector(
        '[data-filter-section="image.blurGallery.field"]',
      ),
    ).not.toBeNull();
    // Iris is off at the defaults: its sliders are not drawn.
    expect(q('[data-filter-param="irisBlur"]')).toBeNull();
    fireEvent.click(q('[data-filter-param="iris"]')!);
    expect(q('[data-filter-param="irisBlur"]')).not.toBeNull();
    // The field pin: a count and a blur slider per pin.
    expect(
      view.container.querySelector('[data-filter-points="fieldPins"]')!
        .textContent,
    ).toMatch(/1 point/);
    expect(q('[data-filter-point="fieldPins:0"]')).not.toBeNull();
  });

  it("a pin's slider sends the whole list with its blur changed", () => {
    const { q, onChange } = filterHarness("blurGallery");
    fireEvent.change(q('[data-filter-point="fieldPins:0"]')!, {
      target: { value: "40" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ fieldPins: [0.5, 0.5, 40] });
  });

  it("an image parameter asks for a file through onChooseImage", () => {
    const { q, onChooseImage } = filterHarness("displace");
    const sel = q('[data-filter-param="map"]')!;
    expect(sel.value).toBe("0");
    fireEvent.change(sel, { target: { value: "1" } });
    expect(onChooseImage).toHaveBeenLastCalledWith("map", 1);
  });

  it("the Filter Gallery: choose an effect, add, hide and delete layers", () => {
    const { view, onChange } = filterHarness("filterGallery");
    const c = view.container;
    expect(c.querySelectorAll("[data-filter-gallery-layer]")).toHaveLength(1);
    fireEvent.click(c.querySelector('[data-filter-gallery-effect="chrome"]')!);
    let v = onChange.mock.calls.at(-1)![0];
    expect(galleryLayers(v, GALLERY_EFFECTS).map((l) => l.effect)).toEqual([
      "chrome",
    ]);
    fireEvent.click(c.querySelector("[data-filter-gallery-new]")!);
    expect(c.querySelectorAll("[data-filter-gallery-layer]")).toHaveLength(2);
    fireEvent.click(c.querySelector('[data-filter-gallery-eye="0"]')!);
    v = onChange.mock.calls.at(-1)![0];
    expect(galleryLayers(v, GALLERY_EFFECTS).map((l) => l.visible)).toEqual([
      false,
      true,
    ]);
    fireEvent.click(c.querySelector("[data-filter-gallery-delete]")!);
    expect(c.querySelectorAll("[data-filter-gallery-layer]")).toHaveLength(1);
    // The active layer's own settings are drawn under the browser.
    expect(c.querySelector('[data-filter-param="detail"]')).not.toBeNull();
  });

  it("More filters opens a group's choice, a blur and a no-dialog filter", () => {
    const onOpen = mock((_id: string) => {});
    const onOneShot = mock((_k: string) => {});
    const onBlur = mock((_k: string) => {});
    const view = render(
      <MoreFilters
        filters={FILTERS}
        disabled={false}
        onOpen={onOpen}
        onOneShot={onOneShot}
        onBlurGallery={onBlur}
      />,
    );
    const c = view.container;
    fireEvent.change(
      c.querySelector('[data-image-more-filters-group="Distort"]')!,
      { target: { value: "ripple" } },
    );
    expect(onOpen).toHaveBeenLastCalledWith("ripple");
    fireEvent.click(c.querySelector('[data-image-blur-gallery="iris"]')!);
    expect(onBlur).toHaveBeenLastCalledWith("iris");
    fireEvent.click(c.querySelector('[data-image-one-shot="solarize"]')!);
    expect(onOneShot).toHaveBeenLastCalledWith("solarize");
    fireEvent.click(c.querySelector("[data-image-filter-gallery]")!);
    expect(onOpen).toHaveBeenLastCalledWith("filterGallery");
  });

  it("Curves' targeted adjustment toggles through onTarget", () => {
    const onTarget = mock((_on: boolean) => {});
    const view = render(
      <CurvesTools
        armed={null}
        disabled={false}
        onAuto={() => {}}
        onArm={() => {}}
        targeting={false}
        onTarget={onTarget}
      />,
    );
    const b = view.container.querySelector("[data-image-curves-target]")!;
    expect(b.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(b);
    expect(onTarget).toHaveBeenLastCalledWith(true);
  });
});
