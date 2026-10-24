// BRUSH PRESETS as a component (the DOM lane): the list with its active
// row, rename in place (Enter or blur commits; an unchanged name sends
// nothing), delete, reorder at the ends, Define / Import / Export, and the
// connected panel over a session.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { covers } from "@paged-media/test-kit";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import "../src/activate";
import {
  defaultPresets,
  renamePreset,
  type UserBrushPreset,
} from "../src/brush-presets";
import {
  BrushPresetsView,
  makeBrushPresetsPanel,
  type BrushPresetsSession,
} from "../src/panels/brush-presets-panel";

const ID = "panel:media.paged.image.panel.brushPresets";

afterEach(() => {
  cleanup();
  setActiveStrings(createStrings());
});

function view(presets: readonly UserBrushPreset[], active: string | null) {
  const cb = {
    onApply: mock((_id: string) => {}),
    onRename: mock((_id: string, _n: string) => {}),
    onDelete: mock((_id: string) => {}),
    onMove: mock((_f: number, _t: number) => {}),
    onDefine: mock(() => {}),
    onImport: mock(() => {}),
    onExport: mock((_f: "abr" | "json") => {}),
  };
  const r = render(
    <BrushPresetsView
      presets={presets}
      active={active}
      disabled={false}
      {...cb}
    />,
  );
  const q = (sel: string) =>
    r.container.querySelector(sel) as HTMLInputElement | null;
  return { r, q, ...cb };
}

describe("Brush Presets", () => {
  const presets = defaultPresets().slice(0, 3);
  const [a, b, c] = presets;

  it("lists the presets, marks the active one and applies on click", () => {
    covers("panel:media.paged.image.panel.brushPresets");
    const v = view(presets, b.id);
    expect(
      v.r.container.querySelectorAll("[data-brush-preset-row]"),
    ).toHaveLength(3);
    const active = v.r.container.querySelectorAll("[data-brush-preset-active]");
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("data-brush-preset-row")).toBe(b.id);
    expect(v.q(`[data-brush-preset-apply="${a.id}"]`)!.textContent).toBe(
      "10 px",
    );
    fireEvent.click(v.q(`[data-brush-preset-apply="${c.id}"]`)!);
    expect(v.onApply).toHaveBeenCalledWith(c.id);
  });

  it("renames on Enter and on blur, and sends nothing for an unchanged name", () => {
    covers("panel:media.paged.image.panel.brushPresets");
    const v = view(presets, null);
    const name = v.q(`[data-brush-preset-name="${a.id}"]`)!;
    expect(name.value).toBe(a.name);
    fireEvent.blur(name);
    expect(v.onRename).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Chalk" } });
    fireEvent.blur(name);
    expect(v.onRename).toHaveBeenCalledWith(a.id, "Chalk");
    const other = v.q(`[data-brush-preset-name="${b.id}"]`)!;
    other.focus();
    fireEvent.change(other, { target: { value: "Ink" } });
    fireEvent.keyDown(other, { key: "Enter" });
    expect(v.onRename).toHaveBeenLastCalledWith(b.id, "Ink");
  });

  it("moves up and down, greyed at the ends, and deletes", () => {
    covers("panel:media.paged.image.panel.brushPresets");
    const v = view(presets, null);
    expect(v.q(`[data-brush-preset-up="${a.id}"]`)!.disabled).toBe(true);
    expect(v.q(`[data-brush-preset-down="${c.id}"]`)!.disabled).toBe(true);
    fireEvent.click(v.q(`[data-brush-preset-down="${a.id}"]`)!);
    expect(v.onMove).toHaveBeenLastCalledWith(0, 1);
    fireEvent.click(v.q(`[data-brush-preset-up="${c.id}"]`)!);
    expect(v.onMove).toHaveBeenLastCalledWith(2, 1);
    fireEvent.click(v.q(`[data-brush-preset-delete="${b.id}"]`)!);
    expect(v.onDelete).toHaveBeenCalledWith(b.id);
  });

  it("defines, imports and exports in both formats", () => {
    covers("panel:media.paged.image.panel.brushPresets");
    const v = view(presets, null);
    fireEvent.click(v.q("[data-brush-preset-define]")!);
    expect(v.onDefine).toHaveBeenCalledTimes(1);
    fireEvent.click(v.q("[data-brush-preset-import]")!);
    expect(v.onImport).toHaveBeenCalledTimes(1);
    fireEvent.click(v.q('[data-brush-preset-export="abr"]')!);
    expect(v.onExport).toHaveBeenLastCalledWith("abr");
    fireEvent.click(v.q('[data-brush-preset-export="json"]')!);
    expect(v.onExport).toHaveBeenLastCalledWith("json");
  });

  it("an empty library says how to fill it, and has nothing to export", () => {
    covers("panel:media.paged.image.panel.brushPresets");
    const v = view([], null);
    expect(v.q("[data-brush-presets-empty]")).not.toBeNull();
    expect(v.q('[data-brush-preset-export="abr"]')!.disabled).toBe(true);
  });

  it("renders in German", () => {
    covers("panel:media.paged.image.panel.brushPresets");
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    const v = view(presets, null);
    expect(v.r.container.textContent).toContain("Pinselvorgaben");
    expect(v.q("[data-brush-preset-define]")!.textContent).toBe(
      "Aus Auswahl festlegen",
    );
  });

  it("the connected panel follows the session", () => {
    covers("panel:media.paged.image.panel.brushPresets");
    let list: readonly UserBrushPreset[] = presets;
    const listeners = new Set<() => void>();
    const emit = () => {
      for (const l of listeners) l();
    };
    const session: BrushPresetsSession = {
      state: () => ({ brushPresets: list, brushPresetActive: null }),
      defineBrushPreset: mock(async () => true),
      applyUserPreset: mock(() => true),
      renameBrushPreset: mock((id: string, name: string) => {
        list = renamePreset(list, id, name);
        emit();
      }),
      deleteBrushPreset: mock(() => {}),
      moveBrushPreset: mock(() => {}),
      importBrushPresets: mock(async () => true),
      exportBrushPresets: mock(async () => true),
      onDidChange: (l) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
    };
    const Panel = makeBrushPresetsPanel(session);
    const r = render(<Panel />);
    const name = () =>
      r.container.querySelector(
        `[data-brush-preset-name="${a.id}"]`,
      ) as HTMLInputElement;
    act(() => {
      fireEvent.change(name(), { target: { value: "Renamed" } });
      fireEvent.blur(name());
    });
    expect(session.renameBrushPreset).toHaveBeenCalledWith(a.id, "Renamed");
    expect(name().value).toBe("Renamed");
    act(() => {
      fireEvent.click(
        r.container.querySelector('[data-brush-preset-export="json"]')!,
      );
    });
    expect(session.exportBrushPresets).toHaveBeenCalledWith("json");
    act(() => {
      fireEvent.click(r.container.querySelector("[data-brush-preset-define]")!);
    });
    expect(session.defineBrushPreset).toHaveBeenCalledTimes(1);
  });
});
