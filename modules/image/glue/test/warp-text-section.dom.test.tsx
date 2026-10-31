// WARP TEXT as a component (the DOM lane, WP5.10): the Image panel's Warp
// text section sends the style, the bend, both distortions and the
// orientation the controls show — Photoshop's percent, as −1 to 1.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import { WarpTextSection } from "../src/panels/image-panel";
import { NO_WARP, type TypeWarp } from "../src/type-layer";

afterEach(() => cleanup());

function harness() {
  const sent = mock((_w: TypeWarp) => {});
  function Harness() {
    const [warp, setWarp] = useState<TypeWarp>({ ...NO_WARP });
    return (
      <WarpTextSection
        warp={warp}
        disabled={false}
        onChange={(w) => {
          sent(w);
          setWarp(w);
        }}
      />
    );
  }
  const view = render(<Harness />);
  const q = (sel: string) =>
    view.container.querySelector(sel) as HTMLInputElement | null;
  return { view, q, sent };
}

describe("the Warp text section [image.layers.type]", () => {
  it("lists the fifteen styles and None", () => {
    const { q } = harness();
    const select = q("[data-image-warp-style]") as unknown as HTMLSelectElement;
    expect(select.options.length).toBe(16);
  });

  it("sends the chosen style, its bend in −1 to 1, and the orientation", () => {
    const { q, sent } = harness();
    fireEvent.change(q("[data-image-warp-style]")!, {
      target: { value: "flag" },
    });
    expect(sent).toHaveBeenLastCalledWith({ ...NO_WARP, style: "flag" });
    const ranges = q("[data-image-warp-section]")!.querySelectorAll(
      'input[type="range"]',
    );
    fireEvent.change(ranges[0]!, { target: { value: "-40" } });
    expect(sent.mock.calls.at(-1)![0].bend).toBeCloseTo(-0.4);
    fireEvent.change(ranges[1]!, { target: { value: "25" } });
    expect(sent.mock.calls.at(-1)![0].horizontal).toBeCloseTo(0.25);
    fireEvent.click(q("[data-image-warp-vertical]")!);
    expect(sent.mock.calls.at(-1)![0].rotateVertical).toBe(true);
  });
});
