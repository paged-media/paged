// The ML section as a component (the DOM lane): what the fields say is what
// reaches the session's ML controller, the strip places a candidate, and the
// buttons go inert while a model works or no selection exists.

import { describe, expect, it, mock } from "bun:test";
import { act, render, fireEvent, waitFor } from "@testing-library/react";

import type { BundleHost, OverlayProps } from "@paged-media/plugin-api";

import { makeTaskBarOverlay } from "../src/ml-taskbar";
import type { ImageSession } from "../src/session";

// The contextual task bar (WP8.2, image ADR 486): it shows under a selection
// while the image's context is open on its frame, and hides without one or
// once the context closes; its buttons call the ML controller the commands
// call.

function harness(
  selection: { x: number; y: number; w: number; h: number } | null,
  entered: string | null = "u1",
) {
  const calls: string[] = [];
  const rec = (name: string) =>
    mock(async (...a: unknown[]) => {
      calls.push([name, ...a].join(":"));
      return true;
    });
  const features = {
    generativeFill: rec("generativeFill"),
    removeSelection: rec("removeSelection"),
    selectSubject: rec("selectSubject"),
  };
  const state = {
    source: { elementId: "u1", width: 400, height: 200 },
    selection: selection && { ...selection, coverage: 1, revision: 1 },
    ml: { busy: false },
  };
  const session = {
    state: () => state,
    ml: () => features,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as ImageSession;
  const opened: string[] = [];
  const host = {
    document: {
      elementGeometry: async () => [
        { pageId: "pg1", bounds: [0, 0, 100, 200] },
      ],
    },
    shell: { openPanel: (id: string) => void opened.push(id) },
    log: { debug() {} },
  } as unknown as BundleHost;
  const overlay = makeTaskBarOverlay(host, session, "panel.image");
  overlay.setEnteredFrame(entered);
  const Bar = overlay.render;
  const props = {
    paged: {},
    camera: { scale: 2, tx: 0, ty: 0 },
    pageRects: new Map([["pg1", { x: 10, y: 20, width: 200, height: 100 }]]),
  } as unknown as OverlayProps;
  // The overlay layer sits inside the canvas, a focusable surface (the
  // viewport, editor ADR 234). What the canvas hears of a key the bar let
  // through is recorded: the editor's own key listeners come after it.
  const heard: string[] = [];
  const view = render(
    <div
      tabIndex={0}
      data-testid="canvas"
      onKeyDown={(e) => void heard.push(e.key)}
    >
      <svg>
        <Bar {...props} />
      </svg>
    </div>,
  );
  const q = (a: string) =>
    view.container.querySelector(
      `[data-image-task-bar="${a}"]`,
    ) as HTMLElement | null;
  const bar = () => view.container.querySelector("[data-image-task-bar]");
  const prompt = () =>
    view.container.querySelector(
      "[data-image-task-bar-prompt]",
    ) as HTMLInputElement | null;
  const canvas = view.getByTestId("canvas");
  return { view, q, bar, prompt, canvas, heard, calls, opened, overlay };
}

describe("the contextual task bar", () => {
  it("shows under a selection and its buttons run the ML features", async () => {
    const { q, prompt, calls, opened } = harness({
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    });
    await waitFor(() => expect(q("fill")).not.toBeNull());
    // Without a prompt the fill raises the Image panel, as the command does.
    fireEvent.click(q("fill")!);
    expect(opened).toEqual(["panel.image"]);
    fireEvent.change(prompt()!, { target: { value: "a lake" } });
    fireEvent.click(q("fill")!);
    fireEvent.click(q("remove")!);
    fireEvent.click(q("subject")!);
    expect(calls).toEqual([
      "generativeFill:a lake",
      "removeSelection",
      "selectSubject",
    ]);
  });

  it("hides when there is no selection", async () => {
    const { bar } = harness(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(bar()).toBeNull();
  });

  // The bar is the context's. The session keeps the image and its selection
  // after the context closes; a bar that stayed on the page sat where the
  // next frame was drawn, took the drag into its prompt and every key after.
  it("draws only while the image's context is open on its frame, and goes when it closes", async () => {
    const { bar, q, overlay } = harness({ x: 0, y: 0, w: 200, h: 100 }, null);
    await new Promise((r) => setTimeout(r, 20));
    expect(bar(), "no context: no bar").toBeNull();
    act(() => overlay.setEnteredFrame("u1"));
    await waitFor(() => expect(q("fill")).not.toBeNull());
    act(() => overlay.setEnteredFrame(null));
    expect(bar(), "the context closed: the bar went with it").toBeNull();
    act(() => overlay.setEnteredFrame("u2"));
    expect(bar(), "a context on another frame: not this image's").toBeNull();
  });

  it("hands focus in its prompt back to the canvas when the context closes", async () => {
    const { bar, prompt, canvas, overlay } = harness({
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    });
    await waitFor(() => expect(prompt()).not.toBeNull());
    prompt()!.focus();
    expect(document.activeElement).toBe(prompt());
    act(() => overlay.setEnteredFrame(null));
    expect(bar()).toBeNull();
    expect(document.activeElement, "the canvas, not the page").toBe(canvas);
  });

  // One Escape (editor ADR 1207): the arbiter defers a focused field's
  // keys, so the prompt's Escape is the field's. It leaves the bar for the
  // canvas; the next Escape is the canvas's (the context, which takes the
  // bar with it). Other keys stay the field's.
  it("Escape in the prompt gives focus back to the canvas; other keys stay the bar's", async () => {
    const { prompt, canvas, bar, heard } = harness({
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    });
    await waitFor(() => expect(prompt()).not.toBeNull());
    prompt()!.focus();
    fireEvent.keyDown(prompt()!, { key: "f" });
    expect(document.activeElement).toBe(prompt());
    expect(heard, "a letter typed in the prompt is no tool key").toEqual([]);
    const escape = fireEvent.keyDown(prompt()!, { key: "Escape" });
    expect(escape, "the field took the press").toBe(false);
    expect(document.activeElement).toBe(canvas);
    expect(bar(), "the context is still open: the bar stays").not.toBeNull();
    expect(heard).toEqual([]);
  });
});
