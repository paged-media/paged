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

// Editor ADR 1203, amendment 2: the canvas is editable from a load's
// geometry stage (ADR 1208) while its tail — the other pages composed and
// pictured — runs on, and an importer's open marks the file it opened as
// saved once it has settled (UX audit F-08). That mark swallowed an edit
// made in the tail: the document read clean, the save status said Saved
// and closing asked nothing. The whole PagedShell over the real engine,
// opening an IDML file through an importer and the editor's native-document
// door as paged.publish's importer does: an edit at the first paint or
// while the other pages are prepared leaves the document edited; a
// document opened with no edit, or one the importer itself writes after
// its open (paged.doc's pour), reads clean.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { CanvasClient, type DocumentHandle } from "@paged-media/client";
import {
  PagedShell,
  createEditorScope,
  loadDocumentFile,
  useRegistries,
  type LoadingState,
  type ModeContribution,
  type ShellRegistries,
} from "@paged-media/shell";
import { buildFixtureIdml, covers } from "@paged-media/test-kit";

import { createEditorNativeDocumentBackend } from "../../src/plugin-native-document";
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

afterEach(() => {
  cleanup();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Three pages: the load's tail has a first paint and a refining stage. */
const threePages = () =>
  new File(
    [
      buildFixtureIdml({
        name: "three-pages",
        pages: [
          { id: "up1", items: [] },
          { id: "up2", items: [] },
          { id: "up3", items: [] },
        ],
      }).slice(),
    ],
    "Three pages.idml",
    { type: "application/vnd.adobe.indesign-idml-package" },
  );

type Stage = NonNullable<LoadingState["stage"]>;

/**
 * The shell, with an `.idml` importer that opens the file through the
 * editor's native-document door and the shell's loader (the app's
 * `openBytes`). `editAt` makes an edit the moment the load reports that
 * stage, as a user working on the first page would; `afterOpen` runs once
 * the open has resolved, as an importer that builds its document does.
 */
async function openWith(opts: {
  editAt?: Stage;
  afterOpen?: (client: CanvasClient, handle: DocumentHandle) => Promise<void>;
}) {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  await client.newBlankDocument(612, 792);
  let registries: ShellRegistries | null = null;
  let view!: ReturnType<typeof render>;
  const scope = createEditorScope();
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        scope={scope}
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

  const stages: Stage[] = [];
  const edits: Array<Promise<unknown>> = [];
  let handle: DocumentHandle | null = null;
  const backend = createEditorNativeDocumentBackend(
    scope,
    () => client,
    async (bytes, name) => {
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      await loadDocumentFile(client, new File([ab], name), {
        setHandle: (h) => (handle = h),
        setLoading: (l) => {
          if (!l?.stage) return;
          stages.push(l.stage);
          if (l.stage === opts.editAt && edits.length === 0 && handle)
            edits.push(
              client.mutate({
                op: "insertFrame",
                args: { pageId: handle.pageIds[0]!, bounds: [20, 20, 80, 80] },
              }),
            );
        },
        setStatus: () => {},
        setSnapshotsReady: () => {},
        addSnapshot: () => {},
        resetForNewDocument: () => {},
        pushWarning: () => {},
        scope,
      });
    },
  );
  let imported!: () => void;
  const done = new Promise<void>((resolve) => (imported = resolve));
  r.importers.register({
    id: "test.idml",
    title: "IDML package",
    extensions: [".idml"],
    mimeTypes: ["application/vnd.adobe.indesign-idml-package"],
    import: async (file) => {
      try {
        await backend.open(file.bytes);
        if (opts.afterOpen && handle) await opts.afterOpen(client, handle);
      } finally {
        imported();
      }
    },
  });

  const target = view.container.querySelector("[data-cockpit-canvas]");
  if (!target) throw new Error("no canvas drop target");
  await act(async () => {
    fireEvent.drop(target, {
      dataTransfer: { files: [threePages()], types: [] },
    });
  });
  await act(async () => {
    await done;
  });
  await settle();
  for (const e of edits)
    expect(await e).toMatchObject({ kind: "mutationApplied" });
  const meta = await client.documentMeta();
  return {
    stages,
    edits: edits.length,
    dirty: meta.dirty,
    pages: meta.pageCount,
  };
}

describe("an edit made while a document loads is not the file (ADR 1203, amendment 2)", () => {
  test("opened with no edit, the document reads clean", async () => {
    covers("command:paged.file.openIdml");
    const s = await openWith({});
    expect(s.pages).toBe(3);
    expect(s.stages).toContain("firstPaint");
    expect(s.stages).toContain("refining");
    expect(s.dirty).toBe(false);
  });

  test("an edit at the first paint leaves the document edited", async () => {
    covers("command:paged.file.openIdml");
    const s = await openWith({ editAt: "firstPaint" });
    expect([s.edits, s.pages]).toEqual([1, 3]);
    expect(s.dirty).toBe(true);
  });

  test("an edit while the other pages are prepared leaves the document edited", async () => {
    covers("command:paged.file.openIdml");
    const s = await openWith({ editAt: "refining" });
    expect([s.edits, s.pages]).toEqual([1, 3]);
    expect(s.dirty).toBe(true);
  });

  test("what the importer itself writes after its open is the file: clean", async () => {
    covers("command:paged.file.openIdml");
    const s = await openWith({
      afterOpen: async (client, handle) => {
        const reply = await client.mutate({
          op: "insertFrame",
          args: { pageId: handle.pageIds[0]!, bounds: [100, 100, 160, 160] },
        });
        expect(reply.kind).toBe("mutationApplied");
      },
    });
    expect(s.pages).toBe(3);
    expect(s.dirty).toBe(false);
  });
});
