/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Editor ADR 291 — the data field markers: nothing drawn or read while
// View ▸ Show data markers is off; on, a bracket on every frame the data is

// Engine ADR 1055 — a pin on the canvas for every comment thread that is not
// on text: at the thread's place on its page, faint when resolved, none for an
// orphan; a click focuses the thread and opens the Comments panel.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type { CanvasClient, CommentSummary, PageId } from "@paged-media/client";

import { cockpitActionsOf } from "../../src/cockpit/cockpit-state-context";
import {
  COMMENTS_PANEL,
  commentPinsContribution,
  pinsOf,
} from "../../src/overlays/comment-pins";
import { getFocusedThread } from "../../src/state/comment-focus";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  createEditorScope,
  EditorScopeProvider,
} from "../../src/state/editor-scope";

afterEach(cleanup);

const PAGE = "p1" as PageId;
const pageRects = new Map([[PAGE, { x: 100, y: 1000, w: 612, h: 792 }]]);

const row = (over: Partial<CommentSummary>): CommentSummary =>
  ({
    id: "t1",
    storyId: "",
    anchorText: "",
    text: "Check this",
    resolved: false,
    author: "Ann Author",
    ...over,
  }) as CommentSummary;

const ROWS: CommentSummary[] = [
  row({ id: "t1", threadId: "t1", page: "p1", at: [40, 50] } as never),
  row({ id: "t1.1", parentId: "t1", threadId: "t1", author: "Bob" } as never),
  row({
    id: "t2",
    threadId: "t2",
    page: "p1",
    at: [10, 20],
    resolved: true,
    initials: "ZZ",
  } as never),
  // Text comment: the margin band's, not a pin.
  row({ id: "9", storyId: "u1" }),
  // Orphaned: no place.
  row({ id: "t3", threadId: "t3", orphaned: true } as never),
  // Standing nowhere (no page resolved).
  row({ id: "t4", threadId: "t4" } as never),
];

function mount(rows: CommentSummary[], scale = 2) {
  const client = {
    subscribe: () => () => undefined,
    collection: async () => rows,
  } as unknown as CanvasClient;
  const scope = createEditorScope();
  const opened: string[] = [];
  cockpitActionsOf(scope).openPanel = (id: string) => {
    opened.push(id);
  };
  const Render = commentPinsContribution.render;
  const view = render(
    <EditorScopeProvider scope={scope}>
      <CanvasClientProvider client={client}>
        <svg>
          <Render
            paged={null as never}
            camera={{ scale, tx: 0, ty: 0 }}
            pageRects={pageRects}
          />
        </svg>
      </CanvasClientProvider>
    </EditorScopeProvider>,
  );
  return { view, scope, opened };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("comment pins [editor-shell.comments]", () => {
  test("a pin per document thread that stands on a page, with its reply count", () => {
    expect(pinsOf(ROWS)).toEqual([
      {
        id: "t1",
        page: "p1",
        at: [40, 50],
        initials: "AA",
        resolved: false,
        replies: 1,
      },
      {
        id: "t2",
        page: "p1",
        at: [10, 20],
        initials: "ZZ",
        resolved: true,
        replies: 0,
      },
    ]);
  });

  test("pins are drawn on their page at the thread's point, a constant size on screen", async () => {
    const { view } = mount(ROWS, 2);
    await settle();
    const pin = (id: string) =>
      view.container.querySelector(`[data-comment-pin="${id}"]`);
    // pageRect (100, 1000) + point (40, 50); scaled by the camera's inverse.
    expect(pin("t1")?.getAttribute("transform")).toBe(
      "translate(140, 1050) scale(0.5)",
    );
    expect(pin("t2")?.getAttribute("data-resolved")).toBe("true");
    expect(pin("t2")?.getAttribute("opacity")).toBe("0.45");
    expect(pin("t1")?.textContent).toBe("AA");
    // No pin for a text comment, an orphan, or a thread with no place.
    for (const id of ["9", "t3", "t4"]) expect(pin(id)).toBeNull();
  });

  test("a click focuses the thread and opens the Comments panel", async () => {
    const { view, scope, opened } = mount(ROWS);
    await settle();
    expect(getFocusedThread(scope)).toBeNull();
    fireEvent.pointerDown(
      view.container.querySelector('[data-comment-pin="t2"]')!,
    );
    expect(getFocusedThread(scope)).toBe("t2");
    expect(opened).toEqual([COMMENTS_PANEL]);
    await settle();
    expect(
      view.container
        .querySelector('[data-comment-pin="t2"]')
        ?.getAttribute("data-focused"),
    ).toBe("true");
  });

  test("a document with no document threads draws nothing", async () => {
    const { view } = mount([row({ id: "9", storyId: "u1" })]);
    await settle();
    expect(
      view.container
        .querySelector("[data-comment-pins]")
        ?.getAttribute("data-comment-pins"),
    ).toBe("empty");
  });
});
