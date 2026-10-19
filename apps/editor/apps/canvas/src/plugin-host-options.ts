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

// The host options the editor hands EVERY bundle it loads: the second
// argument of `loadBundle(getEditor, bundle, options)` (plugin-sdk's
// `CreateBundleHostOptions`). The SDK's adapter turns them into the
// `BundleHost` a bundle's `activate` receives, so this object decides which
// doors are live in the editor and what answers them (`host.supports()`
// reads its keys).
//
// It is built here, out of the `PluginBundles` effect in main.tsx, so the
// BundleHost contract tests (test/contracts/bundle-host/) build the SAME
// object the editor builds: what the editor wires, and what the tests prove,
// cannot drift apart. main.tsx keeps everything that needs React or the
// browser's module graph (the widget components, the schema-panel renderer,
// the worker URLs Vite resolves, the module manifest) and passes it in.

import type {
  ClipboardBackend,
  ConsentBackend,
  BlobStore,
  BindingProviderBackend,
  BundleAssetProvider,
  CreateBundleHostOptions,
  DataProviderBackend,
  DiagnosticsSink,
  DocumentsBackend,
  ModulesBackend,
  NativeDocumentBackend,
  SecretStoreBackend,
  ShellBackend,
  TextCaretBackend,
  ToolSettingsBackend,
  WillSaveBackend,
  WorkerBackend,
} from "@paged-media/plugin-sdk";
import { createDataProviderRegistry } from "@paged-media/plugin-sdk";
import type { CanvasClient } from "@paged-media/client";

import { createHostConsole } from "./journal-sink";
import { createEditorAssetSource } from "./plugin-asset-source";
import { createEditorBlobStore } from "./plugin-blob-store";
import { createEditorClipboardBackend } from "./plugin-clipboard";
import {
  createEditorModulesBackend,
  type ModuleManifest,
} from "./plugin-modules";
import { pagesBackend, textRevealBackend } from "./plugin-pages";
import {
  createEditorWorkerBackend,
  type BundleWorkerModuleResolver,
} from "./plugin-worker";
import { pickFiles } from "./shell-file-picker";
import { saveFileBytes } from "./shell-file-saver";

/** The members of the live editor handle (`usePaged()`) the options read.
 *  Read through `getEditor()` on every call, never captured: the handle is
 *  replaced on every render. */
export interface EditorHandleForHost {
  client: CanvasClient | null;
  toolSettings: {
    get(toolId: string): Readonly<Record<string, number | boolean | string>>;
    subscribe(toolId: string, listener: () => void): () => void;
  };
  contentSelection: {
    contentSelectionRef: {
      current: {
        storyId: string;
        start: number;
        cell?: unknown;
      } | null;
    };
  };
}

/** What the editor app supplies; everything else is built here. */
export interface EditorHostOptionDeps {
  /** The live editor handle (main.tsx: `pagedRef.current`). */
  getEditor: () => EditorHandleForHost | null | undefined;
  /** The cockpit's panel placement (main.tsx: `cockpitActions`). */
  panels: {
    openPanel?: ((id: string) => void) | null;
    closeTab?: ((id: string) => void) | null;
  };
  /** The shell's edit-context entry by type, the one a double-click takes. */
  enterEditContext: NonNullable<ShellBackend["enterEditContext"]>;
  /** The file picker and saver; default the editor's own (a transient
   *  `<input type=file>`, an anchor download). */
  pickFile?: ShellBackend["pickFile"];
  saveFile?: NonNullable<ShellBackend["saveFile"]>;
  /** The host widgets (React components main.tsx owns). */
  widgets: NonNullable<CreateBundleHostOptions["widgets"]>;
  /** The host's schema-panel renderer (main.tsx's `HostSchemaPanelRenderer`). */
  schemaPanelRenderer: NonNullable<
    CreateBundleHostOptions["schemaPanelRenderer"]
  >;
  /** Bundle worker modules → served URLs (Vite's `?worker&url` imports). */
  workerResolvers: Record<string, BundleWorkerModuleResolver>;
  /** The build's module manifest (`virtual:paged-modules`) and the page origin. */
  moduleManifest: ModuleManifest;
  origin: string;
  /** The app-wide instances main.tsx shares with its dialogs and panels. */
  consent: ConsentBackend;
  secrets: SecretStoreBackend;
  documents: DocumentsBackend;
  nativeDocument: NativeDocumentBackend;
  bindingProviders: BindingProviderBackend;
  willSave: WillSaveBackend;
  objects: NonNullable<CreateBundleHostOptions["objects"]>;
  diagnosticsSink: DiagnosticsSink;
}

/** The shared host options plus the backends main.tsx also exposes as test
 *  affordances (`__textCaret`, `__modules`). */
export interface EditorHostOptions {
  shared: Omit<CreateBundleHostOptions, "console">;
  textCaret: TextCaretBackend;
  modules: ModulesBackend;
  assetSource: BundleAssetProvider;
  blobStore: BlobStore;
  clipboard: ClipboardBackend;
  workers: WorkerBackend;
  dataProviders: DataProviderBackend;
  toolSettings: ToolSettingsBackend;
}

/** Build the options every bundle host in the editor gets. */
export function createEditorHostOptions(
  deps: EditorHostOptionDeps,
): EditorHostOptions {
  const { getEditor } = deps;
  // Shell actions the host APP owns (the cockpit's panel placement) —
  // injected so the SDK's adapter stays a pure function over the editor
  // handle.
  const shell: ShellBackend = {
    openPanel: (id: string) => deps.panels.openPanel?.(id),
    closePanel: (id: string) => deps.panels.closeTab?.(id),
    // K-5 / S-11: the host file picker — a bundle gets the chosen files'
    // bytes (read at this boundary; no DOM File crosses the contract).
    pickFile: deps.pickFile ?? ((options) => pickFiles(options)),
    // K-10: the WRITE half of the file door — a bundle hands bytes + a
    // suggested name and the host delivers them through the same
    // anchor-download the Export Center uses for plugin exporters
    // (shell-file-saver.ts owns that mechanism). Answers false rather than
    // throwing when delivery fails. Flips supports("shell.saveFile@1") true.
    saveFile: deps.saveFile ?? ((options) => saveFileBytes(options)),
    // v66 — enter a bundle's own edit context without a double-click (an
    // "Adjust image" command, an importer that just placed one). The SDK
    // refuses a type the calling bundle did not register.
    enterEditContext: deps.enterEditContext,
  };
  // v66 — tool options a bundle declared are written by the host's
  // tool-options popover; `host.tools.settings` reads them back.
  const toolSettings: ToolSettingsBackend = {
    get: (toolId: string) => getEditor()?.toolSettings.get(toolId) ?? {},
    subscribe: (toolId: string, listener: () => void) =>
      getEditor()?.toolSettings.subscribe(toolId, listener) ?? (() => {}),
  };
  // W-06: the ASSET SOURCE that backs `host.assets.getFontFace`, served from
  // the engine's font registry over the requestFontFaceBytes wire pair;
  // since protocol 69 it also registers scene-layer faces (W-15), and the
  // SDK keys its list of live faces by this object, so it is ONE source for
  // every bundle.
  const assetSource = createEditorAssetSource(
    () => getEditor()?.client ?? null,
  );
  // K-4 / S-08: the OPFS-backed blob store behind host.blob.
  const blobStore = createEditorBlobStore();
  // K-6 / S-14: the system-clipboard backend behind host.clipboard (TSV
  // text/plain and a text/html <table> for a grid). The SDK door owns the
  // "full"/"vector"/"none" capability tiers.
  const clipboard = createEditorClipboardBackend();
  // C-9: the caret reader behind host.text.caret(). The caret lives in
  // EDITOR state, not the engine: this reads the LIVE content-selection ref
  // (the same state useTextEditing writes). Collapsed caret → its offset;
  // RANGE → its start (where a replace inserts); cell-qualified (table
  // cell) → null — cell-local offsets must not leak as story-local (the
  // documented v1 gap). The offset is the engine text-op convention
  // (`ContentSelection` story-local offsets, what `insertText.offset`
  // consumes).
  const textCaret: TextCaretBackend = {
    read: (): { storyId: string; offset: number } | null => {
      const sel =
        getEditor()?.contentSelection.contentSelectionRef.current ?? null;
      if (!sel || sel.cell) return null;
      return { storyId: sel.storyId, offset: sel.start };
    },
  };
  // K-3 / S-07 / I-02: the worker backend behind host.workers. The SDK door
  // owns the capability gate, the count cap, the SAB byte budget and
  // teardown; this resolves a bundle's DECLARED module path to a served URL
  // and constructs the Worker. A plugin id with no resolver (or an unknown
  // module path) rejects honestly.
  const workers = createEditorWorkerBackend(deps.workerResolvers);
  // ADR 223 / plugin-sdk ADR 326: the module door behind host.modules —
  // answered from the build's module manifest (the module host in a
  // deployed build, /@fs/ in dev, with sha384 for Subresource Integrity).
  const modules = createEditorModulesBackend(deps.moduleManifest, deps.origin);
  // D-09 (paged.data §7.1): ONE shared cross-plugin data-provider registry,
  // so a provider plugin (paged.data publishing a governed query) and a
  // consumer plugin (paged.sheet sourcing a sheet from it) rendezvous
  // through it — never by direct contact.
  const dataProviders = createDataProviderRegistry();

  const shared: Omit<CreateBundleHostOptions, "console"> = {
    shell,
    widgets: deps.widgets,
    // §12.8 — the PropertyField renders LIST and STRUCT values (`items` /
    // `fields`), editing through plugin-sdk `editValue`: flips
    // supports("widgets.propertyField.values@1") true.
    propertyFieldValues: true,
    toolSettings,
    willSave: deps.willSave,
    assetSource,
    blobStore,
    clipboard,
    textCaret,
    workers,
    // ADR 223 — the module door.
    modules,
    dataProviders,
    // ADR 023 phase A/C — the app's ONE binding-provider registry (host
    // panels read the same instance).
    bindingProviders: deps.bindingProviders,
    // ADR 323 — the ONE object registry (`./object-model.ts`): every
    // bundle's `contribute.objectModel` registers into it and its
    // `host.objects` routes across bundles. Flips supports("objects.shared@1").
    objects: deps.objects,
    // D-03 — the network-consent door (default-deny without it; the OUTER
    // wall is the CSP connect-src).
    consent: deps.consent,
    // D-11 — the reference-only credential store (set/exists/forget, NO get).
    secrets: deps.secrets,
    // ADR-022 Phase 3 — the whole-native-document door.
    nativeDocument: deps.nativeDocument,
    // D-26 — flips supports("documents.open@1") true.
    documents: deps.documents,
    // v70 — page navigation and the active page (`viewport.pages@1`).
    pages: pagesBackend,
    // Taking the user to a range of text — an outline entry, a find hit
    // (`viewport.revealText@1`).
    text: textRevealBackend,
    diagnosticsSink: deps.diagnosticsSink,
    schemaPanelRenderer: deps.schemaPanelRenderer,
    // W-19 — the shell's pointer entries (double-click, the Type-tool click
    // on owned content) hand the entering point to `onEnter`
    // (use-edit-context-entry.tsx), so this host vouches for
    // supports("editContext.enterPoint@1").
    editContextEnterPoint: true,
  };
  return {
    shared,
    textCaret,
    modules,
    assetSource,
    blobStore,
    clipboard,
    workers,
    dataProviders,
    toolSettings,
  };
}

/** ADR 025 §4a — identical doors for every bundle, but a PER-PLUGIN console
 *  so `host.log` is attributed at the source rather than parsed back out of
 *  the `[id]` prefix the SDK prints. The sink censuses (severity + a site
 *  hash), never mirrors, the text. */
export function hostOptionsForPlugin(
  shared: EditorHostOptions["shared"],
  pluginId: string,
): CreateBundleHostOptions {
  return { ...shared, console: createHostConsole(pluginId) };
}
