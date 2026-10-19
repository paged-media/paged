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

// The hosts the BundleHost contract runs against.
//
// A bundle sees one `BundleHost`; plugin-api documents what each door does.
// Three adapters build one, and each case runs on every adapter it applies
// to:
//
//   · `editor`   — the editor's: the headless editor (./harness.ts: the
//                  shell's PagedEditor and registries over a real
//                  CanvasClient and engine) loading the probe through the
//                  SDK's `loadBundle` with the options main.tsx passes
//                  (`createEditorHostOptions`). Browser platform objects the
//                  editor's backends talk to (OPFS, `navigator.clipboard`,
//                  `localStorage`) are faked at the PLATFORM level, below the
//                  backend, so the backend's own code runs; what needs the
//                  browser shell (panel placement, edit-context entry) is
//                  recorded in `ed.opened`.
//   · `headless` — plugin-sdk's `createHeadlessHost`, the in-process adapter
//                  a bundle's own conformance tests use (in-memory stores).
//   · `bare`     — the SDK's adapter with NO options: every door's documented
//                  no-backend answer.
//
// A divergence between `editor` and `headless` on the same case is a
// finding: a bundle tested headlessly would meet a different host in the
// editor.

import { fileURLToPath } from "node:url";

import type {
  BundleHost,
  PagedBundle,
  PagedEditor,
  PluginManifest,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  createHeadlessHost,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";

import type { EditorHostOptions } from "../../../src/plugin-host-options";
import type { EditorConsent } from "../../../src/plugin-consent";
import type { EditorSecretStore } from "../../../src/plugin-secret-store";
import type { createEditorDocuments } from "../../../src/plugin-documents";
import type { WillSaveRegistry } from "../../../src/plugin-will-save";
import type { ProblemEntry } from "../../../src/panels/problems-store";
import { resetProblems } from "../../../src/panels/problems-store";
import type { ModuleManifest } from "../../../src/plugin-modules";
import type { BundleWorkerModuleResolver } from "../../../src/plugin-worker";

import { createHeadlessEditor, type HeadlessEditor } from "../harness";
import { fakeOpfs, fakeSystemClipboard, fakeLocalStorage } from "./platform";

/** The engine is this app's own @paged-media/canvas-wasm dependency. */
export const ENGINE_ANCHOR = fileURLToPath(
  new URL("../../..", import.meta.url),
);

export const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The probe bundle's id and its sibling's (for the namespacing cases). */
export const PROBE_ID = "media.paged.probe";
export const OTHER_ID = "media.paged.probeother";

/** A probe that declares every capability a door is gated on, and one of
 *  each contribution, so a case exercises the door rather than the gate.
 *  The gate itself is asserted with `narrow()`. */
export function probeManifest(
  id: string = PROBE_ID,
  extra: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id,
    name: `probe ${id}`,
    version: "0.0.0",
    apiVersion: "^0.2.0",
    capabilities: {
      document: {
        read: "broad",
        write: "broad",
        readNative: true,
        openNative: true,
      },
      rendering: ["overlay", "hitTest", "sceneLayer", "resourceProvider"],
      keybindings: true,
      storage: { blob: true, quotaBytes: 64 * 1024 },
      network: { origins: ["https://data.example.org"], purpose: "probe" },
      dataProviders: { publish: ["table"], consume: ["table"] },
      clipboard: "full",
      secrets: { sources: true },
      documents: { export: true, open: true },
      workers: { max: 2 },
      wasm: [{ name: "probe", path: "wasm/probe.wasm", purpose: "compute" }],
    },
    contributes: {
      tools: [`${id}.tool.one`],
      panels: [`${id}.panel.one`],
      commands: [`${id}.command.one`, `${id}.command.two`],
      importers: [`${id}.importer.one`],
      exporters: [`${id}.exporter.one`],
      editContexts: [{ type: "probeFrame", entry: "doubleClick" }],
      objectTypes: [{ type: "probeFrame", bakedFallback: "rectangle" }],
    },
    ...extra,
  };
}

/** A bundle that hands its host out and contributes nothing. */
export function probeBundle(manifest: PluginManifest): {
  bundle: PagedBundle;
  host: () => BundleHost;
} {
  let got: BundleHost | null = null;
  return {
    bundle: {
      manifest,
      activate(host) {
        got = host;
        return { dispose() {} };
      },
    },
    host: () => {
      if (!got) throw new Error(`${manifest.id} was not activated`);
      return got;
    },
  };
}

export type AdapterName = "editor" | "headless" | "bare";

/** What a case gets: the probe's host and the means to play the user. */
export interface HostUnderTest {
  readonly name: AdapterName;
  /** The host the probe bundle's `activate` received. */
  readonly host: BundleHost;
  /** A host for ANOTHER plugin over the same backends (namespacing). */
  sibling(manifest?: PluginManifest): BundleHost;
  /** A host for a probe with a different manifest (capability gates). */
  withManifest(manifest: PluginManifest): BundleHost;
  /** Dispose the probe bundle and activate it again (a reload): the new
   *  host the bundle receives. `host` keeps pointing at the first one. */
  reactivate(): BundleHost;
  /** Load an IDML package into the document; resolves its page ids. */
  load(idml: Uint8Array): Promise<string[]>;
  /** A new blank one-page document. */
  newBlank(): Promise<string[]>;
  /** The engine-backed editor every adapter's host reads. */
  readonly editor: PagedEditor;
  /** The editor-only controllers (null on the SDK adapters). */
  readonly editorApp: EditorApp | null;
  dispose(): void | Promise<void>;
}

/** The editor app around the editor adapter's host, so a case can play the
 *  user (answer a prompt, set a tool option, move the caret) and observe what
 *  the editor's chrome was asked to do. */
export interface EditorApp {
  ed: HeadlessEditor;
  options: EditorHostOptions;
  consent: EditorConsent;
  secrets: EditorSecretStore;
  documents: ReturnType<typeof createEditorDocuments>;
  /** The will-save registry File ▸ Save runs (`run`) before it exports. */
  willSave: WillSaveRegistry;
  /** What the Problems panel lists (the editor's diagnostics sink). */
  problems: () => ProblemEntry[];
  /** The worker modules the editor serves per plugin; a case adds the
   *  probe's. */
  workerResolvers: Record<string, BundleWorkerModuleResolver>;
  /** What the shell was asked to do: `openPanel` / `closePanel` /
   *  `enterEditContext` entries. */
  opened: HeadlessEditor["opened"];
  /** The shell's tool-options store (what the tool-options popover writes). */
  toolSettings: {
    set(toolId: string, key: string, value: number | boolean | string): void;
  };
  /** The live content selection the caret reader reads. */
  caret: { current: unknown };
  platform: {
    opfs: ReturnType<typeof fakeOpfs>;
    clipboard: ReturnType<typeof fakeSystemClipboard>;
  };
}

/** The module manifest the editor's module door answers from in these
 *  tests: the probe's one wasm artifact, served in dev from `/@fs/`. */
export const PROBE_MODULES: ModuleManifest = {
  host: null,
  packages: {
    "@paged-media/probe": {
      version: "0.0.0",
      files: {
        "probe/wasm/probe.wasm": {
          version: "0.0.0",
          integrity: "sha384-probe",
          fs: "/repo/modules/probe/wasm/probe.wasm",
        },
      },
    },
  },
  plugins: {
    [PROBE_ID]: { package: "@paged-media/probe", base: "probe" },
  },
};

async function engine(): Promise<HeadlessHost> {
  return createHeadlessHost({ console: silent, resolveFrom: ENGINE_ANCHOR });
}

/** The editor adapter: the editor's own options over the headless editor. */
export async function editorAdapter(): Promise<HostUnderTest> {
  const opfs = fakeOpfs();
  const clipboard = fakeSystemClipboard();
  const restoreStorage = fakeLocalStorage();
  const restoreOpfs = opfs.install();
  const restoreClipboard = clipboard.install();
  resetProblems();
  const ed = await createHeadlessEditor({
    blank: [612, 792],
    moduleManifest: PROBE_MODULES,
    origin: "http://localhost:5180",
  });
  // The probe is LOADED (loadBundle, as main.tsx loads a bundle); the
  // siblings and the narrowed manifests are hosts built with the same
  // options (`ed.host`), which is all a case needs of them.
  const host = await ed.loadBundle(probeBundle(probeManifest()).bundle);
  const make = (manifest: PluginManifest): BundleHost => ed.host(manifest);
  const app = ed.hostApp;
  const pageIds = (h: { pageIds: readonly string[] }) => [...h.pageIds];
  return {
    name: "editor",
    host,
    editor: ed.editor as unknown as PagedEditor,
    sibling: (m) => make(m ?? probeManifest(OTHER_ID)),
    withManifest: (m) => make(m),
    // A reload: the bundle's host is built again, over the same backends.
    reactivate: () => make(probeManifest()),
    load: async (idml) => pageIds(await ed.load(idml)),
    newBlank: async () => pageIds(await ed.client.newBlankDocument(612, 792)),
    editorApp: {
      ed,
      options: app.options,
      consent: app.consent,
      secrets: app.secrets,
      documents: app.documents,
      willSave: app.willSave,
      problems: () => ed.problems(),
      workerResolvers: app.workerResolvers,
      opened: ed.opened,
      toolSettings: ed.state.toolSettings,
      caret: ed.state.contentSelection.contentSelectionRef,
      platform: { opfs, clipboard },
    },
    async dispose() {
      await ed.dispose();
      resetProblems();
      restoreClipboard();
      restoreOpfs();
      restoreStorage();
    },
  };
}

/** The SDK's headless adapter (createHeadlessHost). */
export async function headlessAdapter(): Promise<HostUnderTest> {
  const hh = await engine();
  let lastProbe: { dispose(): void } | null = null;
  const load = (manifest: PluginManifest): BundleHost => {
    const probe = probeBundle(manifest);
    const loaded = hh.loadBundle(probe.bundle);
    if (manifest.id === PROBE_ID) lastProbe = loaded;
    return probe.host();
  };
  const host = load(probeManifest());
  return {
    name: "headless",
    host,
    editor: hh.host.editor,
    sibling: (m) => load(m ?? probeManifest(OTHER_ID)),
    withManifest: (m) => load(m),
    reactivate() {
      lastProbe?.dispose();
      return load(probeManifest());
    },
    load: (idml) => hh.load(idml),
    newBlank: () => hh.newBlank(612, 792),
    editorApp: null,
    dispose: () => hh.dispose(),
  };
}

/** The SDK's adapter with no options: the documented no-backend doors. */
export async function bareAdapter(): Promise<HostUnderTest> {
  const hh = await engine();
  const editor = hh.host.editor;
  const handles: Array<{ dispose(): void }> = [];
  const make = (manifest: PluginManifest): BundleHost => {
    const h = createBundleHost(() => editor, manifest, { console: silent });
    handles.push(h);
    return h.host;
  };
  return {
    name: "bare",
    host: make(probeManifest()),
    editor,
    sibling: (m) => make(m ?? probeManifest(OTHER_ID)),
    withManifest: (m) => make(m),
    reactivate: () => make(probeManifest()),
    load: (idml) => hh.load(idml),
    newBlank: () => hh.newBlank(612, 792),
    editorApp: null,
    dispose() {
      for (const h of handles.splice(0)) h.dispose();
      hh.dispose();
    },
  };
}

export const ADAPTERS: Record<AdapterName, () => Promise<HostUnderTest>> = {
  editor: editorAdapter,
  headless: headlessAdapter,
  bare: bareAdapter,
};
