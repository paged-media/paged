// The ML section as a component (the DOM lane): what the fields say is what
// reaches the session's ML controller, the strip places a candidate, and the
// buttons go inert while a model works or no selection exists.

import { describe, expect, it, mock } from "bun:test";
import { render, fireEvent, waitFor } from "@testing-library/react";

import type { BundleHost, OverlayProps } from "@paged-media/plugin-api";

import { makeTaskBarOverlay } from "../src/ml-taskbar";
import type { ImageSession } from "../src/session";

// The contextual task bar (WP8.2, image ADR 486): it shows under a selection
// and hides without one; its buttons call the ML controller the commands call.

function harness(
  selection: { x: number; y: number; w: number; h: number } | null,
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
  const Bar = makeTaskBarOverlay(host, session, "panel.image");
  const props = {
    paged: {},
    camera: { scale: 2, tx: 0, ty: 0 },
    pageRects: new Map([["pg1", { x: 10, y: 20, width: 200, height: 100 }]]),
  } as unknown as OverlayProps;
  const view = render(
    <svg>
      <Bar {...props} />
    </svg>,
  );
  const q = (a: string) =>
    view.container.querySelector(
      `[data-image-task-bar="${a}"]`,
    ) as HTMLElement | null;
  return { view, q, calls, opened };
}

describe("the contextual task bar", () => {
  it("shows under a selection and its buttons run the ML features", async () => {
    const { view, q, calls, opened } = harness({ x: 0, y: 0, w: 200, h: 100 });
    await waitFor(() => expect(q("fill")).not.toBeNull());
    // Without a prompt the fill raises the Image panel, as the command does.
    fireEvent.click(q("fill")!);
    expect(opened).toEqual(["panel.image"]);
    fireEvent.change(
      view.container.querySelector("[data-image-task-bar-prompt]")!,
      { target: { value: "a lake" } },
    );
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
    const { view } = harness(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(view.container.querySelector("[data-image-task-bar]")).toBeNull();
  });
});
