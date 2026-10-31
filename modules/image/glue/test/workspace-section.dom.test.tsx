// @feat: image.editor.workspace
//
// WP5.12 — the image panel's Workspace section and View ▸ New Guide…'s
// dialog: the ruler unit, Show / Lock / Snap to Guides, the Ruler's
// readout and Straighten, the count groups, the notes' text and the slices.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  NewGuideDialog,
  WorkspaceSection,
} from "../src/panels/sections/workspace-section";
import type { ImageSession } from "../src/session";
import type { WorkspaceState } from "../src/workspace";

afterEach(() => cleanup());

function harness(patch: Partial<WorkspaceState> = {}) {
  const state: WorkspaceState = {
    info: {
      guides: [{ orientation: "vertical", position: 3 }],
      counts: [
        { name: "Cells", color: [230, 30, 30], visible: true, marks: [[1, 1]] },
      ],
      activeCount: 0,
      notes: [{ at: [1, 1], author: "", text: "dust" }],
      slices: [{ x: 0, y: 0, w: 2, h: 2, name: "logo" }],
    },
    view: {
      rulerUnit: "px",
      guidesVisible: true,
      guidesLocked: false,
      snapToGuides: true,
    },
    ruler: { from: [0, 0], to: [3, -4] },
    cursor: null,
    hostView: null,
    ...patch,
  };
  const w = {
    state: () => state,
    rulerReadout: () => ({ dx: 3, dy: -4, distance: 5, angle: 53.13 }),
    setRulerUnit: mock(() => {}),
    setGuidesVisible: mock(() => {}),
    setGuidesLocked: mock(() => {}),
    setSnapToGuides: mock(() => {}),
    clearGuides: mock(() => true),
    straighten: mock(() => Promise.resolve(true)),
    setRuler: mock(() => {}),
    setActiveCountGroup: mock(() => true),
    setCountGroup: mock(() => true),
    newCountGroup: mock(() => true),
    clearCount: mock(() => true),
    deleteCountGroup: mock(() => true),
    editNote: mock(() => true),
    deleteNote: mock(() => true),
    slicesFromGuides: mock(() => true),
    exportSlices: mock(() => Promise.resolve(1)),
    setSlice: mock(() => true),
    deleteSlice: mock(() => true),
  };
  const session = {
    state: () => ({ source: { width: 4, height: 2 } }),
    workspace: () => w,
    openDialog: mock(() => true),
    onDidChange: () => ({ dispose() {} }),
  } as unknown as ImageSession;
  const view = render(<WorkspaceSection session={session} disabled={false} />);
  const $ = <T extends Element = HTMLElement>(sel: string) =>
    view.container.querySelector<T & HTMLElement>(sel)!;
  return { session, w, view, $ };
}

describe("the Workspace section", () => {
  it("sets the ruler unit and the guide toggles, and opens New Guide…", () => {
    const { session, w, $ } = harness();
    const unit = $<HTMLSelectElement>("[data-image-ruler-unit]");
    expect([...unit.options].map((o) => o.textContent)).toEqual([
      "Pixels",
      "Inches",
      "Centimetres",
      "Millimetres",
    ]);
    fireEvent.change(unit, { target: { value: "cm" } });
    expect(w.setRulerUnit).toHaveBeenCalledWith("cm");
    fireEvent.click($("[data-image-show-guides]"));
    expect(w.setGuidesVisible).toHaveBeenCalledWith(false);
    fireEvent.click($("[data-image-lock-guides]"));
    expect(w.setGuidesLocked).toHaveBeenCalledWith(true);
    fireEvent.click($("[data-image-snap-guides]"));
    expect(w.setSnapToGuides).toHaveBeenCalledWith(false);
    expect($("[data-image-guide-count]").textContent).toBe("1 guides");
    fireEvent.click($("[data-image-new-guide]"));
    expect(session.openDialog).toHaveBeenCalledWith("newGuide");
    fireEvent.click($("[data-image-clear-guides]"));
    expect(w.clearGuides).toHaveBeenCalled();
  });

  it("shows the Ruler's measurement and straightens or clears it", () => {
    const { w, $ } = harness();
    expect($("[data-image-ruler-readout]").textContent).toBe("5 px · 53.1°");
    fireEvent.click($("[data-image-straighten]"));
    expect(w.straighten).toHaveBeenCalled();
    fireEvent.click($("[data-image-clear-ruler]"));
    expect(w.setRuler).toHaveBeenCalledWith(null);
  });

  it("lists count groups, notes and slices and edits them", () => {
    const { w, $ } = harness();
    expect($("[data-image-count-total]").textContent).toBe("1 marks");
    fireEvent.click($("[data-image-count-visible]"));
    expect(w.setCountGroup).toHaveBeenCalledWith(0, { visible: false });
    fireEvent.click($("[data-image-count-new-group]"));
    expect(w.newCountGroup).toHaveBeenCalled();
    fireEvent.click($("[data-image-count-clear]"));
    expect(w.clearCount).toHaveBeenCalled();
    const text = $<HTMLTextAreaElement>('[data-image-note-text="0"]');
    expect(text.value).toBe("dust");
    fireEvent.change(text, { target: { value: "dust spot" } });
    fireEvent.blur(text);
    expect(w.editNote).toHaveBeenCalledWith(0, "dust spot");
    fireEvent.click($('[data-image-note-delete="0"]'));
    expect(w.deleteNote).toHaveBeenCalledWith(0);
    const name = $<HTMLInputElement>('[data-image-slice-name="0"]');
    fireEvent.change(name, { target: { value: "hero" } });
    fireEvent.blur(name);
    expect(w.setSlice).toHaveBeenCalledWith(
      0,
      { x: 0, y: 0, w: 2, h: 2, name: "logo" },
      "hero",
    );
    fireEvent.click($("[data-image-slices-from-guides]"));
    expect(w.slicesFromGuides).toHaveBeenCalled();
    fireEvent.click($("[data-image-slices-export]"));
    expect(w.exportSlices).toHaveBeenCalled();
    fireEvent.click($('[data-image-slice-delete="0"]'));
    expect(w.deleteSlice).toHaveBeenCalledWith(0);
  });

  it("says what to do when nothing is measured, noted or sliced", () => {
    const { $, view } = harness({
      ruler: null,
      info: { guides: [], counts: [], activeCount: 0, notes: [], slices: [] },
    });
    expect(view.container.textContent).toContain(
      "Drag with the Ruler tool to measure.",
    );
    expect(view.container.textContent).toContain(
      "Click with the Note tool to pin a note.",
    );
    expect($<HTMLButtonElement>("[data-image-straighten]").disabled).toBe(true);
  });
});

describe("New Guide…", () => {
  it("adds a guide at the position in the ruler unit, converted to pixels", () => {
    const onAdd = mock(() => {});
    const onCancel = mock(() => {});
    const view = render(
      <NewGuideDialog
        unit="in"
        pxPerUnit={300}
        onAdd={onAdd}
        onCancel={onCancel}
      />,
    );
    const q = (s: string) => view.container.querySelector<HTMLElement>(s)!;
    fireEvent.click(q('[data-image-guide-dir="horizontal"]'));
    fireEvent.change(q("[data-image-guide-position]"), {
      target: { value: "1.5" },
    });
    fireEvent.click(q("[data-image-guide-add]"));
    expect(onAdd).toHaveBeenCalledWith("horizontal", 450);
    fireEvent.click(q("[data-dialog-cancel]"));
    expect(onCancel).toHaveBeenCalled();
  });
});
