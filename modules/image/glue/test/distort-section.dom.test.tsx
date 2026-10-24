// FILTER ▸ Distort as a component (the DOM lane). The section used to
// apply every warp at a hard-coded amount of 0.4 and Glass at a 0.4 px
// distortion; these pin that what the sliders say is what reaches the
// session — per kind, with the wave's frequency, and Glass's size and
// distortion.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import {
  DISTORT_DEFAULTS,
  DistortSection,
  type DistortParams,
} from "../src/panels/sections/distort-section";
import type { ImageSession } from "../src/session";

afterEach(() => cleanup());

function harness(disabled = false) {
  const applyWarp = mock(async () => true);
  const galleryGlass = mock(async () => true);
  const session = { applyWarp, galleryGlass } as unknown as ImageSession;
  function Harness() {
    const [params, setParams] = useState<DistortParams>(DISTORT_DEFAULTS);
    return (
      <DistortSection
        session={session}
        params={params}
        onParams={setParams}
        disabled={disabled}
      />
    );
  }
  const view = render(<Harness />);
  const q = (attr: string) =>
    // Inputs and buttons alike: both carry `value` / `disabled`.
    view.container.querySelector(`[${attr}]`) as HTMLInputElement | null;
  return { view, q, applyWarp, galleryGlass };
}

describe("the Distort section", () => {
  it("applies the warp at the slider's amount, not a constant", () => {
    const { q, applyWarp } = harness();
    fireEvent.change(q("data-image-warp-amount")!, {
      target: { value: "-0.75" },
    });
    fireEvent.click(q('data-image-warp="pinch"')!);
    expect(applyWarp).toHaveBeenCalledWith("pinch", -0.75, 1);
  });

  it("keeps an amount per kind and sends the wave's frequency", () => {
    const { q, applyWarp } = harness();
    fireEvent.change(q("data-image-warp-amount")!, {
      target: { value: "0.9" },
    });
    // Twirl has its own amount (an angle), untouched by pinch's.
    fireEvent.click(q('data-image-warp-kind="twirl"')!);
    expect(q("data-image-warp-amount")!.value).toBe("1.5");
    expect(q("data-image-warp-frequency")).toBeNull();
    fireEvent.click(q('data-image-warp-kind="wave"')!);
    fireEvent.change(q("data-image-warp-amount")!, {
      target: { value: "1.2" },
    });
    fireEvent.change(q("data-image-warp-frequency")!, {
      target: { value: "4" },
    });
    fireEvent.click(q('data-image-warp="wave"')!);
    expect(applyWarp).toHaveBeenCalledWith("wave", 1.2, 4);
    // Back on pinch, its own amount is still there.
    fireEvent.click(q('data-image-warp-kind="pinch"')!);
    fireEvent.click(q('data-image-warp="pinch"')!);
    expect(applyWarp).toHaveBeenLastCalledWith("pinch", 0.9, 1);
  });

  it("applies Glass with its size and distortion", () => {
    const { q, galleryGlass } = harness();
    fireEvent.change(q("data-image-glass-scale")!, { target: { value: "40" } });
    fireEvent.change(q("data-image-glass-distortion")!, {
      target: { value: "12.5" },
    });
    fireEvent.click(q("data-image-glass")!);
    expect(galleryGlass).toHaveBeenCalledWith(1, 40, 12.5, 1);
  });

  it("disables both Apply buttons without an image or a GPU", () => {
    const { q } = harness(true);
    expect(q('data-image-warp="pinch"')!.disabled).toBe(true);
    expect(q("data-image-glass")!.disabled).toBe(true);
  });
});
