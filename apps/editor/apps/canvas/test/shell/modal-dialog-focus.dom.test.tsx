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
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The focus contract of the application's modal dialogs (ADR 234, ADR 1206)
// on one of them, the Star dialog, over a mounted PagedShell and the real
// engine. Every dialog built on the shell's `ModalDialog` gets the same
// handling from the shell's dialog, so one of them stands for all:
//
//   · focus moves in as it opens, to the first field;
//   · Tab from the last control wraps to the first, Shift+Tab from the
//     first to the last: focus never leaves by keyboard;
//   · it is a named modal (`role="dialog"`, `aria-modal`, labelled by its
//     heading) and the rest of the editor is hidden from assistive
//     technology while it is open;
//   · Escape closes it, and focus returns to what opened it, or to the
//     canvas when the opener is gone (a menu item).

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { CanvasClient } from "@paged-media/client";
import {
  PagedShell,
  tabbableElements,
  useEditorScope,
  type EditorScope,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";

import { openStarDialog, StarDialog } from "../../src/panels/star-dialog";
import { EngineWorker, headlessEngine } from "../panels/engine-worker";

function Capture({ onScope }: { onScope(scope: EditorScope): void }) {
  const scope = useEditorScope();
  useEffect(() => {
    onScope(scope);
  }, [scope, onScope]);
  return null;
}

afterEach(() => cleanup());

async function mountShell() {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  await client.newBlankDocument(612, 792);
  let scope: EditorScope | null = null;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        panels={[]}
        tools={BUILT_IN_TOOLS}
        canvasComponent={() => <div data-test-canvas />}
      >
        <Capture onScope={(s) => (scope = s)} />
        <StarDialog />
      </PagedShell>,
    );
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  await settle();
  if (!scope) throw new Error("PagedShell did not publish its scope");
  const editor: EditorScope = scope;
  const root = view.container;
  const dialog = () =>
    document.querySelector<HTMLElement>("[data-star-dialog]");
  return {
    root,
    settle,
    dialog,
    viewport: () =>
      root.querySelector<HTMLElement>('[data-canvas-surface="viewport"]')!,
    async open() {
      await act(async () => openStarDialog(editor));
      await settle();
      return dialog()!;
    },
    /** A keydown as the browser delivers it: on the focused element,
     *  bubbling to the dialog's and the window's listeners. */
    async key(init: KeyboardEventInit) {
      const on = document.activeElement ?? document.body;
      await act(async () => {
        on.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
      await settle();
    },
  };
}

describe("a modal dialog of the application (the Star dialog)", () => {
  test("focus moves in on open, Tab stays inside, Escape closes, and focus returns to the opener", async () => {
    const s = await mountShell();
    const opener = s.root.querySelector<HTMLElement>(
      '[data-menu-trigger="File"]',
    )!;
    await act(async () => opener.focus());
    expect(document.activeElement).toBe(opener);

    const dialog = await s.open();
    expect(dialog).not.toBeNull();
    // The editor's own: inside its root, not the page's body.
    expect(s.root.contains(dialog)).toBe(true);

    // A named modal, and the editor behind it is hidden while it is open.
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById(
      dialog.getAttribute("aria-labelledby") ?? "",
    );
    expect(heading?.tagName).toBe("H2");
    expect(heading?.textContent).toBe("Star");
    // The id the heading's text was always found by is still there.
    expect(heading?.querySelector("#star-title")?.textContent).toBe("Star");
    expect(s.viewport().closest('[aria-hidden="true"]')).not.toBeNull();
    expect(opener.closest('[aria-hidden="true"]')).not.toBeNull();

    // In: the first control of the dialog.
    const stops = tabbableElements(dialog);
    expect(stops.length).toBeGreaterThan(2);
    const first = stops[0];
    const last = stops[stops.length - 1];
    expect(document.activeElement).toBe(first);

    // Tab from the last control wraps to the first; Shift+Tab from the
    // first to the last. Focus never leaves the dialog.
    await act(async () => last.focus());
    await s.key({ key: "Tab" });
    expect(document.activeElement).toBe(first);
    await s.key({ key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape closes it, and focus is the opener's again.
    await s.key({ key: "Escape" });
    expect(s.dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(opener.closest('[aria-hidden="true"]')).toBeNull();
  });

  test("Cancel closes it too, and an opener that is gone hands focus to the canvas", async () => {
    const s = await mountShell();
    // A menu item: it leaves the document as its menu closes.
    const item = document.createElement("button");
    s.root.querySelector("[data-paged-editor]")?.append(item) ??
      s.root.append(item);
    await act(async () => item.focus());
    expect(document.activeElement).toBe(item);
    const dialog = await s.open();
    expect(dialog.contains(document.activeElement)).toBe(true);
    item.remove();
    await act(async () =>
      dialog.querySelector<HTMLElement>("[data-star-cancel]")!.click(),
    );
    await s.settle();
    expect(s.dialog()).toBeNull();
    expect(document.activeElement).toBe(s.viewport());
  });
});
