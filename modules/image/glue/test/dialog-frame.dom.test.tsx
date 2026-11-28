// The image panel's dialogs share one frame (focus moves in on open, Tab
// stays inside, Escape cancels, focus returns to the opener), and a layer is
// renamed in a field of the panel, not in a `window.prompt`.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import { DialogFrame } from "../src/panels/sections/dialog-frame";
import { RotateDialog, TrimDialog } from "../src/panels/sections/image-dialogs";
import { NewGuideDialog } from "../src/panels/sections/workspace-section";
import { LayerName } from "../src/panels/sections/layer-name";

afterEach(() => cleanup());

/** A panel with an opener button and a dialog that Escape / Cancel closes. */
function Panel({ onCancel }: { onCancel: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" data-open onClick={() => setOpen(true)}>
        Trim…
      </button>
      <button type="button" data-behind>
        Behind
      </button>
      {open && (
        <TrimDialog
          busy={false}
          onTrim={() => {}}
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function openPanel() {
  const onCancel = mock(() => {});
  const view = render(<Panel onCancel={onCancel} />);
  const opener = view.container.querySelector("[data-open]") as HTMLElement;
  opener.focus();
  fireEvent.click(opener);
  const dialog = view.container.querySelector(
    "[data-image-trim-dialog]",
  ) as HTMLElement;
  return { view, opener, dialog, onCancel };
}

const controls = (dialog: HTMLElement) =>
  Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]),input:not([disabled]),select:not([disabled])",
    ),
  );

describe("[image.shell.canvas-size-rotate] the image dialogs' frame", () => {
  it("is a modal dialog with the dialog's name, and takes focus on open", () => {
    const { dialog } = openPanel();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Trim");
    expect(document.activeElement).toBe(controls(dialog)[0]);
  });

  it("keeps Tab inside: it wraps from the last control to the first and back", () => {
    const { dialog } = openPanel();
    const items = controls(dialog);
    const first = items[0];
    const last = items[items.length - 1];
    last.focus();
    const forward = fireEvent.keyDown(last, { key: "Tab" });
    // The frame took the key (default prevented) and moved focus itself.
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(first);
    const back = fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(back).toBe(false);
    expect(document.activeElement).toBe(last);
    // Between two controls of the dialog Tab is the browser's.
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
  });

  it("Escape cancels, and focus returns to the control that opened it", () => {
    const { view, opener, dialog, onCancel } = openPanel();
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("[data-image-trim-dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("the Cancel button also returns focus to the opener", () => {
    const { view, opener, dialog } = openPanel();
    fireEvent.click(dialog.querySelector("[data-dialog-cancel]")!);
    expect(view.container.querySelector("[data-image-trim-dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("an inner dialog's Escape does not also cancel the one around it", () => {
    const outer = mock(() => {});
    const inner = mock(() => {});
    const view = render(
      <DialogFrame label="Outer" onCancel={outer}>
        <DialogFrame label="Inner" onCancel={inner} data-inner>
          <button type="button">One</button>
        </DialogFrame>
      </DialogFrame>,
    );
    fireEvent.keyDown(view.container.querySelector("[data-inner] button")!, {
      key: "Escape",
    });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("other dialogs of the panel sit on the same frame", () => {
    const onCancel = mock(() => {});
    const view = render(
      <>
        <RotateDialog
          gpu
          busy={false}
          onRotate={() => {}}
          onCancel={onCancel}
        />
        <NewGuideDialog
          unit="px"
          pxPerUnit={1}
          onAdd={() => {}}
          onCancel={onCancel}
        />
      </>,
    );
    for (const sel of [
      "[data-image-rotate-dialog]",
      "[data-image-new-guide-dialog]",
    ]) {
      const el = view.container.querySelector(sel) as HTMLElement;
      expect(el.getAttribute("aria-modal")).toBe("true");
      fireEvent.keyDown(el, { key: "Escape" });
    }
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe("[image.layers.layer-management] renaming a layer in place", () => {
  function row(onRename = mock((_name: string) => {})) {
    const prompt = mock(() => "from a prompt");
    window.prompt = prompt as unknown as typeof window.prompt;
    const view = render(
      <LayerName name="Sky" label="Layer name" onRename={onRename} />,
    );
    const name = () =>
      view.container.querySelector("[data-image-layer-name]") as HTMLElement;
    const field = () =>
      view.container.querySelector(
        "[data-image-layer-rename]",
      ) as HTMLInputElement | null;
    return { view, name, field, onRename, prompt };
  }

  it("double-click opens a focused field, Enter commits, never a prompt", () => {
    const h = row();
    fireEvent.doubleClick(h.name());
    expect(h.prompt).not.toHaveBeenCalled();
    const field = h.field()!;
    expect(field.value).toBe("Sky");
    expect(field.getAttribute("aria-label")).toBe("Layer name");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "Clouds" } });
    fireEvent.keyDown(h.field()!, { key: "Enter" });
    expect(h.onRename.mock.calls).toEqual([["Clouds"]]);
    expect(h.field()).toBeNull();
    expect(document.activeElement).toBe(h.name());
  });

  it("Escape keeps the old name, and so do an empty and an unchanged one", () => {
    const h = row();
    fireEvent.doubleClick(h.name());
    fireEvent.change(h.field()!, { target: { value: "Clouds" } });
    fireEvent.keyDown(h.field()!, { key: "Escape" });
    expect(h.field()).toBeNull();
    fireEvent.keyDown(h.name(), { key: "F2" });
    fireEvent.change(h.field()!, { target: { value: "   " } });
    fireEvent.keyDown(h.field()!, { key: "Enter" });
    fireEvent.keyDown(h.name(), { key: "Enter" });
    fireEvent.keyDown(h.field()!, { key: "Enter" });
    expect(h.onRename).not.toHaveBeenCalled();
  });

  it("leaving the field commits once", () => {
    const h = row();
    fireEvent.doubleClick(h.name());
    fireEvent.change(h.field()!, { target: { value: "Clouds" } });
    fireEvent.blur(h.field()!);
    expect(h.onRename.mock.calls).toEqual([["Clouds"]]);
  });
});
