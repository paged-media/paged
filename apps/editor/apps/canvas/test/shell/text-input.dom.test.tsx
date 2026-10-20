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

// Text entry with a caret in a story (F-36, SH-3, ADR 234): PagedShell
// over the real engine, the canvas app's text editor (`useTextEditing`)
// and its input surface (`TextInputSurface`). The events an operating
// system's input method produces are synthesised here — `beforeinput`
// (an IME commit, the emoji picker, dictation), the composition events
// (CJK input, dead keys), keydowns carrying Option and AltGr characters,
// `paste`. A real IME cannot be driven by any test; these are the events
// it delivers, in the order a browser delivers them.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect, useRef } from "react";

import {
  CanvasClient,
  type ContentSelection,
  type DocumentHandle,
} from "@paged-media/client";
import {
  PagedShell,
  useContentSelection,
  useRegistries,
  useTool,
  type ShellRegistries,
  type ToolContextValue,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";
import { covers } from "@paged-media/test-kit";

import { TextInputSurface } from "../../src/ui/TextInputSurface";
import { useTextEditing } from "../../src/ui/useTextEditing";
import { EngineWorker, headlessEngine } from "../panels/engine-worker";
import { textScene } from "../panels/fixtures";

afterEach(() => cleanup());

interface Probe {
  registries: ShellRegistries;
  setSelection(sel: ContentSelection | null): void;
  selection(): ContentSelection | null;
  tool(): ToolContextValue;
}

function Integration({
  client,
  onProbe,
}: {
  client: CanvasClient;
  onProbe(p: Probe): void;
}) {
  const registries = useRegistries();
  const tool = useTool();
  const toolRef = useRef(tool);
  useEffect(() => {
    toolRef.current = tool;
  });
  const { contentSelection, setContentSelection, contentSelectionRef } =
    useContentSelection();
  useTextEditing({
    client,
    selection: contentSelection,
    setSelection: setContentSelection,
  });
  useEffect(() => {
    onProbe({
      registries,
      setSelection: setContentSelection,
      selection: () => contentSelectionRef.current,
      tool: () => toolRef.current,
    });
  }, [registries, setContentSelection, contentSelectionRef, onProbe]);
  return null;
}

async function mount() {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  const handle: DocumentHandle = await client.newBlankDocument(612, 792);
  const scene = await textScene({ client, handle });
  let probe: Probe | null = null;
  await act(async () => {
    render(
      <PagedShell
        client={client}
        panels={[{ id: "test.left", title: "Left", component: () => null }]}
        tools={BUILT_IN_TOOLS}
        modes={[
          {
            id: "design",
            title: "Design",
            icon: "mode-design",
            order: 0,
            slots: { left: "test.left" },
          },
        ]}
        initialMode="design"
        canvasComponent={() => (
          <TextInputSurface
            camera={{ scale: 1, tx: 0, ty: 0 }}
            pageIds={handle.pageIds}
            pageRects={[{ x: 0, y: 0, w: 612, h: 792 }]}
          />
        )}
      >
        <Integration client={client} onProbe={(p) => (probe = p)} />
      </PagedShell>,
    );
  });
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  await settle();
  if (!probe) throw new Error("the integration did not mount");
  const p: Probe = probe;
  const surface = () =>
    document.querySelector<HTMLTextAreaElement>(
      'textarea[data-canvas-surface="text"]',
    )!;
  const story = async (): Promise<string> => {
    const reply = await client.send({
      kind: "requestStoryContent",
      payload: { storyId: scene.storyId },
    });
    if (reply.kind !== "storyContentResult" || !reply.payload.content) {
      throw new Error("no story content");
    }
    return reply.payload.content.paragraphs
      .map((para) => para.runs.map((r) => r.text).join(""))
      .join("\n");
  };
  /** Wait until the story reads `want` (the edits go through the worker). */
  const storyIs = async (want: string) => {
    for (let i = 0; i < 40 && (await story()) !== want; i++) await settle();
    expect(await story()).toBe(want);
  };
  const caretAt = async (offset: number) => {
    await act(async () =>
      p.setSelection({
        storyId: scene.storyId,
        start: offset,
        end: offset,
        affinity: false,
      }),
    );
    await settle();
  };
  const dispatch = async (target: EventTarget, event: Event) => {
    await act(async () => {
      target.dispatchEvent(event);
    });
    await settle();
  };
  return {
    client,
    scene,
    probe: p,
    surface,
    story,
    storyIs,
    caretAt,
    dispatch,
    settle,
  };
}

const typed = (inputType: string, data: string | null) =>
  new InputEvent("beforeinput", {
    inputType,
    data,
    bubbles: true,
    cancelable: true,
  });

/** A composition event: happy-dom has no CompositionEvent, so the data
 *  rides on a plain event, which is all the handlers read. */
function composition(type: string, data: string): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "data", { value: data });
  return event;
}

const keydown = (init: KeyboardEventInit & { keyCode?: number }) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: init.keyCode });
  }
  return event;
};

describe("text entry with a caret in a story", () => {
  test("a caret takes keyboard focus for the input surface; focus that drops to nothing comes back", async () => {
    const t = await mount();
    expect(document.activeElement).not.toBe(t.surface());
    await t.caretAt(0);
    expect(document.activeElement).toBe(t.surface());
    // A script's blur (or a click on a panel's background) drops focus to
    // the page; the live caret takes it back.
    await act(async () => t.surface().blur());
    await t.settle();
    expect(document.activeElement).toBe(t.surface());
  });

  test("a caret that goes away hands keyboard focus back to the canvas viewport the surface sits in", async () => {
    const t = await mount();
    await t.caretAt(0);
    expect(document.activeElement).toBe(t.surface());
    const viewport = t.surface().closest('[data-canvas-surface="viewport"]');
    expect(viewport, "the surface is laid over the canvas viewport").not.toBe(
      null,
    );
    await act(async () => t.probe.setSelection(null));
    await t.settle();
    // Not the caretless textarea: there the arrows and Backspace would
    // stay the text field's, and the selected frame would not nudge.
    expect(document.activeElement).toBe(viewport);
  });

  test("SH-3 (F-36): text an input method commits (insertText) lands in the story, emoji included", async () => {
    const t = await mount();
    await t.caretAt(0);
    const before = await t.story();
    const commit = typed("insertText", "é–@");
    await t.dispatch(t.surface(), commit);
    expect(commit.defaultPrevented).toBe(true);
    await t.storyIs(`é–@${before}`);
    // The caret advanced by the UTF-8 length (é is two bytes, – three).
    expect(t.probe.selection()?.start).toBe(6);
    await t.dispatch(t.surface(), typed("insertText", "😀"));
    await t.storyIs(`é–@😀${before}`);
    expect(t.probe.selection()?.start).toBe(10);
    // The textarea itself never holds the text.
    expect(t.surface().value).toBe("");
  });

  test("SH-3 (F-36): a composition stays the input method's until committed: no binding fires, nothing is typed, then the commit lands", async () => {
    const t = await mount();
    let fired = 0;
    t.probe.registries.commands.register({
      id: "test.composition.chord",
      title: "chord",
      handler: () => void fired++,
    });
    t.probe.registries.keybindings.register({
      key: "ctrl+q",
      command: "test.composition.chord",
    });
    await t.caretAt(0);
    const before = await t.story();

    await t.dispatch(t.surface(), composition("compositionstart", ""));
    // The keys of the composition: isComposing, and keyCode 229 for the
    // key that started it.
    await t.dispatch(
      t.surface(),
      keydown({ key: "q", ctrlKey: true, isComposing: true }),
    );
    await t.dispatch(
      t.surface(),
      keydown({ key: "q", ctrlKey: true, keyCode: 229 }),
    );
    await t.dispatch(t.surface(), keydown({ key: "Enter", isComposing: true }));
    expect(fired).toBe(0);
    // The marked text shows in the surface while it composes.
    t.surface().value = "にほ";
    await t.dispatch(t.surface(), typed("insertCompositionText", "にほ"));
    expect(t.surface().getAttribute("data-composing")).toBe("true");
    expect(await t.story()).toBe(before);

    await t.dispatch(t.surface(), composition("compositionend", "日本"));
    await t.storyIs(`日本${before}`);
    expect(t.surface().value).toBe("");
    // Outside a composition the chord is a shortcut again (the control).
    await t.dispatch(t.surface(), keydown({ key: "q", ctrlKey: true }));
    expect(fired).toBe(1);
  });

  test("a dead key composes its accent: ´ then e is é", async () => {
    const t = await mount();
    await t.caretAt(0);
    const before = await t.story();
    await t.dispatch(t.surface(), composition("compositionstart", ""));
    t.surface().value = "´";
    await t.dispatch(t.surface(), typed("insertCompositionText", "´"));
    await t.dispatch(t.surface(), composition("compositionend", "é"));
    await t.storyIs(`é${before}`);
  });

  test("Option and AltGr characters type, from the surface and from anywhere that types nothing", async () => {
    const t = await mount();
    await t.caretAt(0);
    const before = await t.story();
    // On the surface: the keydown (Option+- on macOS) is the browser's,
    // which then delivers the character as input.
    const option = keydown({ key: "–", altKey: true });
    await t.dispatch(t.surface(), option);
    expect(option.defaultPrevented).toBe(false);
    await t.dispatch(t.surface(), typed("insertText", "–"));
    await t.storyIs(`–${before}`);
    // Focus on the page (a click left it there): the keydown types, and
    // focus returns to the surface. AltGr reports Ctrl+Alt.
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.dispatchEvent(
        keydown({ key: "@", ctrlKey: true, altKey: true }),
      );
    });
    await t.storyIs(`–@${before}`);
    expect(document.activeElement).toBe(t.surface());
    // Cmd and plain Ctrl chords never type.
    await t.dispatch(document.body, keydown({ key: "b", metaKey: true }));
    await t.dispatch(document.body, keydown({ key: "b", ctrlKey: true }));
    expect(await t.story()).toBe(`–@${before}`);
  });

  test("paste puts the clipboard's plain text into the story at the caret", async () => {
    const t = await mount();
    await t.caretAt(0);
    const before = await t.story();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text/plain" ? "Pasted " : ""),
      },
    });
    await t.dispatch(t.surface(), paste);
    expect(paste.defaultPrevented).toBe(true);
    await t.storyIs(`Pasted ${before}`);
  });

  test("picking a drawing tool ends the text selection, so Enter is the tool's (a Pen path commits) and not a paragraph break", async () => {
    const t = await mount();
    await t.caretAt(0);
    const before = await t.story();
    await act(async () => t.probe.tool().setBaseTool("paged.tool.pen"));
    await t.settle();
    expect(t.probe.selection()).toBeNull();
    // Enter no longer reaches the story.
    await t.dispatch(document.body, keydown({ key: "Enter" }));
    await t.settle();
    expect(await t.story()).toBe(before);
  });

  test("the caret survives the tools that work with text and a spring-loaded hold", async () => {
    const t = await mount();
    await t.caretAt(0);
    for (const id of [
      "paged.tool.type",
      "paged.tool.select",
      "paged.tool.eyedropper",
    ]) {
      await act(async () => t.probe.tool().setBaseTool(id));
      await t.settle();
      expect(t.probe.selection(), id).not.toBeNull();
    }
    // Held Space: the Hand comes and goes as a suspend, never a switch.
    await act(async () => t.probe.tool().setBaseTool("paged.tool.type"));
    await act(async () => t.probe.tool().pushOverride("paged.tool.pen"));
    await t.settle();
    expect(t.probe.selection()).not.toBeNull();
    await act(async () => t.probe.tool().popOverride("paged.tool.pen"));
    await t.settle();
    expect(t.probe.selection()).not.toBeNull();
  });

  test("Enter is a paragraph break, Shift+Enter a forced line break, Tab a tab character", async () => {
    covers("keybinding:tab→paged.chrome.toggleAll");
    const t = await mount();
    await t.caretAt(0);
    const before = await t.story();
    const tab = keydown({ key: "Tab" });
    await t.dispatch(t.surface(), tab);
    expect(tab.defaultPrevented).toBe(true);
    await t.storyIs(`\t${before}`);
    await t.dispatch(t.surface(), keydown({ key: "Enter", shiftKey: true }));
    await t.storyIs(`\t\u2028${before}`);
    await t.dispatch(t.surface(), keydown({ key: "Enter" }));
    await t.storyIs(`\t\u2028\n${before}`);
  });
});
