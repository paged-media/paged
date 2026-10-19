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

import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PagedShell,
  caretContribution,
  contentGrabberContribution,
  hitMarkerContribution,
  marqueeContribution,
  toolPreviewContribution,
  pluginOverlayLayersContribution,
  guideOverlayContribution,
  pageDecorationsContribution,
  pathEditContribution,
  resizeHandlesContribution,
  rotateHandleContribution,
  selectionChromeContribution,
  setCockpitPageNavigator,
  snapLinesContribution,
  tableCellOverlayContribution,
  threadingPortsContribution,
  threadLinesContribution,
  loadDocumentFile,
  fetchDefaultFont,
  fetchDefaultFontFaces,
  takePendingImportSource,
  useCamera,
  useCanvasClient,
  useContentSelection,
  useDocument,
  usePaged,
  useRegistries,
  useSelection,
  useEditContextStack,
  useEditContextEntry,
  SchemaPanelRenderer,
  CatalogRegistryProvider,
  type OverlayContribution,
  type PagedEditor,
  type ShellSchemaPanelRendererProps,
  writeToOpenFile,
  commitSave,
  setLibrary,
  setChromeStorageScope,
  ALWAYS_IN_PALETTE,
  AI_ASK_COMMAND,
  openAssistant,
  setAssistantOpener,
} from "@paged-media/shell";
import "@paged-media/shell/styles/globals.css";

import { CanvasClient, type DocumentHandle } from "@paged-media/client";
// Vite `?worker` import — constructs the render worker in THIS (app) module
// graph so Vite emits the worker chunk AND follows its transitive `?url` wasm
// import into a real `.wasm` asset. Passing only a worker URL across the
// @paged-media/client package boundary defeated Vite's static worker analysis:
// prod dist shipped a raw un-transpiled `worker.ts` and no wasm (audit D6/E8).
// See CanvasClientOptions for the full rationale.
import CanvasRenderWorker from "./worker/worker.ts?worker";
import LibraryWorker from "./library-worker.ts?worker";
import { connectLibrary } from "@paged-media/repository";
import { BUILT_IN_TOOLS } from "@paged-media/tools";
import {
  loadBundle,
  createBindingProviderRegistry,
} from "@paged-media/plugin-sdk";
import type { SchemaPanelRenderer as SchemaPanelRendererType } from "@paged-media/plugin-api";
import { errorIdent, identOf } from "@paged-media/client";
import {
  journal,
  installGlobalErrorCapture,
  exposeJournalForTests,
  setJournalDrainer,
  setDocumentShapeProvider,
  notePluginLoaded,
} from "./journal-sink";
import { createGuardedLoader } from "./plugin-load-guard";
import {
  editorObjectModel,
  objectRegistry,
  setObjectModelEditor,
} from "./object-model";
import {
  ALIGN_ARGS,
  ALIGN_COMMAND,
  runAlign,
  type AlignKind,
} from "./align-plan";
import {
  cameraCentredOn,
  cameraForPage,
  publishActivePage,
  setPageGoTo,
  setTextReveal,
} from "./plugin-pages";
import { resolveSoloProfile } from "./solo/profiles";
import { soloMode } from "./solo/mode";
// ADR 222 — the bundles are NOT imported here: each is a dynamic import()
// in the table, so each is its own chunk and none sits in the entry.
import { PLUGIN_BUNDLES } from "./plugin-bundle-table";
import {
  bootBundlesAreSettled,
  bootBundlesSettled,
  createBundleActivator,
  markBootBundlesSettled,
  type BundleActivator,
} from "./plugin-bundle-loader";
import {
  createEditorHostOptions,
  hostOptionsForPlugin,
} from "./plugin-host-options";
import moduleManifest from "virtual:paged-modules";
// K-3 — the paged.image decode worker module, resolved as a served URL
// through Vite's `?worker&url` (a bundled, COOP/COEP-served chunk). The
// editor maps the bundle's DECLARED module path ("workers/decode.js") to
// this URL; the bundle can spawn only what the editor knows it ships.
// @ts-ignore — `?worker&url` is a Vite affordance (string URL).
import imageDecodeWorkerUrl from "@paged-media/image/decode-worker?worker&url";
// The paged.draw Image Trace worker, the same way. The bundle asks
// `host.workers` for "workers/trace.js" (`TRACE_WORKER_MODULE`); without
// a resolver for ITS plugin id the spawn is refused by name and the
// trace falls back to the calling thread — the UI thread, for anything
// from a third of a second to most of a minute on a noisy photograph.
// @ts-ignore — `?worker&url` is a Vite affordance (string URL).
import drawTraceWorkerUrl from "@paged-media/draw/trace-worker?worker&url";
import { createEditorConsentBackend } from "./plugin-consent";
import { ConsentDialog } from "./ConsentDialog";
import { createEditorDocuments } from "./plugin-documents";
import { DocumentReplaceDialog } from "./DocumentReplaceDialog";
import { createEditorSecretStore } from "./plugin-secret-store";
import { SecretPromptDialog } from "./SecretPromptDialog";
import { CoreCommandDialog } from "./core-command-dialog";
import {
  GLOBAL_LIGHT_COMMANDS,
  GLOBAL_LIGHT_MENU_ITEMS,
  GlobalLightDialog,
} from "./panels/global-light-dialog";
import {
  buildCoreCommandEntries,
  CORE_COMMAND_MENU_ITEMS,
} from "./core-command-entries";
import { createEditorNativeDocumentBackend } from "./plugin-native-document";
import { pickFiles } from "./shell-file-picker";

// W3.1 — the schema-panel renderer the host injects. The shell renderer
// walks a `PanelSchema` through the catalog's `CompositionRenderer`,
// which needs the app's `CatalogRegistryProvider` in scope (the same
// provider the editor's own composition panels mount). Wrap it here at
// the app boundary (apps/canvas owns `appCatalogRegistry`).
function HostSchemaPanelRenderer(props: ShellSchemaPanelRendererProps) {
  return (
    <CatalogRegistryProvider registry={appCatalogRegistry()}>
      <SchemaPanelRenderer {...props} />
    </CatalogRegistryProvider>
  );
}

// Compat assertion (same discipline as plugin-api-compat.ts): the
// injected renderer must satisfy the plugin-api contract type. A drift
// on either side fails THIS typecheck at the injection seam, never a
// plugin author's build.
type _AssertSchemaRenderer =
  typeof HostSchemaPanelRenderer extends SchemaPanelRendererType ? true : never;
const _schemaRendererCompat: _AssertSchemaRenderer = true;
void _schemaRendererCompat;
import { CodeEditor } from "@paged-media/ui";
import { HostColorPicker } from "./plugin-color-picker";
import { ObjectPropertyField, ObjectPropertyFrame } from "@paged-media/shell";
import { createWillSaveRegistry } from "./plugin-will-save";
import { cockpitActions } from "@paged-media/shell";
import { assertCrossOriginIsolated } from "./boot/cross-origin-isolation-check";
import {
  APP_KEYBINDINGS,
  APP_MENU_ITEMS,
  buildAppCommands,
} from "./app-commands";
import {
  arrangeSelection,
  buildObjectCommands,
  deleteSelection,
  groupSelection,
  makeClippingMask,
  nudgeSelection,
  OBJECT_DIAGNOSTIC_SOURCE,
  OBJECT_KEYBINDINGS,
  OBJECT_MENU_ITEMS,
  releaseClippingMask,
  selectParentGroup,
  ungroupSelection,
  type ObjectCommandDeps,
} from "./object-commands";
import {
  addPage,
  buildInsertCommands,
  INSERT_DIAGNOSTIC_SOURCE,
  INSERT_KEYBINDINGS,
  INSERT_MENU_ITEMS,
  insertEllipse,
  insertLine,
  insertRectangle,
  insertTable,
  insertTextFrame,
  placeImage,
  pageTargetFor,
  type InsertReport,
  deleteCurrentPage,
} from "./insert-commands";
import { COCKPIT_MODES, PANEL_RAIL } from "./cockpit-modes";
import { COCKPIT_MENU_SEAMS } from "./cockpit-menus";
import { appCatalogRegistry } from "./panels/catalog-registry";
import { CanvasPanel } from "./panels/canvas-panel";
import { problemsSink } from "./panels/problems-store";
import { BUILT_IN_PANELS } from "./panels/built-in-panels";
import { PlaygroundController } from "./playground/PlaygroundController";
import { debugFlag } from "./debug-flags";
import { IframeScriptBridge } from "./playground/IframeScriptBridge";
import { useAnimatedCamera } from "./ui/useAnimatedCamera";
import { useKeyboardShortcuts } from "./ui/useKeyboardShortcuts";
import { documentBounds, fitCamera, layoutPages } from "./ui/layout";
import { usePathEditMode } from "./ui/usePathEditMode";
import { frameHoldingCaret, useTextEditing } from "./ui/useTextEditing";
import {
  SELECT_ALL_COMMAND,
  SELECT_ALL_KEYBINDINGS,
  SELECT_ALL_MENU_ITEM,
} from "./select-all";
import { CorpusPicker } from "./ui/CorpusPicker";

// Default overlay contributions for the canvas app. Order is
// descriptive — actual paint order is determined by the
// contributions' `z` values inside OverlayHost.
const BUILT_IN_OVERLAYS: OverlayContribution[] = [
  pageDecorationsContribution,
  // W2.8 — the INTERACTIVE guide overlay supersedes the read-only
  // `rulerGuidesContribution` in the editor: it seeds its mirror from
  // the same `DocumentHandle.rulerGuides` AND drives create/move/
  // delete. The static one stays in the shell barrel for the viewer.
  guideOverlayContribution,
  // The hit marker is a diagnostic of the hit-test path (a crosshair at
  // every click): `?debug=hits` only.
  ...(debugFlag("hits") ? [hitMarkerContribution] : []),
  selectionChromeContribution,
  resizeHandlesContribution,
  rotateHandleContribution,
  // W2.9 — text-frame threading ports on the selection chrome.
  threadingPortsContribution,
  // B4 — the story's route across the spread (View ▸ Show text
  // threads). Draws nothing and fetches nothing until toggled on.
  threadLinesContribution,
  // W3.A2 — selected table cell outline.
  tableCellOverlayContribution,
  contentGrabberContribution,
  pathEditContribution,
  marqueeContribution,
  // W-20 — plugins' retained overlay layers, just below the tool preview.
  pluginOverlayLayersContribution,
  toolPreviewContribution,
  snapLinesContribution,
  caretContribution,
];

/**
 * plugin-draw D3 — load first-party plugin bundles through the public
 * SDK surface (`@paged-media/plugin-sdk`). One `loadBundle` call per
 * bundle; the returned handle's dispose unregisters every
 * contribution (tools, activation commands, guarded shortcuts), so
 * removing this component removes the plugins cleanly — the
 * platform-honesty smoke test. Side-effect-only child of PagedShell
 * (the CanvasAppIntegration pattern). The thunk resolves the LIVE
 * editor handle per call (the command-registry idiom), so bundle
 * handlers never close over a stale snapshot.
 */

// D-03 — the editor's network-consent backend. One instance for the whole app:
// `PluginBundles` injects `backend` into every bundle host (the SDK door calls
// it), and `<ConsentDialog>` renders + resolves prompts from the same
// `controller`. Module scope so the two stay in sync across StrictMode remounts.
const editorConsent = createEditorConsentBackend();
if (!import.meta.env.PROD) {
  // Test affordance (mirrors `window.__canvas`): drive a synthetic prompt and
  // observe/resolve it without a network-declaring bundle (none exist yet).
  (globalThis as unknown as { __consent?: unknown }).__consent = {
    request: editorConsent.backend.request,
    current: () => editorConsent.controller.current(),
  };
}

// D-26 (ADR 219) — the plugin DOCUMENTS door (host.documents): serialize the
// open document and replace it with plugin-built bytes, asking keep/discard
// first when it has unsaved edits. One instance: `PluginBundles` attaches the
// live client + open orchestration and injects `backend` into every bundle
// host; `<DocumentReplaceDialog>` renders the prompt from `controller`.
const editorDocuments = createEditorDocuments();
if (!import.meta.env.PROD) {
  // Test affordance (the `__consent` pattern): drive the door without a
  // bundle that declares `capabilities.documents`. The requester is a fixed
  // test identity.
  (globalThis as unknown as { __documents?: unknown }).__documents = {
    exportPaged: () => editorDocuments.backend.exportPaged(),
    open: (bytes: Uint8Array, name?: string) =>
      editorDocuments.backend.open(bytes, {
        name: name ?? null,
        requester: { id: "media.paged.test", name: "Test plugin" },
      }),
    current: () => editorDocuments.controller.current(),
  };
}

// D-11 — the editor's reference credential store (host.secrets). One instance
// for the whole app: `PluginBundles` injects `backend` into every bundle host
// (the SDK door calls set/exists/forget), and `<SecretPromptDialog>` renders +
// resolves the "store this credential" prompt from the same `controller`.
// REFERENCE-ONLY: the value crosses the wire only host-ward at the attach door
// — a plugin never reads a secret back (the no-get trust line; the SDK surface
// has no get). Module scope so the two stay in sync across StrictMode remounts.
const editorSecrets = createEditorSecretStore();

// ADR 023 phase C — THE binding-provider registry. ONE per app, module
// scope, for the same two reasons `dataProviders` is shared: resolution
// is CROSS-BUNDLE (a host panel asks "who resolves `layers` right now?"
// without knowing which bundles exist), and the shell needs the SAME
// instance the bundle hosts were built with.
//
// It is handed to TWO places and they must be the same object:
//   · every `createBundleHost` call, as `bindingProviders` — that wires
//     `contribute.bindingProvider` AND makes the SDK adapter wrap each
//     edit context's own `onEnter`/`onExit`, which is where a provider's
//     lifetime comes from (borrowed from the shell's context stack, so
//     there is exactly one notion of "who is active");
//   · `<PagedShell bindingProviders>`, so host panels can read it.
const bindingProviders = createBindingProviderRegistry();
// v66 — `host.document.onWillSave`: ONE registry for every bundle; Save
// (.paged) runs it and waits (bounded) before it exports the container.
const willSave = createWillSaveRegistry();
if (!import.meta.env.PROD) {
  // Test affordance (the `__shellDoors` / `__consent` pattern): an e2e
  // spec can observe the ACTIVE provider stack — the thing the retarget
  // proof is actually about — without a bundle of its own.
  (
    globalThis as unknown as { __bindingProviders?: unknown }
  ).__bindingProviders = {
    active: () => bindingProviders.activeProviders(),
    readCollection: (collection: string) =>
      bindingProviders.readCollection({ collection: collection as never }),
  };
}
if (!import.meta.env.PROD) {
  // Test affordance: drive a synthetic set prompt + observe/resolve it, and
  // flip the persistence tier by setting a passphrase, without a
  // secrets-declaring bundle in the harness.
  (globalThis as unknown as { __secrets?: unknown }).__secrets = {
    set: editorSecrets.backend.set,
    exists: editorSecrets.backend.exists,
    forget: editorSecrets.backend.forget,
    current: () => editorSecrets.controller.current(),
    tier: () => editorSecrets.controller.tier(),
    setPassphrase: (p: string | null) =>
      editorSecrets.controller.setPassphrase(p),
  };
}

// ADR 222 — the activator of the mounted `PluginBundles` (StrictMode mounts
// it twice; only the live one may settle the boot lane or serve `ensure`).
let liveActivator: BundleActivator<{
  id: string;
  active: boolean;
  dispose(): void;
}> | null = null;

// Test affordance (the `__canvas` pattern): specs wait for `settled` before
// probing plugin contributions, and can force an on-demand bundle active.
// Module scope, so it exists before `__canvas.client` does — a spec can never
// observe a client without this beside it.
if (!import.meta.env.PROD || import.meta.env.MODE === "demo") {
  (globalThis as unknown as { __pluginBundles?: unknown }).__pluginBundles = {
    get settled() {
      return bootBundlesAreSettled();
    },
    ready: () => bootBundlesSettled(),
    active: () => liveActivator?.active() ?? [],
    ensure: async (id: string) => (await liveActivator?.ensure(id)) != null,
  };
}

function PluginBundles() {
  const paged = usePaged();
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  const registries = useRegistries();
  const registriesRef = useRef(registries);
  registriesRef.current = registries;
  // ADR 323 — the shared object registry's core seam reads this editor.
  setObjectModelEditor(paged);
  // Test affordance (like `__consent`/`__secrets`) — the aggregate
  // PagedEditor handle, i.e. the object the plugin-sdk host reads via
  // `getEditor()`. E2E specs probe the members capability flags gate
  // on (`text` → text.measure@1, `sceneLayers` → rendering.sceneLayer@1
  // and, from protocol 68, rendering.sceneLayer.faces@1).
  (globalThis as unknown as { __paged?: unknown }).__paged = paged;
  // The document context (setHandle + snapshot sinks) so a plugin importer that
  // opens a NEW document via host.nativeDocument.open activates it in the view,
  // exactly like File▸Open. Held in a ref — the mount-once effect below reads
  // the live setters (useState setters are stable across renders).
  const doc = useDocument();
  const docRef = useRef(doc);
  docRef.current = doc;
  // v66 — `host.shell.enterEditContext`: the same entry the double-click
  // takes, by type. Through a ref so the mount-once effect sees the live
  // hook (its closure tracks the registries and client).
  const { enterContextByType } = useEditContextEntry();
  const enterContextRef = useRef(enterContextByType);
  enterContextRef.current = enterContextByType;
  useEffect(() => {
    // Shell actions the host APP owns (the cockpit's panel
    // placement) — injected so the SDK's adapter stays a pure
    // function over the editor handle.
    // D-03 (paged.data §11): the network-consent door. Injecting `consent`
    // flips supports("network.consent@1") true and makes the per-origin gate
    // live; absent it the door denies every origin. The OUTER wall is the CSP
    // connect-src (vite.config.ts + _headers). Today every bundle declares
    // `network: false`, so the door is dormant but correctly wired for the
    // first bundle that asks (paged.data's remote adapter, M1).
    const consent = editorConsent.backend;
    // D-11 (rfc-credential-store): the reference-only credential store behind
    // host.secrets — lets a bundle (paged.data's authenticated DB-attach /
    // remote sources) have the host HOLD a credential by ref. set/exists/forget
    // only; NO get (secret bytes never return to the plugin; the host injects
    // them at the attach door). Injecting `secrets` flips supports("secrets@1")
    // true; the SDK door owns the capability gate + namespacing. The backing
    // tiers honestly: WebCrypto-wrapped IndexedDB with a user passphrase (the
    // weaker pure-web tier), else session-only in-memory (refs die with the
    // tab). `set` PROMPTS via <SecretPromptDialog> — "via host UI only".
    const secrets = editorSecrets.backend;
    // ADR-022 Phase 3: the whole-native-document door behind
    // host.nativeDocument — lets an import/export plugin (paged.publish, the
    // IDML adapter) read the core native parts (document.pgm / document.pgd)
    // and REPLACE the active document by loading native bytes it produced
    // (an importer's output), through the live engine client. Injecting it
    // flips supports("document.readNative@1"/"…openNative@1") true; the SDK
    // door owns the readNative/openNative capability gates. Absent it the
    // door answers honest null/[]/reject.
    // The full document-open orchestration (loadDocumentFile: load with the
    // default font, setHandle, snapshot) — the SAME flow File▸Open runs — so an
    // importer-opened native document actually renders. Mirrors PagedShell's
    // own drop handler; status/warnings go to the plugin's own log, so they no-op.
    const openBytes = async (bytes: Uint8Array, name: string) => {
      const client = pagedRef.current?.client;
      if (!client) return;
      const d = docRef.current;
      // U14 — `nativeDocument.open(bytes)` carries no file name, so the
      // backend hands a generic one ("Imported document"); the shell
      // parked the REAL picked/dropped file name when it dispatched the
      // import. Single-shot take: only an importer that actually opens
      // consumes it.
      const sourceFileName = takePendingImportSource() ?? name;
      // Copy into a fresh (non-shared) ArrayBuffer — the plugin bytes may be
      // SharedArrayBuffer-backed, which isn't a valid BlobPart.
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      await loadDocumentFile(client, new File([ab], sourceFileName), {
        setHandle: d.setHandle,
        setSourceName: d.setSourceName,
        setLoading: d.setLoading,
        setStatus: () => {},
        setSnapshotsReady: d.setSnapshotsReady,
        addSnapshot: (pageId, url) =>
          d.setSnapshots((prev) => {
            const next = new Map(prev);
            next.set(pageId, url);
            return next;
          }),
        resetForNewDocument: d.resetForNewDocument,
        pushWarning: () => {},
      });
    };
    const nativeDocument = createEditorNativeDocumentBackend(
      () => pagedRef.current?.client ?? null,
      openBytes,
    );
    // D-26 — the same File > Open orchestration for a plugin-built document,
    // but strict: it resolves the handle (the door answers its page ids) and
    // THROWS when the bytes do not load (loadDocumentFile reports a failure
    // through setStatus only). It never consumes the parked import name;
    // the name is the one the plugin asked for.
    const detachDocuments = editorDocuments.attach({
      getClient: () => pagedRef.current?.client ?? null,
      openBytes: async (bytes, name) => {
        const client = pagedRef.current?.client;
        if (!client)
          throw new Error("no engine client to open the document in");
        const d = docRef.current;
        let handle: DocumentHandle | null = null;
        let failure: string | null = null;
        const ab = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        // `.paged` is appended so the loader's extension strip leaves the
        // asked-for name whole ("Catalog v1.2" keeps its ".2").
        await loadDocumentFile(client, new File([ab], `${name}.paged`), {
          setHandle: (h) => {
            handle = h;
            d.setHandle(h);
          },
          setSourceName: d.setSourceName,
          setLoading: d.setLoading,
          setStatus: (status: string) => {
            if (status.startsWith("load failed")) failure = status;
          },
          setSnapshotsReady: d.setSnapshotsReady,
          addSnapshot: (pageId, url) =>
            d.setSnapshots((prev) => {
              const next = new Map(prev);
              next.set(pageId, url);
              return next;
            }),
          resetForNewDocument: d.resetForNewDocument,
          pushWarning: () => {},
        });
        if (failure || !handle)
          throw new Error(failure ?? "the document did not load");
        return handle;
      },
    });
    const documents = editorDocuments.backend;
    // The options every bundle host gets (`./plugin-host-options.ts`, where
    // the BundleHost contract tests build the same object).
    const hostOptions = createEditorHostOptions({
      getEditor: () => pagedRef.current,
      panels: cockpitActions,
      enterEditContext: (type, elementId) =>
        enterContextRef.current(type, elementId),
      widgets: {
        CodeEditor,
        ColorPicker: HostColorPicker,
        PropertyField: ObjectPropertyField,
        PropertyFrame: ObjectPropertyFrame,
      },
      schemaPanelRenderer: HostSchemaPanelRenderer as SchemaPanelRendererType,
      workerResolvers: {
        "media.paged.image": (module) =>
          module === "workers/decode.js" ? imageDecodeWorkerUrl : null,
        "media.paged.draw": (module) =>
          module === "workers/trace.js" ? drawTraceWorkerUrl : null,
      },
      moduleManifest,
      origin: window.location.origin,
      consent,
      secrets,
      documents,
      nativeDocument,
      bindingProviders,
      willSave,
      objects: objectRegistry,
      diagnosticsSink: problemsSink,
    });
    if (!import.meta.env.PROD) {
      // Test affordances (like `__consent`/`__secrets`): e2e asserts the
      // injected caret reader's shape without a caret-consuming bundle, and
      // reads the module door's answers directly.
      (globalThis as unknown as { __textCaret?: unknown }).__textCaret =
        hostOptions.textCaret;
      (globalThis as unknown as { __modules?: unknown }).__modules = {
        backend: hostOptions.modules,
        manifest: moduleManifest,
      };
    }
    const hostOptionsFor = (pluginId: string) =>
      hostOptionsForPlugin(hostOptions.shared, pluginId);
    // One bundle's activation failure must not take the seven after it down.
    // The guard lives in `plugin-load-guard.ts` so its FAILURE path is
    // unit-testable without a browser.
    const loadGuarded = createGuardedLoader({
      load: (bundle: Parameters<typeof loadBundle>[1]) =>
        loadBundle(
          () => pagedRef.current,
          bundle,
          hostOptionsFor(bundle.manifest.id),
        ),
      record: (entry) => journal.record(entry),
      notePlugin: notePluginLoaded,
      publishProblem: (bundleId, key, diagnostics) =>
        problemsSink.publish(bundleId, key, diagnostics),
    });
    // Test affordance (the `__overlaySignals` pattern): the shell doors the
    // host app injects, reachable so an E2E spec can drive them as a bundle
    // would. Dev-only — stripped in PROD.
    const isProd =
      (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD ===
      true;
    if (!isProd) {
      (globalThis as unknown as { __shellDoors?: unknown }).__shellDoors =
        hostOptions.shared.shell;
      // v66 — the will-save registry, so a spec can register a listener
      // as a bundle would and see Save wait for it.
      (globalThis as unknown as { __willSave?: unknown }).__willSave = willSave;
      // Load a throwaway bundle through the SAME loader and host options
      // every real bundle gets, so a journey can exercise a plugin door
      // end to end (SDK host → shell) without a published plugin that
      // happens to use it. Returns the disposer.
      (
        globalThis as unknown as { __loadTestBundle?: unknown }
      ).__loadTestBundle = (bundle: Parameters<typeof loadBundle>[1]) =>
        loadBundle(
          () => pagedRef.current,
          bundle,
          hostOptionsFor(bundle.manifest.id),
        );
    }
    // Solo loads ONE bundle. Filtering here (rather than after
    // registration) means the other seven never activate at all, so
    // their panels, tools, menus, importers and edit contexts are never
    // registered and nothing has to un-register them — and, since the
    // bundles are dynamic imports (ADR 222), their chunks are never
    // fetched either.
    const activator = createBundleActivator({
      entries: SOLO
        ? PLUGIN_BUNDLES.filter((e) => e.id === SOLO.bundleId).map((e) => ({
            ...e,
            lane: "boot" as const,
          }))
        : PLUGIN_BUNDLES,
      activate: loadGuarded,
      record: (entry) => journal.record(entry),
      publishProblem: (bundleId, key, diagnostics) =>
        problemsSink.publish(bundleId, key, diagnostics),
      importers: registriesRef.current.importers,
    });
    liveActivator = activator;
    // Non-blocking: the shell is already mounted and painting. Document
    // loads wait for this (the gated client in CanvasAppRoot).
    void activator.boot().then(() => {
      if (liveActivator === activator) markBootBundlesSettled();
    });
    return () => {
      activator.dispose();
      if (liveActivator === activator) liveActivator = null;
      detachDocuments();
      delete (globalThis as unknown as { __shellDoors?: unknown }).__shellDoors;
      delete (globalThis as unknown as { __loadTestBundle?: unknown })
        .__loadTestBundle;
    };
    // Mount-once by design; the ref keeps the handle live.
  }, []);
  return null;
}

/**
 * Canvas-app integration: legacy keyboard + camera + text-editing
 * hooks that read from the shell contexts but key off canvas
 * specifics (page rect math, IDML mutation API). Renders nothing —
 * mounted inside PagedShell as a side-effect-only child.
 */
/** File-command failures the user must see.
 *
 *  Save and export both end in a browser download, so "nothing happened"
 *  is indistinguishable from "it went to your Downloads folder" — and
 *  there is no autosave behind either. A console.error is invisible to
 *  the person who just lost the save. Routes to the same Problems
 *  channel the insert refusals use, and keeps the console line for a
 *  developer reading a trace. */
const FILE_DIAGNOSTIC_SOURCE = "paged.file";
function reportFileFailure(what: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  problemsSink.publish(FILE_DIAGNOSTIC_SOURCE, "file", [
    {
      severity: "error",
      message: `${what} failed — ${message}`,
      source: "file",
    },
  ]);
  // eslint-disable-next-line no-console
  console.error(`${what} failed:`, err);
}

function CanvasAppIntegration() {
  const client = useCanvasClient();
  const { camera, setCamera, viewportSize } = useCamera();
  const { handle, sourceName } = useDocument();
  const { contentSelection, setContentSelection } = useContentSelection();
  const registries = useRegistries();
  // ADR 025 — THE COMMAND TAP. `commands.observe` is the one place a command
  // handler is ever called, so this single subscription sees every menu item,
  // keybinding, palette entry, tool activation, panel toggle and plugin
  // command — including ones registered after we subscribed.
  //
  // What it CANNOT see is not a mystery: `shell/src/actions/model.ts` already
  // enumerates it (canvas gestures over the SAB, typing, panel field edits,
  // selection, camera), and the journal DECLARES the same gaps in
  // KNOWN_BLIND_SPOTS rather than letting silence read as calm.
  useEffect(() => {
    const startedAt = new Map<number, number>();
    const off = registries.commands.observe((event) => {
      if (event.phase === "started") {
        startedAt.set(event.invocation.seq, performance.now());
        return;
      }
      const t0 = startedAt.get(event.invocation.seq);
      startedAt.delete(event.invocation.seq);
      journal.record({
        code: "shell.command",
        severity: event.error ? "error" : "info",
        corr: event.invocation.seq,
        durMs: t0 === undefined ? undefined : performance.now() - t0,
        data: {
          // Command ids are code-authored constants, but many are camelCase —
          // `identOf` normalises rather than widening the identifier rule
          // (which would start admitting font families).
          id: identOf(event.invocation.id) ?? "unknown",
          ok: !event.error,
          ...(event.error ? { error: errorIdent(event.error) } : {}),
        },
      });
    });
    return () => off.dispose();
  }, [registries]);
  // ADR 025 — hand the sink a way to drain the render worker's ring. The
  // worker keeps its OWN buffer (different realm); it is pulled on demand
  // rather than streamed, so the render loop pays one array push instead of
  // a structured clone per frame.
  useEffect(() => {
    setJournalDrainer(() => client.drainJournal());
    return () => setJournalDrainer(null);
  }, [client]);
  // ADR 025 — the opt-in `documentShape` export section. The engine's
  // `DocumentStats` is already pure counts, so this carries structure and no
  // content. A PROVIDER, not a snapshot: the dialog must show the document
  // open at EXPORT time, not whatever was open when the panel mounted.
  useEffect(() => {
    setDocumentShapeProvider(() => {
      const stats = handle?.stats;
      if (!stats) return undefined;
      return {
        spreads: stats.spreads,
        pages: stats.pages,
        frames: stats.frames,
        stories: stats.stories,
        paragraphs: stats.paragraphs,
        lines: stats.lines,
        glyphs: stats.glyphs,
        oversetStories: stats.overset_stories,
      };
    });
    return () => setDocumentShapeProvider(null);
  }, [handle]);
  // ADR-012 Tier 1 — the MENU path of the undo routing (the controller
  // owns the keyboard chords): while a modal context declares undo
  // ownership, Edit/Undo + Edit/Redo drive ITS op-log, not the document
  // stack. A ref so the command closures (registered once per effect
  // run) always see the live stack without re-registering per enter/exit.
  const editContextStack = useEditContextStack();
  const editContextRef = useRef(editContextStack);
  editContextRef.current = editContextStack;
  // `paged.object.*` reads the LIVE element selection. Through a ref
  // for the same reason the edit-context stack is: the command effect
  // must not re-register on every click.
  const selection = useSelection();
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const animateCamera = useAnimatedCamera(camera, setCamera);
  useKeyboardShortcuts({
    pageIds: handle?.pageIds ?? [],
    pageSizesPt: handle?.pageSizesPt ?? [],
    camera,
    viewportSize,
    animateCamera,
  });
  useTextEditing({
    client,
    selection: contentSelection,
    setSelection: setContentSelection,
    undoOwnedByContext: () =>
      !!editContextRef.current?.activeContribution?.onUndo,
    escapeOwnedByContext: () => !!editContextRef.current?.active,
    // ED-1 — Escape out of the text is InDesign's: the frame that held
    // the caret becomes the selection and the Selection tool is in hand,
    // so the next key is a shortcut again rather than more text.
    onLeaveText: (left) => {
      selectionRef.current.setActiveTool("select");
      void (async () => {
        const frameId = await frameHoldingCaret(client, left);
        if (!frameId) return;
        const applied = await client.setElementSelection(
          [{ kind: "textFrame", id: frameId }],
          "replace",
        );
        selectionRef.current.setElementSelection(applied);
        selectionRef.current.setElementGeometry(
          await client.elementGeometry(applied),
        );
      })().catch(() => {
        /* worker reload / disconnect — the caret is gone either way */
      });
    },
  });
  usePathEditMode();

  // Tell the client which page the user is on, so plugins can ask.
  //
  // `host.document.meta().activePage` is how every first-party bundle
  // picks the page it mints into — paged.web, paged.data, paged.doc,
  // paged.draw and paged.sheet all read it and fall back to `pages[0]`.
  // The ENGINE always answers null (it does not track application
  // state and says so), and nothing here folded the answer back in, so
  // that fallback was the only branch: on a multi-page document every
  // plugin dropped its work onto page 1 regardless of where the user
  // was looking. `MoveNode`'s reparenting is deliberately off the wire,
  // so it could not even be corrected afterwards.
  //
  // The page is the one `paged.insert.*` already targets — viewport
  // centre, then the containing page, then the nearest — so the host's
  // own insert verbs and a plugin's insert now agree about "here",
  // which is the property that was actually missing.
  useEffect(() => {
    const target = pageTargetFor({ handle, camera, viewportSize });
    client.setActivePage(target?.pageId ?? null);
    // v70 — the same page, for `host.viewport.activePage` and its event.
    publishActivePage(target?.pageId ?? null);
  }, [client, handle, camera, viewportSize]);

  // `host.viewport.revealText`: the camera onto where the range is laid
  // out (its first line, at the current zoom or a readable one), then —
  // unless the plugin asked not to — the range as the text selection.
  useEffect(() => {
    setTextReveal(async (range, select) => {
      if (!handle) return false;
      const sel = {
        storyId: range.storyId,
        start: range.start,
        end: range.end,
      };
      let at: { pageId: string; xPt: number; yPt: number } | null = null;
      try {
        if (range.end > range.start) {
          const rects = await client.selectionGeometry(sel);
          const first = rects[0];
          if (first) {
            at = {
              pageId: String(first.pageId),
              xPt: first.leftPt + Math.min(first.widthPt, 120) / 2,
              yPt: first.topPt + first.heightPt / 2,
            };
          }
        }
        if (!at) {
          const caret = await client.caretGeometry(sel);
          if (caret) {
            at = {
              pageId: String(caret.pageId),
              xPt: caret.xPt,
              yPt: caret.topPt + caret.heightPt / 2,
            };
          }
        }
      } catch {
        return false; // unknown story, or a range the engine refuses
      }
      if (!at) return false; // not laid out (overset)
      const index = handle.pageIds.indexOf(at.pageId as never);
      const [vw, vh] = viewportSize;
      // Keep the user's zoom unless it is too small to read text at.
      const scale = Math.max(camera.scale, 0.6);
      const cam = cameraCentredOn(
        handle.pageSizesPt,
        index,
        at.xPt,
        at.yPt,
        scale,
        vw,
        vh,
      );
      if (!cam) return false;
      animateCamera(cam);
      if (select) setContentSelection(sel);
      return true;
    });
    return () => setTextReveal(null);
  }, [
    animateCamera,
    camera.scale,
    client,
    handle,
    setContentSelection,
    viewportSize,
  ]);

  // v70 — `host.viewport.goToPage`: the page by id, fitted whole or by
  // width, with the navigator's animation.
  //
  // A plugin calls this straight after the mutation that made or moved the
  // page, before React has re-rendered with the new handle. The closure's
  // handle then holds the page at its OLD index (paged.slide's new slide
  // sat after its template page, not where it was moved), and the camera
  // went to whatever page now occupies that slot. So the order is taken
  // from the engine, and the camera waits for the handle that agrees.
  const pageHandleRef = useRef(handle);
  pageHandleRef.current = handle;
  useEffect(() => {
    setPageGoTo(async (pageId, fit) => {
      let order: string[];
      try {
        order = (await client.collection<{ selfId: string }>("pages")).map(
          (p) => p.selfId,
        );
      } catch {
        return false;
      }
      if (!order.includes(pageId)) return false;
      const settled = () => {
        const h = pageHandleRef.current;
        return h &&
          h.pageIds.length === order.length &&
          h.pageIds.every((id, i) => id === order[i])
          ? h
          : null;
      };
      let h = settled();
      for (let waited = 0; !h && waited < 2000; waited += 16) {
        await new Promise((r) => setTimeout(r, 16));
        h = settled();
      }
      if (!h) return false;
      const [vw, vh] = viewportSize;
      const cam = cameraForPage(
        h.pageSizesPt,
        h.pageIds.indexOf(pageId as never),
        fit,
        vw,
        vh,
      );
      if (!cam) return false;
      animateCamera(cam);
      return true;
    });
    return () => setPageGoTo(null);
  }, [animateCamera, client, viewportSize]);

  // Cockpit — the thumbnail filmstrip / document map navigate by
  // page indices; the camera-fit math (page layout convention) is
  // app-side, registered with the shell's navigation hand-off.
  useEffect(() => {
    setCockpitPageNavigator((pageIndices) => {
      const pageSizes = handle?.pageSizesPt ?? [];
      if (pageSizes.length === 0 || pageIndices.length === 0) return;
      const rects = layoutPages(pageSizes);
      // `layoutPages` stacks ALL pages vertically (spreads are not
      // side-by-side), so fitting the union rect of a multi-page
      // spread lands the camera on the inter-page GAP. Fit the
      // spread's FIRST page instead; a spread-aware `layoutPages`
      // (pages of one spread side by side) is the structural fix
      // (follow-up).
      const target = rects[pageIndices[0]];
      if (!target) return;
      const [vw, vh] = viewportSize;
      animateCamera(fitCamera(vw, vh, target));
    });
    return () => setCockpitPageNavigator(null);
  }, [animateCamera, handle, viewportSize]);

  // SDK Phase 4 — register canvas-app commands + menu items +
  // keybindings. Closures capture the *current* camera / handle /
  // viewportSize so the zoom commands see live values; dependency
  // array re-runs on each change. The registries' dedupe-by-id
  // contract means re-registration is safe (the dispose from the
  // previous run drops the stale handler before we add the new one).
  useEffect(() => {
    const [vw, vh] = viewportSize;
    const pageSizes = handle?.pageSizesPt ?? [];
    const rects = layoutPages(pageSizes);
    const commands = buildAppCommands({
      undo: () => {
        const owner = editContextRef.current.activeContribution;
        if (owner?.onUndo) {
          owner.onUndo();
          return;
        }
        void client.undo();
      },
      redo: () => {
        const owner = editContextRef.current.activeContribution;
        if (owner?.onUndo) {
          owner.onRedo?.();
          return;
        }
        void client.redo();
      },
      // File ▸ Open PDF… — pick a `.pdf` and route it to the paged.pdf
      // importer (pdf.js reconstruction → host.nativeDocument.open). The
      // menu-driven counterpart to drag-drop; resolves the importer by the
      // file's extension, so it degrades quietly if the plugin isn't loaded.
      openPdf: async () => {
        const [file] = await pickFiles({ accept: [".pdf", "application/pdf"] });
        if (!file) return;
        const importer = registries.importers.resolve(file.name);
        if (!importer) return;
        await importer.import({
          name: file.name,
          bytes: file.bytes,
          mimeType: "application/pdf",
        });
      },
      // W3.B2 — Save As IDML: serialise the loaded document to an
      // `.idml` package and trigger a browser download (mirrors the
      // PDF export's Blob → object-URL → anchor-click pattern). The
      // filename comes from the document meta; bail quietly when no
      // document is open.
      saveAsIdml: async () => {
        if (!handle || handle.pageCount === 0) return;
        try {
          const bytes = await client.exportIdml();
          // U14 — same identity preference as the doc title bar:
          // meta.documentName, else the loaded file's name.
          let baseName = sourceName || "document";
          try {
            const meta = await client.documentMeta();
            if (meta.documentName) baseName = meta.documentName;
          } catch {
            /* meta unavailable — keep the fallback name */
          }
          const blob = new Blob([bytes.slice()], {
            type: "application/vnd.adobe.indesign-idml-package",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${baseName.replace(/\.idml$/i, "")}.idml`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          reportFileFailure("Save As IDML", err);
        }
      },
      // Save (.paged) — the native container. Same download shape as
      // Save As IDML, and deliberately so: the bytes ARE an IDML
      // package, with `manifest.json`, `paged/core/model/document.pgm`
      // and the loaded bundles' `paged/<plugin>/…` parts appended. The
      // difference that matters to a user is what survives a reopen —
      // a sheet's workbook, a web frame's source, a Word file's
      // original OPC — none of which an IDML export can carry.
      savePaged: async () => {
        if (!handle || handle.pageCount === 0) return;
        try {
          // v66 — plugins with an edit session outside the document
          // commit it first (bounded; a stuck one is reported, not
          // waited on forever), so the file holds what is on screen.
          const prepared = await willSave.run({ format: "paged" });
          for (const id of [...prepared.failed, ...prepared.timedOut]) {
            console.warn(
              `Save (.paged): ${id} did not finish preparing (` +
                `${prepared.failed.includes(id) ? "threw" : "timed out"}); ` +
                `saving its last committed state`,
            );
          }
          const bytes = await client.exportPaged();
          // What the bytes hold: an edit landing while they are written
          // out is not part of this save.
          const savedMark = client.editMark;
          let baseName = sourceName || "document";
          try {
            const meta = await client.documentMeta();
            if (meta.documentName) baseName = meta.documentName;
          } catch {
            /* meta unavailable — keep the fallback name */
          }
          // ADR 180 — the save is a commit in the local library, alongside
          // (never instead of) the file write below. A library failure is
          // reported and the file still gets written.
          try {
            await commitSave(bytes.slice(), baseName);
          } catch (err) {
            console.warn(
              "Save (.paged): the library did not take this save:",
              err,
            );
          }
          // A5 — write BACK to the file the document was opened from,
          // when there is one. Until now every save minted a download,
          // so a second Cmd+S produced "document (1).paged" and the file
          // the user opened was never touched: a save-AS wearing the
          // word Save, with no autosave behind it.
          //
          // Falls back to the download whenever the write cannot happen
          // — no handle, no platform support, a declined permission
          // prompt, a moved file.  returns false rather
          // than throwing for exactly that reason: a save that did not
          // happen must not look like one that did.
          //
          // ED-4 — either way the document is saved, so the edited flag
          // clears (until the next edit). Until now nothing cleared it:
          // after a save the next Open still warned of unsaved edits.
          if (await writeToOpenFile(bytes, "application/x-paged+zip")) {
            client.markSaved(savedMark);
            return;
          }
          const blob = new Blob([bytes.slice()], {
            type: "application/x-paged+zip",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${baseName.replace(/\.(paged|idml)$/i, "")}.paged`;
          a.click();
          URL.revokeObjectURL(url);
          client.markSaved(savedMark);
        } catch (err) {
          // A failed save that reaches only the devtools console is a
          // failed save the user believes succeeded — and with no
          // autosave behind it, believing wrongly is how work is lost.
          reportFileFailure("Save (.paged)", err);
        }
      },
      zoomIn: () => {
        const cx = vw / 2;
        const cy = vh / 2;
        const docX = (cx - camera.tx) / camera.scale;
        const docY = (cy - camera.ty) / camera.scale;
        const newScale = camera.scale * 1.5;
        animateCamera({
          scale: newScale,
          tx: cx - docX * newScale,
          ty: cy - docY * newScale,
        });
      },
      zoomOut: () => {
        const cx = vw / 2;
        const cy = vh / 2;
        const docX = (cx - camera.tx) / camera.scale;
        const docY = (cy - camera.ty) / camera.scale;
        const newScale = camera.scale / 1.5;
        animateCamera({
          scale: newScale,
          tx: cx - docX * newScale,
          ty: cy - docY * newScale,
        });
      },
      zoom100: () => {
        const cx = vw / 2;
        const cy = vh / 2;
        const docX = (cx - camera.tx) / camera.scale;
        const docY = (cy - camera.ty) / camera.scale;
        animateCamera({ scale: 1, tx: cx - docX, ty: cy - docY });
      },
      zoomFit: () => {
        if (rects.length === 0) return;
        animateCamera(fitCamera(vw, vh, documentBounds(rects)));
      },
    });
    // `paged.object.*` — the object verbs (Arrange ×4, Group, Ungroup,
    // Select parent group, Delete, Nudge ×8, Make / Release clipping
    // mask). The deps bag is the ONLY
    // place the module touches the app: the live selection through the
    // ref, the worker-first selection write the overlays key on, and a
    // report channel that lands in the Problems panel rather than the
    // console.
    const objectDeps: ObjectCommandDeps = {
      client,
      getSelection: () => selectionRef.current.elementSelection,
      // ADR 024 — read through the SAME ref the undo routing uses, so
      // the two cannot disagree about which context is active.
      activeEditContext: () => editContextRef.current.active,
      setSelection: async (ids) => {
        const applied = await client.setElementSelection(ids, "replace");
        selectionRef.current.setElementSelection(applied);
        try {
          selectionRef.current.setElementGeometry(
            await client.elementGeometry(applied),
          );
        } catch {
          /* geometry is selection CHROME — its absence never blocks the edit. */
        }
      },
      // A nudge moves what is selected without changing WHAT is
      // selected, so it re-reads the ids the chrome is already drawn
      // from — for a selected group those are its leaves, which the
      // group id itself could not be asked for.
      refreshSelectionGeometry: async () => {
        const selected = selectionRef.current.elementSelection;
        const shown = selectionRef.current.elementGeometry.map((g) => g.id);
        const ids = shown.length > 0 ? shown : selected;
        if (ids.length === 0) return;
        const items = await client.elementGeometry(ids);
        // The selection moved on while the engine answered: the path
        // that changed it fetched its own geometry, and this answer is
        // for something no longer on screen.
        if (selectionRef.current.elementSelection !== selected) return;
        selectionRef.current.setElementGeometry(items);
      },
      report: (severity, message) =>
        problemsSink.publish(OBJECT_DIAGNOSTIC_SOURCE, "object", [
          { severity, message, source: "object" },
        ]),
    };
    // Every object verb starts from a clean slate, so the panel shows
    // the LAST invocation's outcome and never a stale one.
    const fresh = (run: () => Promise<void>) => async () => {
      problemsSink.clear(OBJECT_DIAGNOSTIC_SOURCE);
      await run();
    };
    const objectCommands = buildObjectCommands({
      bringToFront: fresh(() => arrangeSelection(objectDeps, "front")),
      bringForward: fresh(() => arrangeSelection(objectDeps, "forward")),
      sendBackward: fresh(() => arrangeSelection(objectDeps, "backward")),
      sendToBack: fresh(() => arrangeSelection(objectDeps, "back")),
      group: fresh(() => groupSelection(objectDeps)),
      ungroup: fresh(() => ungroupSelection(objectDeps)),
      selectParentGroup: fresh(() => selectParentGroup(objectDeps)),
      delete: fresh(() => deleteSelection(objectDeps)),
      nudge: (direction, large) =>
        fresh(() => nudgeSelection(objectDeps, direction, large))(),
      makeClippingMask: fresh(() => makeClippingMask(objectDeps)),
      releaseClippingMask: fresh(() => releaseClippingMask(objectDeps)),
    });
    // `paged.insert.*` — the object-authoring verbs (U7). Unlike the
    // object layer's deps bag, every runner reads its state (camera,
    // page layout, caret, edit context) off the LIVE `PagedEditor` the
    // command registry materialises at invoke time — nothing here is
    // captured, so the effect's re-run cadence cannot stale a
    // placement. Same Problems-panel report channel + clean-slate
    // discipline as `paged.object.*`.
    const insertReport: InsertReport = (severity, message) =>
      problemsSink.publish(INSERT_DIAGNOSTIC_SOURCE, "insert", [
        { severity, message, source: "insert" },
      ]);
    const freshInsert =
      (run: (paged: PagedEditor) => Promise<unknown>) =>
      async (paged: PagedEditor) => {
        problemsSink.clear(INSERT_DIAGNOSTIC_SOURCE);
        return run(paged);
      };
    const insertCommands = buildInsertCommands({
      deletePage: freshInsert((p) => deleteCurrentPage(p, insertReport)),
      textFrame: freshInsert((p) => insertTextFrame(p, insertReport)),
      rectangle: freshInsert((p) => insertRectangle(p, insertReport)),
      ellipse: freshInsert((p) => insertEllipse(p, insertReport)),
      line: freshInsert((p) => insertLine(p, insertReport)),
      table: freshInsert((p) => insertTable(p, insertReport)),
      // IMG-2 — Place's errors (a file it cannot read) are reported where
      // the user sees them, not only into a panel nobody has open.
      placeImage: freshInsert((p) =>
        placeImage(p, (severity, message) => {
          insertReport(severity, message);
          if (severity === "error") {
            void registries.commands.invoke("paged.panel.show.paged.problems");
          }
        }),
      ),
      newPage: freshInsert((p) => addPage(p, insertReport)),
    });
    // ADR 323 — Align / Distribute as a TYPED command over
    // `host.objects` (align-plan.ts): declared args, one batch = one undo.
    const alignCommands = [
      {
        id: ALIGN_COMMAND,
        title: "Align objects",
        category: "Object",
        args: ALIGN_ARGS,
        handler: (_paged: unknown, payload?: unknown) =>
          runAlign(
            objectRegistry,
            payload as { kind: AlignKind; targets: string[] },
          ),
      },
    ];
    // ADR 221 — every Claude entry point opens the AI Assistant panel;
    // the palette's "Ask Claude" row also runs the request there.
    setAssistantOpener(
      () =>
        void registries.commands.invoke("paged.panel.show.paged.ai-assistant"),
    );
    const aiCommands = [
      {
        id: AI_ASK_COMMAND,
        title: "Ask Claude",
        category: "Assistant",
        args: { kind: "text" } as const,
        handler: (_paged: unknown, payload?: unknown) => {
          openAssistant({
            view: "ask",
            draft: String(payload ?? ""),
            autoRun: true,
          });
        },
      },
    ];
    const cmdDisposables = [
      ...commands,
      ...aiCommands,
      ...objectCommands,
      ...insertCommands,
      ...alignCommands,
      ...GLOBAL_LIGHT_COMMANDS,
      SELECT_ALL_COMMAND,
      // ADR 323 §4 — the typed core commands' menu / palette doors.
      ...buildCoreCommandEntries(),
    ].map((c) => registries.commands.register(c));
    const menuDisposables = [
      ...APP_MENU_ITEMS,
      SELECT_ALL_MENU_ITEM,
      ...OBJECT_MENU_ITEMS,
      ...INSERT_MENU_ITEMS,
      ...CORE_COMMAND_MENU_ITEMS,
      ...GLOBAL_LIGHT_MENU_ITEMS,
      ...COCKPIT_MENU_SEAMS,
    ]
      // Solo keeps only the host menus its profile names. Whole-menu
      // removal falls out of this for free: MenuBar builds a top-level
      // menu only if at least one item carries that first path segment,
      // so dropping every `Layout/…` item removes the Layout menu — no
      // per-menu predicate needed, and none exists.
      .filter((m) => SOLO_SURFACES?.keepMenu(m) ?? true)
      .map((m) => registries.menus.register(m));
    const keyDisposables = [
      ...APP_KEYBINDINGS,
      ...SELECT_ALL_KEYBINDINGS,
      ...OBJECT_KEYBINDINGS,
      ...INSERT_KEYBINDINGS,
    ].map((k) => registries.keybindings.register(k));
    return () => {
      for (const d of cmdDisposables) d.dispose();
      for (const d of menuDisposables) d.dispose();
      for (const d of keyDisposables) d.dispose();
    };
  }, [
    registries,
    client,
    camera,
    viewportSize,
    handle,
    sourceName,
    animateCamera,
  ]);

  return null;
}

/**
 * ADR 222 — no document opens before the boot plugin bundles are active.
 *
 * The bundles are fetched after the shell mounts, so without this a fast
 * open (a test's direct `client.loadDocument`, a site-bridge document, the
 * solo boot artboard) could reach the worker before a bundle subscribed to
 * `document.onDidOpen` — and that bundle's container parts (a workbook, a
 * data session, draw recipes) would not be restored for the first document.
 * Every load path (File ▸ Open, importers via nativeDocument.open, File ▸
 * New, scripts) goes through these two methods, so this is the one gate.
 * The chunks download in parallel with the worker's wasm boot, so in
 * practice the wait is already over by the time a document is asked for.
 */
class GatedCanvasClient extends CanvasClient {
  override async loadDocument(
    ...args: Parameters<CanvasClient["loadDocument"]>
  ): ReturnType<CanvasClient["loadDocument"]> {
    await bootBundlesSettled();
    return super.loadDocument(...args);
  }

  override async newBlankDocument(
    ...args: Parameters<CanvasClient["newBlankDocument"]>
  ): ReturnType<CanvasClient["newBlankDocument"]> {
    await bootBundlesSettled();
    return super.newBlankDocument(...args);
  }
}

/**
 * Root: owns the CanvasClient lifecycle and hands it to PagedShell.
 */
function CanvasAppRoot() {
  const [client, setClient] = useState<CanvasClient | null>(null);

  useEffect(() => {
    // SDK Phase 1 — `@paged-media/client` is framework-agnostic, so the
    // Worker is constructed HERE in the app's module graph. We hand the
    // client a `workerFactory` backed by Vite's `?worker` import (see the
    // top-of-file import): Vite then fully bundles the worker chunk and its
    // `?url` wasm asset, instead of opaquely copying a raw `.ts` URL across
    // the package boundary (the D6/E8 prod-dist bug).
    const c = new GatedCanvasClient({
      workerFactory: () => new CanvasRenderWorker(),
      // U5/A7 — the default-font invariant. Any document load that
      // reaches the client WITHOUT explicit font bytes (the plugin
      // native-document fallback, a direct `client.loadDocument` from
      // scripts/tests) still gets the editor's Inter, so text set in
      // fonts the document doesn't resolve renders through the default
      // instead of silently disappearing. The shell's own loaders pass
      // Inter explicitly and never hit this. Failure is LOUD: an
      // unfetchable default font is exactly the "blank text" precondition.
      defaultFontProvider: async () => {
        const bytes = await fetchDefaultFont();
        if (!bytes) {
          problemsSink.publish("paged.editor", "default-font", [
            {
              severity: "warning",
              message:
                "default font unavailable — text in documents with missing fonts will not render",
              source: "fonts",
            },
          ]);
        }
        return bytes;
      },
      // Inter's italic beside the roman default face: registered after
      // every load, so Inter Italic runs set in a slanted face.
      defaultFontFaces: fetchDefaultFontFaces,
    });
    setClient(c);
    return () => {
      c.dispose();
      setClient(null);
    };
  }, []);

  if (!client) {
    return (
      <div
        style={{
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
          padding: 16,
        }}
      >
        initialising worker…
      </div>
    );
  }

  return (
    <PagedShell
      client={client}
      panels={SOLO_SURFACES?.panels ?? BUILT_IN_PANELS}
      overlays={BUILT_IN_OVERLAYS}
      tools={SOLO_SURFACES?.tools ?? BUILT_IN_TOOLS}
      modes={SOLO_SURFACES?.modes ?? COCKPIT_MODES}
      panelRail={SOLO_SURFACES?.panelRail ?? PANEL_RAIL}
      canvasComponent={CanvasPanel}
      // The corpus picker is an Envato IDML-pack browser — DTP
      // furniture with no meaning in a drawing app.
      headerExtras={SOLO ? null : <CorpusPicker />}
      initialMode={SOLO ? "design" : undefined}
      initialDocumentSizePt={SOLO?.documentSizePt}
      bindingProviders={bindingProviders}
      objectModel={editorObjectModel}
    >
      <CanvasAppIntegration />
      <PluginBundles />
      <ConsentDialog controller={editorConsent.controller} />
      <DocumentReplaceDialog controller={editorDocuments.controller} />
      <SecretPromptDialog controller={editorSecrets.controller} />
      <CoreCommandDialog />
      <GlobalLightDialog />
      {/* The live-demo playground UI — only in the `demo` build, only when a
          ?script= is present (renders null otherwise). */}
      {(import.meta.env.MODE === "demo" || !import.meta.env.PROD) && (
        <PlaygroundController />
      )}
      {(import.meta.env.MODE === "demo" || !import.meta.env.PROD) && (
        <IframeScriptBridge />
      )}
    </PagedShell>
  );
}

// Fail fast + loud if the static host didn't ship the COOP/COEP headers the
// worker's SharedArrayBuffer needs — otherwise the app dies deep in the worker
// with an opaque SecurityError far from the real cause (W0.17).
assertCrossOriginIsolated();

// ADR 025 — the journal's global net. The editor had exactly ONE React error
// boundary (at the shell root) and NO window.onerror / unhandledrejection
// handler at all, so any throw outside a React render was invisible: nothing
// to attribute it to, nothing to put in a bug report. Installed before render
// so a crash DURING the first render is caught.
installGlobalErrorCapture();
if (!import.meta.env.PROD) {
  // Test affordance, same shape as `__overlaySignals` / `__pagedCrash`.
  exposeJournalForTests();
}

// ── SOLO MODE ────────────────────────────────────────────────────────
//
// Resolved ONCE, at module scope, before anything renders.
//
// NOT in JSX, and not memoized: `PagedShell` registers panels in an
// effect whose deps include the `panels` array and whose ref guard
// resets on cleanup, so a NEW ARRAY IDENTITY disposes ~55 panels and
// re-registers them — cascading through the Window menu and every
// derived show/hide command. `?solo` cannot change without a reload, so
// there is nothing to memoize and no reason to involve React at all.
//
// Resolution is TOTAL: an unknown profile returns null and the ordinary
// editor boots. This runs before `installGlobalErrorCapture()` at the
// bottom of this file, so a throw here would white-screen with nothing
// in the journal.
const SOLO = resolveSoloProfile(
  typeof location === "undefined" ? "" : location.search,
);
// Namespace the chrome's localStorage before the first read. Solo runs
// the cockpit under the mode id "design" (the union is closed), and
// `paged.cockpit.v1` is keyed BY MODE ID — unscoped, solo and the
// ordinary editor would overwrite each other's right-dock tabs, and the
// unresolvable ids would then be dropped in silence.
setChromeStorageScope(SOLO ? `.solo.${SOLO.bundleId}` : "");

/** Surfaces the app hands the shell, filtered to the profile.
 *
 *  ALLOW-LIST: the profile names what it SHOWS, so a host panel added
 *  later is absent from solo until someone puts it there deliberately.
 *  A deny-list would leak every new DTP panel into every profile — the
 *  fail-open shape this codebase keeps finding. The cost is the
 *  opposite failure (a renamed panel silently drops out), which is what
 *  `scripts/solo-profiles-guard.mjs` exists to catch. */
const SOLO_SURFACES = SOLO
  ? (() => {
      const panelAllow = new Set([
        ...SOLO.panelIds,
        // Whatever the layout itself names must survive the filter, or
        // the cockpit renders "This panel is unavailable" in its own
        // left column.
        ...(SOLO.slots.left ? [SOLO.slots.left] : []),
        ...(SOLO.slots.tabs ?? []),
        ...(SOLO.slots.inspector ? [SOLO.slots.inspector] : []),
        ...SOLO.panelRailIds,
      ]);
      const toolAllow = new Set([
        ...SOLO.toolIds,
        // Navigation and inspection are never taken away — the same set
        // the tool rail exempts from context narrowing, for the same
        // reason: selection is how you get out of anything.
        ...ALWAYS_IN_PALETTE,
      ]);
      const menuAllow = new Set(SOLO.menuTopLevels);
      const keepMenu = (m: { path: string }) =>
        menuAllow.has(m.path.split("/")[0]);
      return {
        panels: BUILT_IN_PANELS.filter((p) => panelAllow.has(p.id)),
        tools: BUILT_IN_TOOLS.filter((t) => toolAllow.has(t.id)),
        panelRail: PANEL_RAIL.filter((r) =>
          SOLO.panelRailIds.includes(r.panelId),
        ),
        modes: [soloMode(SOLO)],
        keepMenu,
      };
    })()
  : null;

// ADR 180 — the local library (every document a repository in the
// origin-private file system). Optional: without OPFS, or with
// `localStorage["paged.library"] = "off"`, the editor runs exactly as before.
function startLibrary(): void {
  try {
    if (globalThis.localStorage?.getItem("paged.library") === "off") return;
  } catch {
    /* storage blocked — the library needs it no more than the check does */
  }
  const storage = navigator.storage as StorageManager & {
    getDirectory?: unknown;
  };
  if (typeof storage?.getDirectory !== "function") return;
  setLibrary(connectLibrary(new LibraryWorker()));
  // Ask the browser not to evict the library under storage pressure.
  void storage.persist?.().catch(() => false);
}
startLibrary();

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}
createRoot(root).render(
  <StrictMode>
    <CanvasAppRoot />
  </StrictMode>,
);
