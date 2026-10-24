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

// Editor ADRs 298 and 299 (extensions ADR 348): a plugin content type's
// chrome and keys, over the real engine and the canvas text editor.
//
//   · a keybinding scoped to the active context takes the text input's
//     keys (Tab, Cmd+B) before `useTextEditing` does, and only while the
//     context is active — outside it Tab is a tab character again;
//   · the document context (a Word document opened as the document) makes
//     the scope active with no frame context entered;
//   · the control bar shows the context's contributed groups in place of
//     the text controls, and the status bar its items; neither exists
//     while the context is not active.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import {
  CanvasClient,
  type ContentSelection,
  type DocumentHandle,
} from "@paged-media/client";
import {
  PagedShell,
  StatusBar,
  useContentSelection,
  useRegistries,
  type ShellRegistries,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";

import { DesignControlBar } from "../../src/cockpit/control-bar";
import { TextInputSurface } from "../../src/ui/TextInputSurface";
import { useTextEditing } from "../../src/ui/useTextEditing";
import { EngineWorker, headlessEngine } from "../panels/engine-worker";
import { textScene } from "../panels/fixtures";

afterEach(() => cleanup());

interface Probe {
  registries: ShellRegistries;
  setSelection(sel: ContentSelection | null): void;
}

function Integration({
  client,
  onProbe,
}: {
  client: CanvasClient;
  onProbe(p: Probe): void;
}) {
  const registries = useRegistries();
  const { contentSelection, setContentSelection } = useContentSelection();
  useTextEditing({
    client,
    selection: contentSelection,
    setSelection: setContentSelection,
  });
  useEffect(() => {
    onProbe({ registries, setSelection: setContentSelection });
  }, [registries, setContentSelection, onProbe]);
  return (
    <>
      <DesignControlBar />
      <StatusBar />
    </>
  );
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
    if (reply.kind !== "storyContentResult" || !reply.payload.content)
      throw new Error("no story content");
    return reply.payload.content.paragraphs
      .map((para) => para.runs.map((r) => r.text).join(""))
      .join("\n");
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
  const press = async (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      surface().dispatchEvent(event);
    });
    await settle();
    return event;
  };
  return { client, probe: p, story, caretAt, press, settle };
}

/** Register the Word-like contributions: a command per key, scoped. */
function contribute(registries: ShellRegistries, ran: string[]) {
  for (const id of ["word.level", "word.bold"])
    registries.commands.register({
      id,
      title: id,
      handler: () => void ran.push(id),
    });
  registries.keybindings.register({
    key: "tab",
    command: "word.level",
    scope: { editContext: "wordDocument" },
  });
  registries.keybindings.register({
    key: "cmd+b",
    command: "word.bold",
    scope: { editContext: "wordDocument" },
  });
  registries.controlBarGroups.register({
    id: "word.home",
    title: "Home",
    scope: { editContext: "wordDocument" },
    render: () => <span data-testid="word-home">Home group</span>,
  });
  registries.statusItems.register({
    id: "word.words",
    scope: { editContext: "wordDocument" },
    render: () => <span data-testid="word-words">12 words</span>,
  });
}

describe("a plugin content type's keys and chrome (editor ADRs 298, 299)", () => {
  test("outside the context Tab types a tab and the chrome is the host's", async () => {
    const t = await mount();
    const ran: string[] = [];
    await act(async () => contribute(t.probe.registries, ran));
    await t.caretAt(0);
    const before = await t.story();
    await t.press({ key: "Tab" });
    for (let i = 0; i < 40 && (await t.story()) === before; i++)
      await t.settle();
    expect(await t.story()).toBe(`\t${before}`);
    expect(ran).toEqual([]);
    expect(document.querySelector("[data-status-bar]")).toBeNull();
    expect(document.querySelector('[data-testid="word-home"]')).toBeNull();
    expect(
      document
        .querySelector("[data-control-bar]")
        ?.getAttribute("data-control-bar"),
    ).toBe("text");
  });

  test("with the document context the scoped keys win over the text input", async () => {
    const t = await mount();
    const ran: string[] = [];
    await act(async () => {
      contribute(t.probe.registries, ran);
      t.probe.registries.documentContext.set("media.paged.doc", "wordDocument");
    });
    await t.caretAt(0);
    const before = await t.story();
    const tab = await t.press({ key: "Tab" });
    expect(tab.defaultPrevented).toBe(true);
    await t.press({ key: "b", metaKey: true });
    await t.settle();
    expect(ran).toEqual(["word.level", "word.bold"]);
    // The text did not get the Tab.
    expect(await t.story()).toBe(before);
  });

  test("the control bar shows the context's groups and the status bar its items", async () => {
    const t = await mount();
    const ran: string[] = [];
    await act(async () => {
      contribute(t.probe.registries, ran);
      t.probe.registries.documentContext.set("media.paged.doc", "wordDocument");
    });
    await t.caretAt(0);
    expect(
      document
        .querySelector("[data-control-bar]")
        ?.getAttribute("data-control-bar"),
    ).toBe("contributed");
    expect(document.querySelector('[data-testid="word-home"]')).not.toBeNull();
    expect(
      document
        .querySelector("[data-status-bar]")
        ?.getAttribute("data-status-bar"),
    ).toBe("wordDocument");
    expect(document.querySelector('[data-testid="word-words"]')).not.toBeNull();
    // Dropping the document context takes both away.
    await act(async () =>
      t.probe.registries.documentContext.set("media.paged.doc", null),
    );
    await t.settle();
    expect(document.querySelector("[data-status-bar]")).toBeNull();
    expect(document.querySelector('[data-testid="word-home"]')).toBeNull();
  });

  test("loading a document drops the document context", async () => {
    const t = await mount();
    await act(async () => {
      t.probe.registries.documentContext.set("media.paged.doc", "wordDocument");
    });
    expect(t.probe.registries.documentContext.get()?.type).toBe("wordDocument");
    // A new document arrives through the client like any load.
    await act(async () => {
      await t.client.newBlankDocument(612, 792);
    });
    await t.settle();
    expect(t.probe.registries.documentContext.get()).toBeNull();
  });
});
