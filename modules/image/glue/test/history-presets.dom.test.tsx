// Image ADR 477 as components (the DOM lane): the Preset Manager dialog,
// History Options, the snapshots and the History brush source under the
// Layers section, in English and German.

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";
import { cleanup, fireEvent, render } from "@testing-library/react";

import "../src/activate";
import type { LayerHistory } from "../src/engine";
import { builtInGradients, type PresetEntry } from "../src/preset-library";
import { HistorySection } from "../src/panels/sections/history-section";
import {
  HistoryOptionsDialog,
  PresetManagerDialog,
} from "../src/panels/sections/preset-manager";

afterEach(() => {
  cleanup();
  setActiveStrings(createStrings());
});

const FEAT = "[image.editor.snapshots-presets]";

function manager(entries: readonly PresetEntry[]) {
  const cb = {
    onTab: mock((_k: string) => {}),
    onApply: mock((_id: string) => {}),
    onRename: mock((_id: string, _n: string) => {}),
    onDelete: mock((_id: string) => {}),
    onMove: mock((_f: number, _t: number) => {}),
    onSave: mock((_n: string) => {}),
    onImport: mock(() => {}),
    onExport: mock(() => {}),
    onClose: mock(() => {}),
  };
  const r = render(
    <PresetManagerDialog
      tab="gradients"
      entries={entries}
      busy={false}
      {...cb}
    />,
  );
  const q = (sel: string) =>
    r.container.querySelector(sel) as HTMLInputElement | null;
  return { r, q, ...cb };
}

describe(`${FEAT} the Preset Manager dialog`, () => {
  const entries = [
    ...builtInGradients().slice(0, 1),
    { id: "g-2", name: "Mine" },
    { id: "g-3", name: "Other" },
  ];

  it("shows every kind's tab and switches", () => {
    const v = manager(entries);
    const tabs = [...v.r.container.querySelectorAll("[data-preset-tab]")].map(
      (b) => b.getAttribute("data-preset-tab"),
    );
    expect(tabs).toEqual([
      "brushes",
      "tools",
      "adjustments",
      "gradients",
      "patterns",
      "styles",
    ]);
    expect(
      v.q('[data-preset-tab="gradients"]')!.getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(v.q('[data-preset-tab="styles"]')!);
    expect(v.onTab).toHaveBeenCalledWith("styles");
  });

  it("applies, renames in place, reorders and deletes; a built-in stays", () => {
    const v = manager(entries);
    fireEvent.click(v.q('[data-preset-apply="g-2"]')!);
    expect(v.onApply).toHaveBeenCalledWith("g-2");
    fireEvent.click(v.q('[data-preset-rename="g-2"]')!);
    const input = v.q('[data-preset-rename-input="g-2"]')!;
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(v.onRename).toHaveBeenCalledWith("g-2", "Renamed");
    expect(v.q('[data-preset-up="builtin-black-white"]')!.disabled).toBe(true);
    fireEvent.click(v.q('[data-preset-down="g-2"]')!);
    expect(v.onMove).toHaveBeenCalledWith(1, 2);
    expect(v.q('[data-preset-delete="builtin-black-white"]')!.disabled).toBe(
      true,
    );
    fireEvent.click(v.q('[data-preset-delete="g-3"]')!);
    expect(v.onDelete).toHaveBeenCalledWith("g-3");
  });

  it("saves the current settings under a name, imports and exports", () => {
    const v = manager(entries);
    fireEvent.change(v.q("[data-preset-new-name]")!, {
      target: { value: "New one" },
    });
    fireEvent.click(v.q('[data-preset-save="gradients"]')!);
    expect(v.onSave).toHaveBeenCalledWith("New one");
    fireEvent.click(v.q('[data-preset-import="gradients"]')!);
    fireEvent.click(v.q('[data-preset-export="gradients"]')!);
    expect(v.onImport).toHaveBeenCalled();
    expect(v.onExport).toHaveBeenCalled();
    expect(v.r.container.textContent).toContain(".grd");
  });

  it("says when a kind is empty, and cannot export nothing", () => {
    const v = manager([]);
    expect(v.q("[data-preset-empty]")).not.toBeNull();
    expect(v.q('[data-preset-export="gradients"]')!.disabled).toBe(true);
  });

  it("speaks German", () => {
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    const v = manager(entries);
    expect(v.r.container.textContent).toContain("Vorgaben-Manager");
    expect(v.r.container.textContent).toContain("Verläufe");
  });
});

describe(`${FEAT} History Options`, () => {
  it("applies the depth, the memory and the automatic snapshot", () => {
    const onApply = mock((_p: unknown) => {});
    const r = render(
      <HistoryOptionsDialog
        prefs={{ depth: 32, memoryMb: 256, autoSnapshot: true }}
        usedBytes={3 * 1024 * 1024}
        snapshotBytes={0}
        onApply={onApply}
        onCancel={() => {}}
      />,
    );
    const q = (sel: string) =>
      r.container.querySelector(sel) as HTMLInputElement;
    fireEvent.change(q("[data-history-depth-input]"), {
      target: { value: "200" },
    });
    fireEvent.change(q("[data-history-memory-input]"), {
      target: { value: "1024" },
    });
    fireEvent.click(q("[data-history-auto-snapshot]"));
    fireEvent.click(q("[data-history-options-apply]"));
    expect(onApply).toHaveBeenCalledWith({
      depth: 200,
      memoryMb: 1024,
      autoSnapshot: false,
    });
    expect(q("[data-history-memory-used]").textContent).toContain("3.0 MB");
  });
});

describe(`${FEAT} snapshots under the Layers section`, () => {
  const history = {
    undoSteps: ["Paint"],
    undoIds: [4],
    redoSteps: [],
    redoIds: [],
    snapshots: [{ id: 1, name: "Opened", width: 4, height: 2 }],
    snapshotBytes: 2 * 1024 * 1024,
  } as unknown as LayerHistory;

  it("takes, restores, renames and deletes snapshots and picks the brush source", () => {
    const cb = {
      onSnapshot: mock(() => {}),
      onRestore: mock((_id: number) => {}),
      onRename: mock((_id: number, _n: string) => {}),
      onDelete: mock((_id: number) => {}),
      onSource: mock((_s: string) => {}),
      onOptions: mock(() => {}),
    };
    const r = render(
      <HistorySection
        history={history}
        source="open"
        disabled={false}
        {...cb}
      />,
    );
    const q = (sel: string) =>
      r.container.querySelector(sel) as HTMLInputElement;
    fireEvent.click(q("[data-image-snapshot-new]"));
    expect(cb.onSnapshot).toHaveBeenCalled();
    fireEvent.click(q('[data-image-snapshot-restore="1"]'));
    expect(cb.onRestore).toHaveBeenCalledWith(1);
    fireEvent.click(q('[data-image-snapshot-rename="1"]'));
    const input = q('[data-image-snapshot-name-input="1"]');
    fireEvent.change(input, { target: { value: "Start" } });
    fireEvent.blur(input);
    expect(cb.onRename).toHaveBeenCalledWith(1, "Start");
    fireEvent.click(q('[data-image-snapshot-delete="1"]'));
    expect(cb.onDelete).toHaveBeenCalledWith(1);
    const select = r.container.querySelector(
      "[data-image-history-source]",
    ) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "open",
      "previous",
      "snapshot:1",
      "step:4",
    ]);
    fireEvent.change(select, { target: { value: "step:4" } });
    expect(cb.onSource).toHaveBeenCalledWith("step:4");
    fireEvent.click(q("[data-image-history-options-open]"));
    expect(cb.onOptions).toHaveBeenCalled();
    expect(r.container.textContent).toContain("2.0 MB");
  });

  it("speaks German", () => {
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    const r = render(
      <HistorySection
        history={history}
        source="open"
        disabled={false}
        onSnapshot={() => {}}
        onRestore={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onSource={() => {}}
        onOptions={() => {}}
      />,
    );
    expect(r.container.textContent).toContain("Schnappschüsse");
    expect(r.container.textContent).toContain("Neuer Schnappschuss");
  });
});
