// WP4.10 — the image panel's colour section: the Eyedropper's options
// (sample size, current layer / all layers) and the colour samplers' live
// readout (here, since the host Info panel has no door for a plugin's
// readouts yet).

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ColorSection } from "../src/panels/sections/color-section";
import { DEFAULT_COLORS, DEFAULT_EYEDROPPER } from "../src/color-state";
import type { ImageSession } from "../src/session";

afterEach(() => cleanup());

function harness(samplers: Parameters<typeof ColorSection>[0]["samplers"]) {
  const session = {
    colorPicker: () => null,
    setEyedropperOptions: mock(() => {}),
    removeColorSampler: mock(() => true),
    clearColorSamplers: mock(() => {}),
  } as unknown as ImageSession;
  const view = render(
    <ColorSection
      session={session}
      colors={DEFAULT_COLORS}
      gradientKind="linear"
      eyedropper={DEFAULT_EYEDROPPER}
      samplers={samplers}
    />,
  );
  return { session, view };
}

describe("the colour section's eyedropper and samplers [editor-shell.raster-color-binding]", () => {
  it("offers the seven sample sizes and the two sources, and sets them", () => {
    const { session, view } = harness([]);
    const size = view.container.querySelector<HTMLSelectElement>(
      "[data-image-sample-size]",
    )!;
    expect([...size.options].map((o) => o.textContent)).toEqual([
      "Point sample",
      "3 by 3 average",
      "5 by 5 average",
      "11 by 11 average",
      "31 by 31 average",
      "51 by 51 average",
      "101 by 101 average",
    ]);
    fireEvent.change(size, { target: { value: "31" } });
    expect(session.setEyedropperOptions).toHaveBeenCalledWith({ size: 31 });
    fireEvent.change(
      view.container.querySelector("[data-image-sample-source]")!,
      { target: { value: "layer" } },
    );
    expect(session.setEyedropperOptions).toHaveBeenCalledWith({
      source: "layer",
    });
    expect(
      view.container.querySelector("[data-image-samplers-empty]"),
    ).not.toBeNull();
  });

  it("lists each sampler's point and colour, and removes / clears them", () => {
    const { session, view } = harness([
      { id: 1, at: [3, 4], colour: [1, 0, 0, 1] },
      { id: 2, at: [9, 9], colour: null },
    ]);
    const rows = [...view.container.querySelectorAll("[data-image-sampler]")];
    expect(rows.map((r) => r.textContent)).toEqual([
      "#1 at 3, 4#ff0000 255 0 0×",
      "#2 at 9, 9off the image×",
    ]);
    fireEvent.click(
      view.container.querySelector('[data-image-sampler-remove="2"]')!,
    );
    expect(session.removeColorSampler).toHaveBeenCalledWith(2);
    fireEvent.click(
      view.container.querySelector("[data-image-samplers-clear]")!,
    );
    expect(session.clearColorSamplers).toHaveBeenCalled();
  });
});
