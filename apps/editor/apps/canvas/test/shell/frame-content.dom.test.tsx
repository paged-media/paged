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

// Frame, content, edit (editor ADR 1215, D-05) on a mounted PagedShell over
// the real engine: a picture frame's double-click enters its content level,
// a second one (or Enter's keyboard entry) enters the context that declares
// `editsPlacedImages`; the level control shows the levels and changes
// them; nothing moves the frame or adds a document step.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { PNG } from "pngjs";

import { CanvasClient, type ElementId } from "@paged-media/client";
import {
  IMAGE_CONTENT_CONTEXT,
  PagedShell,
  createEditorScope,
  useEditContextEntry,
  useEditContextStack,
  useRegistries,
  useSelection,
  type EditContextStackValue,
  type ModeContribution,
  type ShellRegistries,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";

import { EngineWorker, headlessEngine } from "../panels/engine-worker";

const MODES: ModeContribution[] = [
  {
    id: "design",
    title: "Design",
    icon: "mode-design",
    order: 0,
    slots: { left: "test.left" },
  },
];

afterEach(() => cleanup());

interface Probe {
  registries: ShellRegistries;
  stack: EditContextStackValue;
  entry: ReturnType<typeof useEditContextEntry>;
  selection: ReturnType<typeof useSelection>;
}
let probe: Probe | null = null;
function Capture() {
  const registries = useRegistries();
  const stack = useEditContextStack();
  const entry = useEditContextEntry();
  const selection = useSelection();
  useEffect(() => {
    probe = { registries, stack, entry, selection };
  });
  return null;
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function png(): number[] {
  const img = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = 200;
    img.data[i + 3] = 255;
  }
  return Array.from(PNG.sync.write(img));
}

async function mount() {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  const blank = await client.newBlankDocument(612, 792);
  const pageId = blank.pageIds[0]!;
  const made = (await client.mutate({
    op: "insertFrame",
    args: { pageId, bounds: [100, 100, 200, 260] },
  })) as { kind: string; payload?: { createdId?: ElementId } };
  const frame = made.payload!.createdId!;
  const placed = await client.mutate({
    op: "replaceImageBytes",
    args: { elementId: (frame as { id: string }).id, bytes: png() },
  });
  expect(placed.kind).toBe("mutationApplied");
  const plain = (
    (await client.mutate({
      op: "insertFrame",
      args: { pageId, bounds: [300, 100, 400, 260] },
    })) as { payload?: { createdId?: ElementId } }
  ).payload!.createdId!;
  const scope = createEditorScope();
  probe = null;
  await act(async () => {
    render(
      <PagedShell
        client={client}
        scope={scope}
        panels={[{ id: "test.left", title: "Left", component: () => null }]}
        tools={BUILT_IN_TOOLS}
        modes={MODES}
        initialMode="design"
        canvasComponent={() => <div data-test-canvas />}
      >
        <Capture />
      </PagedShell>,
    );
  });
  await settle();
  if (!probe) throw new Error("PagedShell did not mount");
  const p = () => probe!;
  const calls: string[] = [];
  // A stand-in for paged.image: the context that edits placed pictures.
  await act(async () => {
    p().registries.editContexts.register({
      type: "test.pixels",
      entry: "doubleClick",
      label: "Pixels",
      editsPlacedImages: true,
      matches: () => false,
      onEnter: () => void calls.push("enter pixels"),
      onExit: () => void calls.push("exit pixels"),
    });
  });
  await settle();
  return { client, pageId, frame, plain, p, calls };
}

const top = (s: EditContextStackValue) => s.active?.type ?? null;

describe("frame, content, edit (ADR 1215)", () => {
  test("a double-click on a picture frame enters its content; a second enters Edit image; Escape-like leaving climbs back", async () => {
    const m = await mount();
    const undo = (await m.client.undoLog(0)).undoLen;
    const before = await m.client.elementGeometry([m.frame]);
    const hit = {
      element: m.frame,
      groupChain: [],
      pageId: m.pageId,
      pagePoint: [180, 150] as [number, number],
    };
    let claimed = false;
    await act(async () => {
      claimed = await m.p().entry.tryEnterEditContext(hit);
    });
    await settle();
    expect(claimed).toBe(true);
    expect(top(m.p().stack)).toBe(IMAGE_CONTENT_CONTEXT);
    // The level control shows the frame's levels, Content current.
    const levels = document.querySelector("[data-frame-levels]");
    expect(levels?.getAttribute("data-frame-level-current")).toBe("content");
    expect(
      [...document.querySelectorAll("[data-frame-level]")].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Frame", "Content", "Edit image"]);
    // The trail names the level.
    expect(
      document.querySelector(
        `[data-edit-context-crumb="${IMAGE_CONTENT_CONTEXT}"]`,
      )?.textContent,
    ).toBe("Image content");

    await act(async () => {
      await m.p().entry.tryEnterEditContext(hit);
    });
    await settle();
    expect(m.p().stack.stack.map((f) => f.type)).toEqual([
      IMAGE_CONTENT_CONTEXT,
      "test.pixels",
    ]);
    expect(m.calls).toEqual(["enter pixels"]);
    expect(levels?.getAttribute("data-frame-level-current")).toBe("edit");

    // The Frame level leaves both.
    const frameLevel = document.querySelector<HTMLButtonElement>(
      '[data-frame-level="frame"]',
    )!;
    await act(async () => {
      fireEvent.click(frameLevel);
    });
    await settle();
    expect(m.p().stack.active).toBeNull();
    expect(m.calls).toEqual(["enter pixels", "exit pixels"]);
    expect(await m.client.elementGeometry([m.frame])).toEqual(before);
    expect((await m.client.undoLog(0)).undoLen).toBe(undo);
  });

  test("a keyboard entry (Enter on the selected picture frame) is the explicit Edit image", async () => {
    const m = await mount();
    let owned = false;
    await act(async () => {
      owned = await m.p().entry.isOwnedContent(m.frame);
    });
    expect(owned, "Enter on a picture frame enters Edit image").toBe(true);
    await act(async () => {
      await m.p().entry.tryEnterOwnedContent({
        element: m.frame,
        groupChain: [],
      });
    });
    await settle();
    expect(m.p().stack.stack.map((f) => f.type)).toEqual(["test.pixels"]);
    // Up to Content through the control: Edit leaves, Content enters.
    const content = document.querySelector<HTMLButtonElement>(
      '[data-frame-level="content"]',
    )!;
    await act(async () => {
      fireEvent.click(content);
    });
    await settle();
    expect(m.p().stack.stack.map((f) => f.type)).toEqual([
      IMAGE_CONTENT_CONTEXT,
    ]);
  });

  test("a frame with no picture offers no levels and enters nothing of the picture's", async () => {
    const m = await mount();
    let owned = true;
    await act(async () => {
      owned = await m.p().entry.isOwnedContent(m.plain);
    });
    expect(owned).toBe(false);
    await act(async () => {
      const ids = await m.client.setElementSelection([m.plain], "replace");
      m.p().selection.setElementSelection(ids);
      m.p().selection.setElementGeometry(await m.client.elementGeometry(ids));
    });
    await settle();
    expect(document.querySelector("[data-frame-levels]")).toBeNull();
  });
});
