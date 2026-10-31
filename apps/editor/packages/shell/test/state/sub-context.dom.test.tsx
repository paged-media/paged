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

// Editor ADR 301 — a header, footer or note edited in place (extensions
// ADR 349, C6): the providers answer a page double-click, the controller
// puts the caret at the story's end and pins its geometry to the page the
// header was entered on, the overlay veils the rest and shows the bar
// with the bundle's commands, and the sub-context ends when the caret
// leaves its story, on Close, or when a document loads.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CanvasClient,
  ContentSelection,
  PageId,
  WorkerToMain,
} from "@paged-media/client";

import { subContextContribution } from "../../src/overlays/sub-context";
import { createSubContextRegistry } from "../../src/registries/sub-context";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  ContentSelectionProvider,
  pinToPage,
  useContentSelection,
} from "../../src/state/content-selection-context";
import {
  RegistriesProvider,
  useRegistries,
  type ShellRegistries,
} from "../../src/state/registries-context";
import {
  SubContextController,
  useSubContextEntry,
} from "../../src/state/sub-context-controller";

afterEach(cleanup);

const P1 = "p1" as PageId;
const P3 = "p3" as PageId;
const pageRects = new Map([
  [P1, { x: 0, y: 0, w: 612, h: 792 }],
  [P3, { x: 0, y: 1600, w: 612, h: 792 }],
]);

const HEADER = {
  kind: "header" as const,
  pageId: P3,
  storyId: "docx_h0d",
  bounds: [36, 72, 72, 540] as [number, number, number, number],
  commands: ["media.paged.test.linkToPrevious"],
};

function fakeClient() {
  const listeners = new Set<(m: WorkerToMain) => void>();
  const selections: Array<ContentSelection | null> = [];
  const client = {
    subscribe(fn: (m: WorkerToMain) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async setSelection(sel: ContentSelection | null) {
      selections.push(sel);
    },
    // The engine answers a master story's caret on the FIRST page that
    // shows the master.
    async caretGeometry(sel: ContentSelection) {
      return {
        pageId: P1,
        frameId: "hf",
        xPt: 80 + sel.start,
        topPt: 40,
        heightPt: 12,
      };
    },
    async selectionGeometry() {
      return [];
    },
    async send(msg: { kind: string; payload: { storyId: string } }) {
      if (msg.kind === "requestStoryContent") {
        return {
          kind: "storyContentResult",
          payload: {
            content: {
              selfId: msg.payload.storyId,
              paragraphs: [
                { runs: [{ text: "Größe" }] },
                { runs: [{ text: "Page " }, { text: "3" }] },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected ${msg.kind}`);
    },
  };
  return {
    client: client as unknown as CanvasClient,
    selections,
    emit: (m: WorkerToMain) => listeners.forEach((l) => l(m)),
  };
}

function mount() {
  const fake = fakeClient();
  let registries: ShellRegistries | null = null;
  let content: ReturnType<typeof useContentSelection> | null = null;
  let entry: ReturnType<typeof useSubContextEntry> | null = null;
  const invoked: string[] = [];
  const Render = subContextContribution.render;
  function Probe() {
    registries = useRegistries();
    content = useContentSelection();
    entry = useSubContextEntry();
    return null;
  }
  const view = render(
    <RegistriesProvider getEditor={() => null}>
      <CanvasClientProvider client={fake.client}>
        <ContentSelectionProvider>
          <Probe />
          <SubContextController />
          <svg>
            <Render
              paged={null as never}
              camera={{ scale: 2, tx: 0, ty: 0 }}
              pageRects={pageRects}
            />
          </svg>
        </ContentSelectionProvider>
      </CanvasClientProvider>
    </RegistriesProvider>,
  );
  const regs = () => registries!;
  act(() => {
    regs().commands.register({
      id: "media.paged.test.linkToPrevious",
      title: "Link to Previous",
      handler: () => {
        invoked.push("link");
      },
    });
  });
  const q = (sel: string) => view.container.querySelector(sel);
  return {
    ...fake,
    regs,
    content: () => content!,
    entry: () => entry!,
    invoked,
    q,
  };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("sub-context registry", () => {
  test("providers answer in order for their context; exit is per bundle", async () => {
    const reg = createSubContextRegistry();
    const asked: string[] = [];
    reg.register("a", {
      editContext: "sheet",
      resolve: () => {
        asked.push("sheet");
        return HEADER;
      },
    });
    reg.register("b", {
      editContext: "wordDocument",
      resolve: () => {
        asked.push("b");
        return null;
      },
    });
    reg.register("c", {
      editContext: "wordDocument",
      resolve: async (hit) => ({ ...HEADER, pageId: hit.pageId }),
    });
    const got = await reg.resolve({
      editContext: "wordDocument",
      pageId: P1,
      pagePoint: [100, 50],
    });
    expect(asked).toEqual(["b"]);
    expect(got).toMatchObject({ pluginId: "c", pageId: P1 });
    expect(reg.exit("a")).toBe(false);
    expect(reg.exit("c")).toBe(true);
    expect(reg.current()).toBeNull();
  });

  test("a provider that throws answers nothing", async () => {
    const reg = createSubContextRegistry();
    reg.register("a", {
      editContext: "wordDocument",
      resolve: () => {
        throw new Error("boom");
      },
    });
    expect(
      await reg.resolve({
        editContext: "wordDocument",
        pageId: P1,
        pagePoint: [0, 0],
      }),
    ).toBeNull();
  });

  test("pinToPage moves only the pinned story's geometry", () => {
    const caret = { pageId: P1, xPt: 1, topPt: 2, heightPt: 3, frameId: null };
    const sel = { storyId: "s", start: 0, end: 0 };
    expect(pinToPage(caret, sel, { storyId: "s", pageId: "p3" }).pageId).toBe(
      P3,
    );
    expect(pinToPage(caret, sel, { storyId: "t", pageId: "p3" })).toBe(caret);
    expect(pinToPage(caret, sel, null)).toBe(caret);
  });
});

describe("a header edited in place (editor ADR 301)", () => {
  test("a double-click in the document context enters, puts the caret at the story's end on that page, and veils the rest", async () => {
    const h = mount();
    // No document context: the double-click is not offered.
    expect(
      await h.entry().trySubContext({ pageId: P3, pagePoint: [100, 50] }),
    ).toBe(false);
    act(() => {
      h.regs().documentContext.set("media.paged.test", "wordDocument");
      h.regs().subContexts.register("media.paged.test", {
        editContext: "wordDocument",
        resolve: (hit) =>
          hit.pagePoint[1] < 72 ? { ...HEADER, pageId: hit.pageId } : null,
      });
    });
    // The body: nobody answers.
    expect(
      await h.entry().trySubContext({ pageId: P3, pagePoint: [100, 300] }),
    ).toBe(false);
    let entered = false;
    await act(async () => {
      entered = await h
        .entry()
        .trySubContext({ pageId: P3, pagePoint: [100, 50] });
    });
    expect(entered).toBe(true);
    await settle();
    // "Größe" is 7 bytes, the break 1, "Page 3" 6: the end is 14.
    expect(h.content().contentSelection).toMatchObject({
      storyId: "docx_h0d",
      start: 14,
      end: 14,
    });
    await settle();
    // The engine answered page 1; the caret shows on page 3.
    expect(h.content().caret?.pageId).toBe(P3);
    const veil = h.q("[data-sub-context-veil]")!;
    expect(veil.getAttribute("pointer-events")).toBe("none");
    expect(veil.getAttribute("d")).toContain(
      "M72,1636L540,1636L540,1672L72,1672Z",
    );
    expect(h.q("[data-sub-context]")?.getAttribute("data-sub-context")).toBe(
      "header",
    );
    const bar = h.q("[data-sub-context-bar]")!;
    expect(bar.textContent).toContain("Header");
    // The header's bar hangs under the header band, at its width.
    const fo = bar.parentElement!;
    expect(fo.getAttribute("y")).toBe("1672");
    expect(fo.getAttribute("width")).toBe("468");
    const link = h.q('[data-command="media.paged.test.linkToPrevious"]')!;
    expect(link.textContent).toBe("Link to Previous");
    await act(async () => {
      fireEvent.click(link);
    });
    expect(h.invoked).toEqual(["link"]);
  });

  test("the caret leaving the story ends it (Escape, a click in the body)", async () => {
    const h = mount();
    act(() => {
      h.regs().subContexts.enter("media.paged.test", { ...HEADER, offset: 3 });
    });
    await settle();
    expect(h.content().contentSelection?.start).toBe(3);
    act(() =>
      h.content().setContentSelection({ storyId: "body", start: 0, end: 0 }),
    );
    expect(h.regs().subContexts.current()).toBeNull();
    await settle();
    expect(h.q("[data-sub-context]")).toBeNull();
    expect(h.content().pagePin).toBeNull();
    // Escape clears the caret: that too.
    act(() => {
      h.regs().subContexts.enter("media.paged.test", { ...HEADER, offset: 0 });
    });
    await settle();
    act(() => h.content().setContentSelection(null));
    expect(h.regs().subContexts.current()).toBeNull();
  });

  test("Close and a new document end it and take the caret", async () => {
    const h = mount();
    act(() => {
      h.regs().subContexts.enter("media.paged.test", { ...HEADER, offset: 1 });
    });
    await settle();
    await act(async () => {
      fireEvent.click(h.q("[data-sub-context-close]")!);
    });
    expect(h.regs().subContexts.current()).toBeNull();
    expect(h.content().contentSelection).toBeNull();
    act(() => {
      h.regs().subContexts.enter("media.paged.test", {
        ...HEADER,
        kind: "footer",
        label: "Footer -Section 2-",
        offset: 0,
      });
    });
    await settle();
    expect(h.q("[data-sub-context-bar]")?.textContent).toContain(
      "Footer -Section 2-",
    );
    // A footer's bar sits on top of the footer band.
    expect(
      h.q("[data-sub-context-bar]")!.parentElement!.getAttribute("y"),
    ).toBe(String(1636 - 13));
    act(() => h.emit({ kind: "documentLoaded", payload: {} } as never));
    expect(h.regs().subContexts.current()).toBeNull();
    expect(h.content().contentSelection).toBeNull();
  });
});
