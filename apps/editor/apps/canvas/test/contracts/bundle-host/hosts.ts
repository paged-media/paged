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
// Three adapters build one, and each case below runs on every adapter it
// applies to:
//
//   · `editor`   — the SDK's adapter (`loadBundle`) with the options the
//                  EDITOR passes (`createEditorHostOptions`, the same factory
//                  main.tsx calls), over the real engine. The app-level pieces
//                  the factory takes (panel placement, the widgets, the
//                  worker URLs, the module manifest) are test doubles; the
//                  backends behind the doors are the editor's own modules.
//                  Browser platform objects the backends talk to (OPFS,
//                  `navigator.clipboard`, `localStorage`) are faked at the
//                  PLATFORM level, below the backend, so the backend's own
//                  code runs.
//   · `headless` — plugin-sdk's `createHeadlessHost`, the in-process adapter
//                  a bundle's own conformance tests use (in-memory stores).
//   · `bare`     — the SDK's adapter with NO options: every door's documented
//                  no-backend answer.
//
// A divergence between `editor` and `headless` on the same case is a
// finding: a bundle tested headlessly would meet a different host in the
// editor.
//
// The editor's PagedEditor here is the harness's engine-backed one, not the
// shell's own handle (no shell editor runs without a browser yet), so the
// doors that are pure functions of the PagedEditor (document, selection,
// overlay, render) are the SDK's in both adapters; the doors the editor
// OPTIONS decide are the editor's own.

import { fileURLToPath } from "node:url";

import type {
  BundleHost,
  PagedBundle,
  PagedEditor,
  PluginManifest,
} from "@paged-media/plugin-api";
import {
  createBindingProviderRegistry,
  createBundleHost,
  createHeadlessHost,
  createObjectRegistry,
  createCoreObjects,
  loadBundle,
  type CreateBundleHostOptions,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";

import {
  createEditorHostOptions,
  hostOptionsForPlugin,
  type EditorHostOptions,
  type EditorHandleForHost,
} from "../../../src/plugin-host-options";
import {
  createEditorConsentBackend,
  type EditorConsent,
} from "../../../src/plugin-consent";
import {
  createEditorSecretStore,
  type EditorSecretStore,
} from "../../../src/plugin-secret-store";
import { createEditorDocuments } from "../../../src/plugin-documents";
import { createEditorNativeDocumentBackend } from "../../../src/plugin-native-document";
import {
  createWillSaveRegistry,
  type WillSaveRegistry,
} from "../../../src/plugin-will-save";
import {
  getProblemsSnapshot,
  problemsSink,
  resetProblems,
} from "../../../src/panels/problems-store";
import type { ModuleManifest } from "../../../src/plugin-modules";

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
  dispose(): void;
}

/** The app-level state the editor's options were built over, so a case can
 *  play the user (answer a prompt, set a tool option, move the caret). */
export interface EditorApp {
  options: EditorHostOptions;
  consent: EditorConsent;
  secrets: EditorSecretStore;
  documents: ReturnType<typeof createEditorDocuments>;
  /** The will-save registry File ▸ Save runs (`run`) before it exports. */
  willSave: WillSaveRegistry;
  /** What the Problems panel lists (the editor's diagnostics sink). */
  problems: typeof getProblemsSnapshot;
  /** What `host.shell.openPanel` / `closePanel` reached. */
  panelCalls: string[];
  /** What `host.shell.enterEditContext` reached. */
  entered: Array<{ type: string; elementId: unknown }>;
  /** The tool-options store the editor's options read (the shell's
   *  ToolSettingsProvider's contract: get / set / subscribe). */
  toolSettings: {
    set(toolId: string, key: string, value: number | boolean | string): void;
  };
  /** The live content selection the caret reader reads. */
  caret: { current: { storyId: string; start: number; cell?: unknown } | null };
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
} as unknown as ModuleManifest;

const noComponent = () => null;

/** A shell tool-settings store with the ToolSettingsProvider's semantics
 *  (the write moves the value before listeners run). */
function toolSettingsStore() {
  const values = new Map<string, Record<string, number | boolean | string>>();
  const subs = new Map<string, Set<() => void>>();
  return {
    get: (toolId: string) => values.get(toolId) ?? {},
    set(toolId: string, key: string, value: number | boolean | string) {
      values.set(toolId, { ...(values.get(toolId) ?? {}), [key]: value });
      for (const l of subs.get(toolId) ?? []) l();
    },
    subscribe(toolId: string, listener: () => void) {
      let set = subs.get(toolId);
      if (!set) subs.set(toolId, (set = new Set()));
      set.add(listener);
      return () => void set!.delete(listener);
    },
  };
}

async function engine(): Promise<HeadlessHost> {
  return createHeadlessHost({ console: silent, resolveFrom: ENGINE_ANCHOR });
}

/** The editor adapter: the editor's own options over the real engine. */
export async function editorAdapter(): Promise<HostUnderTest> {
  const hh = await engine();
  const editor = hh.host.editor;
  const opfs = fakeOpfs();
  const clipboard = fakeSystemClipboard();
  const restoreStorage = fakeLocalStorage();
  const restoreOpfs = opfs.install();
  const restoreClipboard = clipboard.install();

  const consent = createEditorConsentBackend();
  const secrets = createEditorSecretStore();
  const documents = createEditorDocuments();
  const settings = toolSettingsStore();
  const willSave = createWillSaveRegistry();
  resetProblems();
  const caret: EditorApp["caret"] = { current: null };
  const panelCalls: string[] = [];
  const entered: EditorApp["entered"] = [];
  const handle: EditorHandleForHost = {
    client: null,
    toolSettings: settings,
    contentSelection: { contentSelectionRef: caret },
  };
  const objects = createObjectRegistry({
    core: createCoreObjects(() => editor, { protocol: hh.protocolVersion }),
    log: silent,
  });
  const options = createEditorHostOptions({
    getEditor: () => handle,
    panels: {
      openPanel: (id) => void panelCalls.push(`open ${id}`),
      closeTab: (id) => void panelCalls.push(`close ${id}`),
    },
    enterEditContext: async (type, elementId) => {
      entered.push({ type, elementId });
      return true;
    },
    widgets: {
      CodeEditor: noComponent,
      ColorPicker: noComponent,
      PropertyField: noComponent,
      PropertyFrame: noComponent,
    } as unknown as NonNullable<CreateBundleHostOptions["widgets"]>,
    schemaPanelRenderer: noComponent as unknown as NonNullable<
      CreateBundleHostOptions["schemaPanelRenderer"]
    >,
    workerResolvers: {},
    moduleManifest: PROBE_MODULES,
    origin: "http://localhost:5180",
    consent: consent.backend,
    secrets: secrets.backend,
    documents: documents.backend,
    nativeDocument: createEditorNativeDocumentBackend(() => null),
    bindingProviders: createBindingProviderRegistry(),
    willSave,
    objects,
    diagnosticsSink: problemsSink,
  });
  const disposers: Array<() => void> = [];
  let lastProbe: (() => void) | null = null;
  const load = (manifest: PluginManifest): BundleHost => {
    const probe = probeBundle(manifest);
    const loaded = loadBundle(
      () => editor,
      probe.bundle,
      hostOptionsForPlugin(options.shared, manifest.id),
    );
    const dispose = () => loaded.dispose();
    disposers.push(dispose);
    if (manifest.id === PROBE_ID) lastProbe = dispose;
    return probe.host();
  };
  const host = load(probeManifest());
  return {
    name: "editor",
    host,
    editor,
    sibling: (m) => load(m ?? probeManifest(OTHER_ID)),
    withManifest: (m) => load(m),
    reactivate() {
      lastProbe?.();
      return load(probeManifest());
    },
    load: (idml) => hh.load(idml),
    newBlank: () => hh.newBlank(612, 792),
    editorApp: {
      options,
      consent,
      secrets,
      documents,
      willSave,
      problems: getProblemsSnapshot,
      panelCalls,
      entered,
      toolSettings: settings,
      caret,
      platform: { opfs, clipboard },
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
      hh.dispose();
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
