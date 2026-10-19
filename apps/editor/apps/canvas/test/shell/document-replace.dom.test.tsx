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

// SH-10 (UX audit F-01, root R8): a file dropped on the canvas replaced an
// edited document at once. The whole PagedShell mounted in happy-dom over
// the real engine: an edit makes the document dirty, a drop on the canvas
// drop target asks the replace question (ADR 230), and each answer does
// what it says. File ▸ New, the control, asks through the same prompt.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { CanvasClient } from "@paged-media/client";
import {
  PagedShell,
  setDocumentSaver,
  useRegistries,
  type ModeContribution,
  type ShellRegistries,
} from "@paged-media/shell";
import { covers, gestureFixture } from "@paged-media/test-kit";

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

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  cleanup();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountShell() {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  const blank = await client.newBlankDocument(612, 792);
  let registries: ShellRegistries | null = null;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        panels={[
          { id: "test.left", title: "Left", component: () => <p>left</p> },
        ]}
        modes={MODES}
        initialMode="design"
        canvasComponent={() => <div data-test-canvas />}
      >
        <Capture onRegistries={(r) => (registries = r)} />
      </PagedShell>,
    );
  });
  await settle();
  if (!registries) throw new Error("PagedShell did not publish registries");
  const r: ShellRegistries = registries;
  return {
    client,
    registries: r,
    view,
    /** An edit: the document now has unsaved changes. */
    async edit() {
      const reply = await client.mutate({
        op: "insertFrame",
        args: { pageId: blank.pageIds[0], bounds: [20, 20, 80, 80] },
      });
      expect(reply.kind).toBe("mutationApplied");
      expect((await client.documentMeta()).dirty).toBe(true);
    },
    async drop(file: File) {
      const target = view.container.querySelector("[data-cockpit-canvas]");
      if (!target) throw new Error("no canvas drop target");
      await act(async () => {
        fireEvent.drop(target, { dataTransfer: { files: [file], types: [] } });
      });
      await settle();
    },
    dialog: () =>
      document.querySelector('[data-testid="replace-document-dialog"]'),
    button: (id: string) =>
      document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`),
    async click(id: string) {
      const b = document.querySelector<HTMLButtonElement>(
        `[data-testid="${id}"]`,
      );
      if (!b) throw new Error(`no ${id} button`);
      await act(async () => {
        fireEvent.click(b);
      });
      await settle();
    },
  };
}

const targetsFile = () =>
  new File([gestureFixture("targets").slice()], "Targets.idml", {
    type: "application/vnd.adobe.indesign-idml-package",
  });

describe("SH-10 (UX audit F-01): a drop on an edited document asks first", () => {
  test("the drop asks; Cancel keeps the document and its edit", async () => {
    covers("command:paged.file.openIdml");
    const s = await mountShell();
    await s.edit();
    await s.drop(targetsFile());
    expect(s.dialog()).not.toBeNull();
    expect(s.dialog()?.getAttribute("role")).toBe("alertdialog");
    expect(s.dialog()?.textContent).toContain("Opening Targets.idml");
    // No save is registered in this mount: Don't save and Cancel only.
    expect(s.button("replace-document-save")).toBeNull();
    await s.click("replace-document-keep");
    expect(s.dialog()).toBeNull();
    const meta = await s.client.documentMeta();
    expect([meta.dirty, meta.pageCount]).toEqual([true, 1]);
  });

  test("Don't save replaces the document with the dropped file", async () => {
    covers("command:paged.file.openIdml");
    const s = await mountShell();
    await s.edit();
    await s.drop(targetsFile());
    await s.click("replace-document-discard");
    await settle();
    expect(s.dialog()).toBeNull();
    const meta = await s.client.documentMeta();
    expect(meta.dirty).toBe(false);
    expect(meta.pageCount).toBe(2);
  });

  test("Save saves first, then replaces", async () => {
    covers("command:paged.file.openIdml");
    const s = await mountShell();
    let saves = 0;
    disposers.push(
      setDocumentSaver(() => {
        saves += 1;
        s.client.markSaved();
      }),
    );
    await s.edit();
    await s.drop(targetsFile());
    expect(s.button("replace-document-save")).not.toBeNull();
    // The default answer is Save, never Don't save.
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "replace-document-save",
    );
    await s.click("replace-document-save");
    await settle();
    expect(saves).toBe(1);
    expect((await s.client.documentMeta()).pageCount).toBe(2);
  });

  test("control: File ▸ New asks through the same prompt", async () => {
    covers("command:paged.file.new");
    const s = await mountShell();
    await s.edit();
    let invoked: Promise<unknown> = Promise.resolve();
    await act(async () => {
      invoked = s.registries.commands.invoke("paged.file.new");
    });
    await settle();
    expect(s.dialog()?.textContent).toContain("Creating a new document");
    await s.click("replace-document-keep");
    await invoked;
    expect((await s.client.documentMeta()).dirty).toBe(true);
  });
});
