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
import { dialAngle, FilterDialog } from "../src/panels/sections/filter-dialog";
import {
  ImageSizeDialog,
  lengthToPx,
  pxToLength,
  RotateDialog,
  TrimDialog,
} from "../src/panels/sections/image-dialogs";
import { CurvesTools } from "../src/panels/sections/curves-tools";

afterEach(() => cleanup());

function filterHarness(id: Parameters<typeof filterDef>[0], gpu = true) {
  const def = filterDef(id);
  const onChange = mock((_p: Record<string, FilterValue>) => {});
  const onPreview = mock((_on: boolean) => {});
  const onBefore = mock((_b: boolean) => {});
  const onOk = mock(() => {});
  const onCancel = mock(() => {});
  function Harness() {
    const [dialog, setDialog] = useState<FilterDialogState>({
      id,
      values: filterDefaults(def),
      preview: true,
      before: false,
      applied: true,
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
      />
    );
  }
  const view = render(<Harness />);
  const q = (sel: string) =>
    view.container.querySelector(sel) as HTMLInputElement | null;
  return { view, q, onChange, onPreview, onBefore, onOk, onCancel };
}

describe("the Filter dialog component", () => {
  it("draws every parameter of every filter's schema", () => {
    for (const def of FILTERS) {
      const { view } = filterHarness(def.id);
      const shown = [
        ...view.container.querySelectorAll("[data-filter-param]"),
      ].map((e) => e.getAttribute("data-filter-param"));
      expect(shown).toEqual(def.params.map((p) => p.key));
      expect(
        view.container.querySelector(`[data-filter-dialog="${def.id}"]`),
      ).not.toBeNull();
      cleanup();
    }
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
