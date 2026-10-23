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

// The editor as an instance (plan task E1): mounted as a host embeds it,
// the shell writes nothing on the page's <html> or <body> (no class, no
// style, no attribute, no listener) and nothing to the page's storage; it
// keeps its theme, its popovers and its keys inside its own root; and two
// shells on one page answer only their own keys.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { CanvasClient } from "@paged-media/client";
import {
  PagedShell,
  createEditorScope,
  memoryStorage,
  notifyExportPdfDialog,
  setEditorStorage,
  useRegistries,
  type EditorScope,
  type ModeContribution,
  type ShellRegistries,
} from "@paged-media/shell";

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

function Capture({ onRegistries }: { onRegistries(r: ShellRegistries): void }) {
  const registries = useRegistries();
  useEffect(() => {
    onRegistries(registries);
  }, [registries, onRegistries]);
  return null;
}

afterEach(() => cleanup());

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** What a mount could write on the page: <html> and <body>. */
function pageState() {
  const of = (el: Element) => ({
    attributes: [...el.attributes].map((a) => `${a.name}=${a.value}`).sort(),
    className: el.className,
  });
  return { html: of(document.documentElement), body: of(document.body) };
}

/** Count listeners added to <html> and <body> while `run` runs. */
async function listenersAdded(run: () => Promise<void>): Promise<string[]> {
  const added: string[] = [];
  const targets = [document.documentElement, document.body];
  const originals = targets.map((t) => t.addEventListener);
  targets.forEach((t, i) => {
    t.addEventListener = function (
      this: EventTarget,
      type: string,
      ...rest: unknown[]
    ) {
      added.push(`${t.nodeName}:${type}`);
      return (originals[i] as (...a: unknown[]) => void).call(
        this,
        type,
        ...rest,
      );
    } as typeof t.addEventListener;
  });
  try {
    await run();
  } finally {
    targets.forEach((t, i) => (t.addEventListener = originals[i]!));
  }
  return added;
}

interface Mounted {
  host: HTMLElement;
  scope: EditorScope;
  registries: ShellRegistries;
  root: HTMLElement;
  unmount(): void;
}

/** One shell, mounted as an embedding host mounts it: in its own element,
 *  owning neither the page nor its unload question, with memory storage. */
async function mountShell(): Promise<Mounted> {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  await client.newBlankDocument(612, 792);
  const scope = createEditorScope();
  setEditorStorage(scope, memoryStorage());
  const host = document.createElement("div");
  document.body.append(host);
  let registries: ShellRegistries | null = null;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        scope={scope}
        ownsPage={false}
        guardUnload={false}
        panels={[
          { id: "test.left", title: "Left", component: () => <p>left</p> },
        ]}
        modes={MODES}
        initialMode="design"
        canvasComponent={() => <button data-test-canvas>canvas</button>}
      >
        <Capture onRegistries={(r) => (registries = r)} />
      </PagedShell>,
      { container: host },
    );
  });
  await settle();
  if (!registries) throw new Error("PagedShell did not publish registries");
  const root = host.querySelector<HTMLElement>("[data-paged-editor]");
  if (!root) throw new Error("no editor root");
  return {
    host,
    scope,
    registries,
    root,
    unmount: () => {
      view.unmount();
      host.remove();
      client.dispose();
    },
  };
}

describe("the editor as an instance (E1)", () => {
  test("a mount writes nothing on <html> or <body>, and keeps its theme and storage to itself", async () => {
    const before = pageState();
    const storedBefore = localStorage.length;
    let shell!: Mounted;
    const added = await listenersAdded(async () => {
      shell = await mountShell();
    });
    expect(added).toEqual([]);
    expect(pageState()).toEqual(before);
    // The theme is the root's: dark by default, and a flip stays there.
    expect(shell.root.classList.contains("dark")).toBe(true);
    await act(async () => {
      shell.root.querySelector<HTMLElement>("[data-theme-toggle]")!.click();
    });
    await settle();
    expect(shell.root.classList.contains("dark")).toBe(false);
    expect(pageState()).toEqual(before);
    // Nothing reached the page's storage: the host gave memory.
    expect(localStorage.length).toBe(storedBefore);
    shell.unmount();
    expect(pageState()).toEqual(before);
  });

  test("its dialogs portal inside its root, not into <body>", async () => {
    const shell = await mountShell();
    await act(async () => notifyExportPdfDialog(shell.scope, "open"));
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // The dialog and its overlay are the root's (its portal container);
    // only the modal's focus guards sit at the page's edges while it is
    // open, as a modal's must.
    expect(shell.root.contains(dialog)).toBe(true);
    expect(
      [...document.body.children].filter(
        (el) =>
          el !== shell.host &&
          !el.hasAttribute("data-radix-focus-guard") &&
          el.querySelector("[data-paged-editor]") === null,
      ),
    ).toEqual([]);
    shell.unmount();
  });

  test("two shells on one page: a key is the editor's it was typed in", async () => {
    const a = await mountShell();
    const b = await mountShell();
    const heard = { a: [] as string[], b: [] as string[] };
    const offs = [
      a.registries.commands.observe((e) => {
        if (e.phase === "started") heard.a.push(e.invocation.id);
      }),
      b.registries.commands.observe((e) => {
        if (e.phase === "started") heard.b.push(e.invocation.id);
      }),
    ];
    const cmdK = (target: EventTarget) =>
      act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "k",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    // Typed with nothing focused, neither embedded editor pointed at yet:
    // the host's.
    await cmdK(document.body);
    expect(heard).toEqual({ a: [], b: [] });
    // Typed inside A: A's palette, not B's.
    await cmdK(a.root.querySelector("[data-test-canvas]")!);
    expect(heard.a).toEqual(["paged.palette.toggle"]);
    expect(heard.b).toEqual([]);
    // Pointed at, B takes the keys typed with nothing focused.
    await act(async () => {
      b.root
        .querySelector("[data-test-canvas]")!
        .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    await cmdK(document.body);
    expect(heard.b).toEqual(["paged.palette.toggle"]);
    expect(heard.a).toEqual(["paged.palette.toggle"]);
    for (const off of offs) off.dispose();
    a.unmount();
    b.unmount();
  });
});
