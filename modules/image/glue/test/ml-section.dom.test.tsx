// The ML section as a component (the DOM lane): what the fields say is what
// reaches the session's ML controller, the strip places a candidate, and the
// buttons go inert while a model works or no selection exists.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { MlUiState } from "../src/ml-features";
import { MlSection } from "../src/panels/sections/ml-section";
import type { ImageSession } from "../src/session";

afterEach(() => cleanup());

function harness(
  o: {
    ml?: Partial<MlUiState>;
    hasSelection?: boolean;
    disabled?: boolean;
  } = {},
) {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec =
    (name: string) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a]);
      return true;
    };
  const features = {
    generateImage: mock(rec("generateImage")),
    generativeFill: mock(rec("generativeFill")),
    generativeExpand: mock(rec("generativeExpand")),
    removeSelection: mock(rec("removeSelection")),
    removeBackground: mock(rec("removeBackground")),
    skyReplacement: mock(rec("skyReplacement")),
    colorize: mock(rec("colorize")),
    skinSmoothing: mock(rec("skinSmoothing")),
    superZoom: mock(rec("superZoom")),
    removeJpegArtifacts: mock(rec("removeJpegArtifacts")),
    setReferences: mock((ids: number[]) => {
      calls.push(["setReferences", ids]);
      return true;
    }),
    placeCandidate: mock(rec("placeCandidate")),
    clearCandidates: mock(() => {
      calls.push(["clearCandidates"]);
    }),
  };
  const session = {
    ml: () => features,
    state: () => ({
      layers: { layers: [{ id: 7, index: 1, kind: "smart" }] },
    }),
    smart: () => ({
      info: () => ({ file: { name: "ref.png", available: true } }),
    }),
  } as unknown as ImageSession;
  const view = render(
    <MlSection
      session={session}
      ml={{
        busy: false,
        candidates: [],
        note: null,
        references: [],
        ...o.ml,
      }}
      canvas={{ width: 400, height: 200 }}
      hasSelection={o.hasSelection ?? true}
      disabled={o.disabled ?? false}
    />,
  );
  const q = (attr: string) =>
    view.container.querySelector(`[${attr}]`) as HTMLInputElement | null;
  return { view, q, calls, features };
}

describe("the ML section", () => {
  it("sends the prompt, seed, steps and variations to Generate", () => {
    const { q, features } = harness();
    fireEvent.change(q('data-image-ml="prompt"')!, {
      target: { value: "a lake" },
    });
    fireEvent.change(view_id("pg-image-ml-seed"), { target: { value: "7" } });
    fireEvent.change(view_id("pg-image-ml-variations"), {
      target: { value: "3" },
    });
    fireEvent.click(q('data-image-ml="generate"')!);
    expect(features.generateImage).toHaveBeenCalledWith("a lake", {
      seed: 7,
      steps: 20,
      variations: 3,
    });
  });

  it("Generative Fill and Remove need a selection", () => {
    const off = harness({ hasSelection: false });
    expect(off.q('data-image-ml="fill"')!.disabled).toBe(true);
    expect(off.q('data-image-ml="removeHq"')!.disabled).toBe(true);
    cleanup();
    const on = harness();
    fireEvent.click(on.q('data-image-ml="fill"')!);
    expect(on.features.generativeFill).toHaveBeenCalled();
    fireEvent.click(on.q('data-image-ml="removeHq"')!);
    expect(on.features.removeSelection).toHaveBeenCalled();
  });

  it("Expand sends the percentage of the canvas and the anchors", () => {
    const { q, features } = harness();
    fireEvent.click(q('data-image-ml="expand"')!);
    expect(features.generativeExpand).toHaveBeenCalledWith(
      "",
      { width: 600, height: 300, anchorX: 1, anchorY: 1 },
      { seed: -1, steps: 20 },
    );
  });

  it("the presets and the neural filters call their verbs", () => {
    const { q, features } = harness();
    fireEvent.click(q('data-image-ml="sky"')!);
    fireEvent.click(q('data-image-ml="colorize"')!);
    fireEvent.click(q('data-image-ml="skin"')!);
    fireEvent.click(q('data-image-ml="superZoom"')!);
    fireEvent.click(q('data-image-ml="superZoom4"')!);
    fireEvent.click(q('data-image-ml="jpeg"')!);
    fireEvent.click(q('data-image-ml="removeBg"')!);
    expect(features.skyReplacement).toHaveBeenCalled();
    expect(features.colorize).toHaveBeenCalled();
    expect(features.skinSmoothing).toHaveBeenCalled();
    expect(features.superZoom.mock.calls.map((c) => c[0])).toEqual([2, 4]);
    expect(features.removeJpegArtifacts).toHaveBeenCalled();
    expect(features.removeBackground).toHaveBeenCalled();
  });

  it("the strip places a candidate and discards the rest", () => {
    const { q, features } = harness({
      ml: {
        candidates: [
          {
            id: 5,
            width: 1,
            height: 1,
            data: new Uint8ClampedArray([1, 2, 3, 255]),
            provider: "p",
          },
        ],
      },
    });
    fireEvent.click(q("data-image-ml-candidate")!);
    expect(features.placeCandidate).toHaveBeenCalledWith(5, "Generated");
    fireEvent.click(q('data-image-ml="strip"')!.querySelectorAll("button")[1]!);
    expect(features.clearCandidates).toHaveBeenCalled();
  });

  it("everything is inert while a model works", () => {
    const { q, view } = harness({ ml: { busy: true } });
    for (const k of ["generate", "fill", "removeBg", "sky", "jpeg"])
      expect(q(`data-image-ml="${k}"`)!.disabled).toBe(true);
    expect(view.container.textContent).toMatch(/Working with the local/);
  });

  it("picks the Links panel's smart objects as references", () => {
    const { q, calls } = harness({ ml: { references: [] } });
    fireEvent.click(q("data-image-ml-reference")!);
    expect(calls).toContainEqual(["setReferences", [7]]);
  });
});

function view_id(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
