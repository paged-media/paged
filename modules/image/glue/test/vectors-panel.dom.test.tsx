// The Paths section's vector verbs and the Vector mask section (WP5.11,
// image ADR 476) as components: what a control says is what reaches its
// callback, the work path is marked, and German renders.

import { afterEach, describe, expect, it } from "bun:test";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";
import { cleanup, fireEvent, render } from "@testing-library/react";

// Registers the bundle's German catalogue.
import "../src/activate";

import type { MaskingInfo } from "../src/masking-engine";
import {
  PathsSection,
  VectorMaskSection,
} from "../src/panels/sections/masking-section";

afterEach(() => {
  cleanup();
  setActiveStrings(createStrings());
});

const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement;

const INFO: MaskingInfo = {
  channels: [],
  paths: [
    { id: 3, name: "Work Path", work: true, subpaths: 1, anchors: 4 },
    { id: 4, name: "Outline", work: false, subpaths: 2, anchors: 9 },
  ],
  quickMask: null,
  editChannel: null,
};

const noop = () => {};

describe("[image.paths.vectors] the Paths section's vector verbs", () => {
  it("target, fill, stroke, vector mask and save reach their callbacks", () => {
    const calls: unknown[][] = [];
    const { container } = render(
      <PathsSection
        info={INFO}
        disabled={false}
        hasSelection={false}
        target={4}
        onMakeWorkPath={noop}
        onMakeSelection={noop}
        onRename={noop}
        onDuplicate={noop}
        onDelete={noop}
        onTarget={(id) => calls.push(["target", id])}
        onFill={(id) => calls.push(["fill", id])}
        onStroke={(id) => calls.push(["stroke", id])}
        onSave={() => calls.push(["save"])}
        onVectorMask={(id) => calls.push(["mask", id])}
      />,
    );
    expect(
      (q(container, '[data-vector-path-target="4"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(q(container, '[data-vector-path-target="3"]'));
    fireEvent.click(q(container, '[data-vector-path-fill="4"]'));
    fireEvent.click(q(container, '[data-vector-path-stroke="3"]'));
    fireEvent.click(q(container, '[data-vector-path-mask="4"]'));
    // Only the work path offers Save.
    expect(q(container, '[data-vector-path-save="4"]')).toBeNull();
    fireEvent.click(q(container, '[data-vector-path-save="3"]'));
    expect(calls).toEqual([
      ["target", 3],
      ["fill", 4],
      ["stroke", 3],
      ["mask", 4],
      ["save"],
    ]);
    expect(container.textContent).toContain("work path");
  });
});

describe("[image.paths.vectors] the Vector mask section", () => {
  it("offers reveal all / hide all without a mask, and the switches with one", () => {
    const calls: unknown[] = [];
    const props = {
      editing: false,
      disabled: false,
      onAdd: (s: string) => calls.push(s),
      onEdit: () => calls.push("edit"),
      onToggle: () => calls.push("toggle"),
      onInvert: () => calls.push("invert"),
      onRasterize: () => calls.push("rasterize"),
      onDelete: () => calls.push("delete"),
    };
    const a = render(
      <VectorMaskSection
        layer={{ name: "Sky", vectorMask: null }}
        {...props}
      />,
    );
    fireEvent.click(q(a.container, "[data-vector-mask-reveal-all]"));
    fireEvent.click(q(a.container, "[data-vector-mask-hide-all]"));
    expect(q(a.container, "[data-vector-mask-toggle]")).toBeNull();
    cleanup();
    const b = render(
      <VectorMaskSection
        layer={{
          name: "Sky",
          vectorMask: { enabled: false, invert: true, subpaths: 2 },
        }}
        {...props}
      />,
    );
    expect(q(b.container, "[data-vector-mask-state]").textContent).toBe(
      "Sky: 2 subpath(s), disabled, inverted",
    );
    expect(q(b.container, "[data-vector-mask-toggle]").textContent).toBe(
      "Enable",
    );
    expect(
      (q(b.container, "[data-vector-mask-rasterize]") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    for (const k of ["edit", "toggle", "invert", "delete"])
      fireEvent.click(q(b.container, `[data-vector-mask-${k}]`));
    expect(calls).toEqual([
      "revealAll",
      "hideAll",
      "edit",
      "toggle",
      "invert",
      "delete",
    ]);
  });

  it("renders in German", () => {
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    const { container } = render(
      <VectorMaskSection
        layer={{ name: "Himmel", vectorMask: null }}
        editing={false}
        disabled={false}
        onAdd={noop}
        onEdit={noop}
        onToggle={noop}
        onInvert={noop}
        onRasterize={noop}
        onDelete={noop}
      />,
    );
    expect(container.textContent).toContain("Vektormaske");
    expect(container.textContent).toContain("Alles einblenden");
  });
});
