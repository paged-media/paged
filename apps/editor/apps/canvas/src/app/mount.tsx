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

// First: the Trusted Types default policy, before anything starts a worker.
import "../boot/install-trusted-types";
// The app's translations, registered before anything shows a word.
import "../strings";

import {
  StrictMode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  PagedShell,
  scopeOf,
  caretContribution,
  contentGrabberContribution,
  hitMarkerContribution,
  marqueeContribution,
  toolPreviewContribution,
  pluginOverlayLayersContribution,
  guideOverlayContribution,
  pageDecorationsContribution,
  isolationDimContribution,
  subContextContribution,
  marginBandContribution,
  marginGuidesContribution,
  pathEditContribution,
  resizeHandlesContribution,
  rotateHandleContribution,
  selectionChromeContribution,
  setCockpitPageNavigator,
  snapLinesContribution,
  gridOverlayContribution,
  tableCellOverlayContribution,
  threadingPortsContribution,
  threadLinesContribution,
  dataMarkersContribution,
  loadDocumentFile,
  fetchDefaultFont,
  fetchDefaultFontFaces,
  takePendingImportSource,
  setPendingImportSource,
  isReplaceDeclined,
  setDocumentSaver,
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
  AI_ASK_COMMAND,
  openAssistant,
  setAssistantOpener,
  resolveProfile,
  type EditorProfile,
  useEditorRoot,
  useOptionalTheme,
} from "@paged-media/shell";
import {
  StringsProvider,
  createStrings,
  defineMessages,
  setActiveStrings,
  t,
  useStrings,
  type Strings,
} from "@paged-media/strings";
import "@paged-media/shell/styles/globals.css";

import {
  CanvasClient,
  rotateCameraAbout,
  type DocumentHandle,
  type ElementId,
} from "@paged-media/client";
// Vite `?worker` import — constructs the render worker in THIS (app) module
// graph so Vite emits the worker chunk AND follows its transitive `?url` wasm
// import into a real `.wasm` asset. Passing only a worker URL across the
// @paged-media/client package boundary defeated Vite's static worker analysis:
// prod dist shipped a raw un-transpiled `worker.ts` and no wasm (audit D6/E8).
// See CanvasClientOptions for the full rationale.
import CanvasRenderWorker from "../worker/worker.ts?worker";
import LibraryWorker from "../library-worker.ts?worker";
import { connectLibrary } from "@paged-media/repository";
import { BUILT_IN_TOOLS } from "@paged-media/tools";
import { loadBundle, mlObjectModel } from "@paged-media/plugin-sdk";

import { createEditorMlService } from "../ml/create-editor-ml";
import { browserPngCodec } from "../ml/png-codec";
import { setMlService } from "../ml/scope";
import type { SchemaPanelRenderer as SchemaPanelRendererType } from "@paged-media/plugin-api";
import { errorIdent, identOf } from "@paged-media/client";
import {
  journal,
  setJournalDrainer,
  setDocumentShapeProvider,
  notePluginLoaded,
} from "../journal-sink";
import { createGuardedLoader } from "../plugin-load-guard";
import { answerScriptData } from "../script-data";
import { buildTransformCommands } from "../transform-commands";
import { cameraCentredOn, cameraForPage } from "../plugin-pages";
import { applyProfile } from "../profiles/apply";
import { profileFromSearch } from "../profiles/from-url";
// ADR 222 — the bundles are NOT imported here: each is a dynamic import()
// in the table, so each is its own chunk and none sits in the entry.
import { PLUGIN_BUNDLES } from "../plugin-bundle-table";
import { createBundleActivator, type BootGate } from "../plugin-bundle-loader";
import {
  createEditorHostOptions,
  hostOptionsForPlugin,
} from "../plugin-host-options";
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
import { ConsentDialog } from "../ConsentDialog";
import { SecretPromptDialog } from "../SecretPromptDialog";
import { CoreCommandDialog } from "../core-command-dialog";
import {
  FIND_COMMANDS,
  FIND_KEYBINDINGS,
  FIND_MENU_ITEMS,
} from "../find/find-commands";
import { FindReplaceDialog, GoToDialog } from "../find/find-ui";
import {
  STYLE_OPTIONS_PANEL,
  targetStyleOptions,
} from "../panels/style-options-panel";
import {
  GLOBAL_LIGHT_COMMANDS,
  GLOBAL_LIGHT_MENU_ITEMS,
  GlobalLightDialog,
} from "../panels/global-light-dialog";
import {
  buildViewCommands,
  VIEW_KEYBINDINGS,
  VIEW_MENU_ITEMS,
} from "../view-commands";
import {
  openViewPreferences,
  ViewPreferencesDialog,
} from "../panels/view-preferences-dialog";
import {
  buildTransformEachDialogCommands,
  TRANSFORM_EACH_MENU_ITEMS,
  TransformEachDialog,
} from "../panels/transform-each-dialog";
import {
  BATCH_MENU_ITEMS,
  BatchDialog,
  buildBatchCommands,
} from "../panels/batch-dialog";
import {
  OPEN_AS_TEMPLATE_COMMANDS,
  OPEN_AS_TEMPLATE_MENU_ITEMS,
  OpenAsTemplateDialog,
} from "../panels/template/open-as-template-dialog";
import {
  PDF_VECTORS_COMMANDS,
  PDF_VECTORS_MENU_ITEMS,
  PdfVectorsDialog,
} from "../panels/pdf-vectors-dialog";
import { TemplateNotice } from "../panels/template/template-notice";
import {
  buildCoreCommandEntries,
  CORE_COMMAND_MENU_ITEMS,
} from "../core-command-entries";
import { createEditorNativeDocumentBackend } from "../plugin-native-document";
import { pickFiles } from "../shell-file-picker";

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
import { HostColorPicker } from "../plugin-color-picker";
import {
  ObjectPropertyField,
  ObjectPropertyFrame,
  setRegisteredActionsSource,
  setDataDoorSource,
  setDataDropHandler,
} from "@paged-media/shell";
import { placeDropped } from "../data-drop";
import {
  cockpitActionsOf,
  createEditorScope,
  createIdAliases,
  deprecationWarning,
  migrateProfileIds,
  type IdDeprecation,
  memoryStorage,
  setEditorStorage,
  type EditorScope,
  type StorageAdapter,
} from "@paged-media/shell";
import { assertCrossOriginIsolated } from "../boot/cross-origin-isolation-check";
import DEPRECATED_IDS from "../../deprecated-ids.json" with { type: "json" };
import {
  APP_KEYBINDINGS,
  APP_MENU_ITEMS,
  buildAppCommands,
  PAGED_FILE_SAVE_PAGED,
} from "../app-commands";
import {
  arrangeSelection,
  buildObjectCommands,
  deleteSelection,
  groupSelection,
  hideSelection,
  lockSelection,
  makeClippingMask,
  nudgeSelection,
  OBJECT_DIAGNOSTIC_SOURCE,
  OBJECT_KEYBINDINGS,
  OBJECT_MENU_ITEMS,
  releaseClippingMask,
  editClippingContents,
  selectParentGroup,
  showAllOnSpread,
  ungroupSelection,
  unlockAllOnSpread,
  type ObjectCommandDeps,
} from "../object-commands";
import {
  CANVAS_CONTEXT_MENU_COMMAND,
  CANVAS_CONTEXT_MENU_KEYBINDINGS,
  CanvasContextMenuHost,
} from "../canvas-context-menu";
import {
  browserClipboard,
  buildClipboardCommands,
  CLIPBOARD_DIAGNOSTIC_SOURCE,
  CLIPBOARD_KEYBINDINGS,
  CLIPBOARD_MENU_ITEMS,
} from "../clipboard-commands";
import { buildSvgCommands, SVG_MENU_ITEMS } from "../svg-commands";
import {
  ASSET_EXPORT_MENU_ITEMS,
  buildAssetExportCommands,
} from "../asset-export/commands";
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
} from "../insert-commands";
import { COCKPIT_MODES, PANEL_RAIL } from "../cockpit-modes";
import { COCKPIT_MENU_SEAMS } from "../cockpit-menus";
import { buildEffectMenuCommands, buildEffectMenuItems } from "../effect-menu";
import { appCatalogRegistry } from "../panels/catalog-registry";
import { CanvasPanel } from "../panels/canvas-panel";
import { problemsOf, type ProblemsStore } from "../panels/problems-store";
import { BUILT_IN_PANELS } from "../panels/built-in-panels";
import { applyHistoryDepthPreference } from "../panels/history-panel";
import { PlaygroundController } from "../playground/PlaygroundController";
import { debugFlag } from "../debug-flags";
import { IframeScriptBridge } from "../playground/IframeScriptBridge";
import { useCameraTween } from "../ui/useAnimatedCamera";
import {
  pageAtViewportCentre,
  pageStep,
  selectionRect,
  spreadRect,
} from "../ui/fit-views";
import { documentBounds, fitCamera, layoutPages } from "../ui/layout";
import { usePathEditMode } from "../ui/usePathEditMode";
import { frameHoldingCaret, useTextEditing } from "../ui/useTextEditing";
import {
  SELECT_ALL_COMMAND,
  SELECT_ALL_KEYBINDINGS,
  SELECT_ALL_MENU_ITEM,
} from "../select-all";
import { CorpusPicker } from "../ui/CorpusPicker";
import { templateFieldsContribution } from "../overlays/template-fields";
import { liveShapeHandlesContribution } from "../overlays/live-shape-handles";
import {
  EditorInstanceProvider,
  createEditorServices,
  createRoleStore,
  hostCommands,
  type ShellAccess,
  useEditorInstance,
  type EditorInstance,
  type HostActions,
} from "./instance";
import { PRESETS } from "../profiles/presets";

// Default overlay contributions for the canvas app. Order is
// descriptive — actual paint order is determined by the
// contributions' `z` values inside OverlayHost.
const BUILT_IN_OVERLAYS: OverlayContribution[] = [
  pageDecorationsContribution,
  // WP4.6 — the isolation veil outside an entered edit context or group.
  isolationDimContribution,
  // Editor ADR 301 — a header, footer or note edited in place: the veil
  // around it and its bar.
  subContextContribution,
  // Editor ADR 300 — the markup margin band: a bundle's balloons (tracked
  // changes, comments) beside the pages while its context is active.
  marginBandContribution,
  // Template fields (docs/composable-editor.md §7.10): outlines, labels and a
  // picture's Replace button, for an author and a filler only.
  templateFieldsContribution,
  marginGuidesContribution,
  // Editor ADR 287 — View ▸ Show grid / Show pixel grid.
  gridOverlayContribution,
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
  // Editor ADR 310 — the live-shape widgets (corners, sides, star, pie).
  liveShapeHandlesContribution,
  // W2.9 — text-frame threading ports on the selection chrome.
  threadingPortsContribution,
  // B4 — the story's route across the spread (View ▸ Show text
  // threads). Draws nothing and fetches nothing until toggled on.
  threadLinesContribution,
  // Editor ADR 291 — View ▸ Show data markers: the frames the data is
  // placed in, in their sync state. Reads nothing until toggled on.
  dataMarkersContribution,
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

function PluginBundles() {
  const { surfaces, scope, services } = useEditorInstance();
  const paged = usePaged();
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  const registries = useRegistries();
  const registriesRef = useRef(registries);
  registriesRef.current = registries;
  // ADR 323 — the editor's object registry's core seam reads this editor.
  services.objects.setEditor(paged as never);
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
  // Extensions ADR 334 — `host.shell.exitEditContext`: leave the ACTIVE
  // context when it is of `type` (commit or cancel first). The live stack
  // through an effect event, as the undo routing reads it.
  const exitStack = useEditContextStack();
  const liveExitStack = useEffectEvent(() => exitStack);
  useEffect(() => {
    const {
      bindingProviders,
      boot,
      bundles,
      consent: editorConsent,
      documentIdentity,
      documents: editorDocuments,
      objects,
      pages,
      secrets: editorSecrets,
      willSave,
    } = services;
    const problemsSink = problemsOf(scope);
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
    const detachIdentity = documentIdentity.attach(
      () => pagedRef.current?.client.openDocument ?? null,
    );
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
      const sourceFileName = takePendingImportSource(scope) ?? name;
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
        scope,
      });
    };
    const nativeDocument = createEditorNativeDocumentBackend(
      scope,
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
          scope,
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
      panels: cockpitActionsOf(scope),
      panelTarget: (panelId, target) => {
        if (panelId === STYLE_OPTIONS_PANEL) targetStyleOptions(scope, target);
      },
      enterEditContext: (type, elementId) =>
        enterContextRef.current(type, elementId),
      exitEditContext: async (type, opts) => {
        const stack = liveExitStack();
        if (stack.active?.type !== type) return false;
        if (opts.commit) stack.commit();
        else stack.cancel();
        return true;
      },
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
      objects: objects.registry,
      diagnosticsSink: problemsSink,
      pages,
    });
    // Editor ADRs 291, 292: the Data panel and the bind popover read the
    // document's data from the same shared backend the bundles meet at.
    const dataBackend = hostOptions.shared.data;
    // Engine ADR 1014, amendment 2: a script's `paged.data.*` reads the same
    // backend, through the worker's blocking bridge. The client is the
    // shell's, stable for its lifetime.
    const scriptClient = pagedRef.current?.client ?? null;
    if (dataBackend) {
      scriptClient?.setScriptData((method, args) =>
        answerScriptData(dataBackend.current()?.service ?? null, method, args),
      );
      setDataDoorSource(scope, dataBackend);
      // Editor ADR 291: a field, a table or a record dropped on the document
      // is placed there; a refusal (no frame under it, a line, a design
      // without a <<field>>) reaches Problems.
      setDataDropHandler(scope, (drag, at) => {
        const paged = pagedRef.current;
        if (!paged) return;
        void placeDropped(
          paged,
          dataBackend.current()?.service ?? null,
          drag,
          at,
        ).then((r) =>
          problemsSink.publish(
            "media.paged.data",
            "drag-to-place",
            "error" in r
              ? [
                  {
                    severity: "warning",
                    message: r.error,
                    source: "drag-to-place",
                  },
                ]
              : [],
          ),
        );
      });
    }
    // Editor ADR 291: the picture column picker lists the actions every
    // bundle registers into the one shared registry.
    if (hostOptions.shared.actions)
      setRegisteredActionsSource(scope, hostOptions.shared.actions);
    // Editor ADR 290: the ML service registers its providers into the ML
    // backend every bundle shares (ml.*@1), Settings ▸ Models reads it, and
    // scripts reach generation through paged.ml.generate / paged.ml.edit.
    const mlBackend = hostOptions.shared.ml;
    const mlService = mlBackend ? createEditorMlService(mlBackend) : null;
    const mlCommands = mlBackend
      ? objects.registry.register({
          plugin: "paged.ml",
          model: mlObjectModel(mlBackend, browserPngCodec),
        })
      : null;
    if (mlService) {
      setMlService(scope, mlService);
      void mlService.start();
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
    // The profile's bundles only (a solo preset names ONE). Filtering
    // here (rather than after registration) means the others never
    // activate at all, so their panels, tools, menus, importers and edit
    // contexts are never registered and nothing has to un-register them —
    // and, since the bundles are dynamic imports (ADR 222), their chunks
    // are never fetched either.
    const activator = createBundleActivator({
      entries: surfaces.bundles,
      activate: loadGuarded,
      record: (entry) => journal.record(entry),
      publishProblem: (bundleId, key, diagnostics) =>
        problemsSink.publish(bundleId, key, diagnostics),
      importers: registriesRef.current.importers,
    });
    const release = bundles.attach({
      activator,
      hostOptions,
      // Load a bundle through the SAME loader and host options every real
      // bundle gets: the page entry's `__loadTestBundle` (a journey
      // exercises a plugin door end to end without a published plugin).
      loadBundle: (bundle) =>
        loadBundle(
          () => pagedRef.current,
          bundle,
          hostOptionsFor(bundle.manifest.id),
        ),
    });
    // Non-blocking: the shell is already mounted and painting. Document
    // loads wait for this (the gated client in CanvasAppRoot).
    void activator.boot().then(() => {
      if (bundles.activator() === activator) boot.markSettled();
    });
    return () => {
      activator.dispose();
      release();
      detachDocuments();
      detachIdentity();
      if (dataBackend) scriptClient?.setScriptData(null);
      setMlService(scope, null);
      mlService?.dispose();
      mlCommands?.dispose();
    };
    // Mount-once by design; the ref keeps the handle live. The services
    // are the instance's, fixed for the editor's lifetime.
  }, [surfaces.bundles, services, scope]);
  return null;
}

/** Save (.paged) — the native container (the app's File ▸ Save, below).
 *  A module function, not a `try` in the component: the compiler does
 *  not lower the conditionals in it inside one (ADR 229). Throws what the
 *  caller reports. */
async function savePagedFile(
  instance: EditorInstance,
  client: CanvasClient,
  sourceName: string | null | undefined,
): Promise<void> {
  const { scope, services } = instance;
  const { willSave } = services;
  const hostSave = instance.actions.save;
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
  // An embedding host stores the document itself (concept §8.3): the
  // bytes go to its `save` action, not to the library, a file or a
  // download.
  if (hostSave) {
    await hostSave({ bytes, name: baseName });
    client.markSaved(savedMark);
    return;
  }
  // ADR 180 — the save is a commit in the local library, alongside
  // (never instead of) the file write below. A library failure is
  // reported and the file still gets written.
  try {
    await commitSave(scope, bytes.slice(), baseName);
  } catch (err) {
    console.warn("Save (.paged): the library did not take this save:", err);
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
  if (await writeToOpenFile(scope, bytes, "application/x-paged+zip")) {
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

const M = defineMessages("app.main", {
  openPdf: "Open PDF",
  saveAsIdml: "Save As IDML",
  savePaged: "Save (.paged)",
  fileFailed: "{what} failed — {message}",
  askClaude: "Ask Claude",
  defaultFontUnavailable:
    "The default font is unavailable — text in documents with missing " +
    "fonts will not render.",
  initialising: "Starting the editor…",
});
function reportFileFailure(
  problemsSink: ProblemsStore,
  what: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  problemsSink.publish(FILE_DIAGNOSTIC_SOURCE, "file", [
    {
      severity: "error",
      message: t(M.fileFailed, { what, message }),
      source: "file",
    },
  ]);
  // eslint-disable-next-line no-console
  console.error(`${what} failed:`, err);
}

function CanvasAppIntegration() {
  const instance = useEditorInstance();
  const client = useCanvasClient();
  const { camera, setCamera, viewportSize } = useCamera();
  const { handle, sourceName } = useDocument();
  const { contentSelection, setContentSelection } = useContentSelection();
  const registries = useRegistries();
  const { pages } = instance.services;
  const problemsSink = problemsOf(instance.scope);

  // Host actions as commands (docs/composable-editor.md §8.3): registered
  // only when the host supplies them, so a profile can place them in a
  // region (the actions bar, the header) and a feature can switch them off.
  useEffect(() => {
    const host = hostCommands(instance.actions);
    const disposables = host.map((c) => registries.commands.register(c));
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [instance, registries]);
  // ADR 230 — the replace question's Save is the save Cmd+S runs.
  useEffect(
    () =>
      setDocumentSaver(instance.scope, async () => {
        await registries.commands.invoke(PAGED_FILE_SAVE_PAGED);
      }),
    [instance.scope, registries],
  );
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
    return setJournalDrainer(() => client.drainJournal());
  }, [client]);
  // Editor ADR 285 — the history-depth preference reaches the worker once;
  // it keeps the depth across document loads.
  useEffect(() => {
    applyHistoryDepthPreference(instance.scope, client);
  }, [instance.scope, client]);
  // ADR 025 — the opt-in `documentShape` export section. The engine's
  // `DocumentStats` is already pure counts, so this carries structure and no
  // content. A PROVIDER, not a snapshot: the dialog must show the document
  // open at EXPORT time, not whatever was open when the panel mounted.
  useEffect(() => {
    return setDocumentShapeProvider(() => {
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
  }, [handle]);
  // ADR-012 Tier 1 — the MENU path of the undo routing (the controller
  // owns the keyboard chords): while a modal context declares undo
  // ownership, Edit/Undo + Edit/Redo drive ITS op-log, not the document
  // stack. An effect event so the command closures (registered once per
  // effect run) always see the live stack without re-registering per
  // enter/exit.
  const editContextStack = useEditContextStack();
  const currentEditContext = useEffectEvent(() => editContextStack);
  // `paged.object.*` reads the LIVE element selection, for the same
  // reason the edit-context stack is: the command effect must not
  // re-register on every click.
  const selection = useSelection();
  const currentSelection = useEffectEvent(() => selection);

  // `cameraDestination`: where the camera is heading while a tween runs
  // (the page keys and the fits step from there).
  const { animateTo: animateCamera, destination: cameraDestination } =
    useCameraTween(camera, setCamera);
  useTextEditing({
    client,
    selection: contentSelection,
    setSelection: setContentSelection,
    // useTextEditing calls these through the latest render's context.
    undoOwnedByContext: () => !!editContextStack?.activeContribution?.onUndo,
    // Editor ADR 301 — inside a header edited in place, Escape takes the
    // caret out of the header (which leaves it), not the context.
    escapeOwnedByContext: () =>
      !!editContextStack?.active && !registries.subContexts.current(),
    // ED-1 — Escape out of the text is InDesign's: the frame that held
    // the caret becomes the selection and the Selection tool is in hand,
    // so the next key is a shortcut again rather than more text.
    onLeaveText: (left) => {
      selection.setActiveTool("select");
      void (async () => {
        const frameId = await frameHoldingCaret(client, left);
        if (!frameId) return;
        const applied = await client.setElementSelection(
          [{ kind: "textFrame", id: frameId }],
          "replace",
        );
        selection.setElementSelection(applied);
        selection.setElementGeometry(await client.elementGeometry(applied));
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
    pages.publishActivePage(target?.pageId ?? null);
  }, [client, handle, camera, viewportSize, pages]);

  // `host.viewport.revealText`: the camera onto where the range is laid
  // out (its first line, at the current zoom or a readable one), then —
  // unless the plugin asked not to — the range as the text selection.
  useEffect(() => {
    pages.setTextReveal(async (range, select) => {
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
        handle.pageOriginsPt,
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
    return () => pages.setTextReveal(null);
  }, [
    animateCamera,
    pages,
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
  const currentPageHandle = useEffectEvent(() => handle);
  useEffect(() => {
    pages.setPageGoTo(async (pageId, fit) => {
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
        const h = currentPageHandle();
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
        h.pageOriginsPt,
        h.pageIds.indexOf(pageId as never),
        fit,
        vw,
        vh,
      );
      if (!cam) return false;
      animateCamera(cam);
      return true;
    });
    return () => pages.setPageGoTo(null);
  }, [animateCamera, client, pages, viewportSize]);

  // Cockpit — the thumbnail filmstrip / document map navigate by
  // page indices; the camera-fit math (page layout convention) is
  // app-side, registered with the shell's navigation hand-off.
  useEffect(() => {
    setCockpitPageNavigator(instance.scope, (pageIndices) => {
      const pageSizes = handle?.pageSizesPt ?? [];
      if (pageSizes.length === 0 || pageIndices.length === 0) return;
      const rects = layoutPages(pageSizes, handle?.pageOriginsPt);
      // The default layout stacks ALL pages vertically (spreads are not
      // side-by-side), so fitting the union rect of a multi-page
      // spread lands the camera on the inter-page GAP. Fit the
      // spread's FIRST page instead; a spread-aware default layout
      // (pages of one spread side by side) is the structural fix
      // (follow-up).
      const target = rects[pageIndices[0]];
      if (!target) return;
      const [vw, vh] = viewportSize;
      animateCamera(fitCamera(vw, vh, target));
    });
    return () => setCockpitPageNavigator(instance.scope, null);
  }, [animateCamera, handle, instance.scope, viewportSize]);

  // SDK Phase 4 — register canvas-app commands + menu items +
  // keybindings. Closures capture the *current* camera / handle /
  // viewportSize so the zoom commands see live values; dependency
  // array re-runs on each change. The registries' dedupe-by-id
  // contract means re-registration is safe (the dispose from the
  // previous run drops the stale handler before we add the new one).
  useEffect(() => {
    const [vw, vh] = viewportSize;
    const pageSizes = handle?.pageSizesPt ?? [];
    const rects = layoutPages(pageSizes, handle?.pageOriginsPt);
    // Editor ADR 287 — the fits keep the view's rotation.
    const rot = camera.rotation ?? 0;
    const commands = buildAppCommands({
      undo: () => {
        const owner = currentEditContext().activeContribution;
        if (owner?.onUndo) {
          owner.onUndo();
          return;
        }
        void client.undo();
      },
      redo: () => {
        const owner = currentEditContext().activeContribution;
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
      //
      // The importer opens through `host.nativeDocument.open`, whose backend
      // asks the replace question (ADR 230); the parked name lets it name
      // the file, as File ▸ Open… and a drop do.
      openPdf: async () => {
        const [file] = await pickFiles({ accept: [".pdf", "application/pdf"] });
        if (!file) return;
        const importer = registries.importers.resolve(file.name);
        if (!importer) return;
        setPendingImportSource(instance.scope, file.name);
        await Promise.resolve()
          .then(() =>
            importer.import({
              name: file.name,
              bytes: file.bytes,
              mimeType: "application/pdf",
            }),
          )
          .catch((err: unknown) => {
            if (!isReplaceDeclined(err))
              reportFileFailure(problemsSink, t(M.openPdf), err);
          })
          .finally(() => setPendingImportSource(instance.scope, null));
      },
      // W3.B2 — Save As IDML: serialise the loaded document to an
      // `.idml` package and trigger a browser download (mirrors the
      // PDF export's Blob → object-URL → anchor-click pattern). The
      // filename comes from the document meta; bail quietly when no
      // document is open.
      saveAsIdml: async () => {
        if (!handle || handle.pageCount === 0) return;
        // U14 — same identity preference as the doc title bar:
        // meta.documentName, else the loaded file's name. Decided outside
        // the `try`: the compiler does not lower a conditional inside one
        // (ADR 229).
        const fallbackName = sourceName || "document";
        try {
          const bytes = await client.exportIdml();
          const baseName = await client.documentMeta().then(
            (meta) => meta.documentName || fallbackName,
            // meta unavailable — keep the fallback name
            () => fallbackName,
          );
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
          reportFileFailure(problemsSink, t(M.saveAsIdml), err);
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
        await savePagedFile(instance, client, sourceName).catch(
          (err: unknown) => {
            // A failed save that reaches only the devtools console is a
            // failed save the user believes succeeded — and with no
            // autosave behind it, believing wrongly is how work is lost.
            reportFileFailure(problemsSink, t(M.savePaged), err);
          },
        );
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
        animateCamera(fitCamera(vw, vh, documentBounds(rects), 40, rot));
      },
      // The fit commands and the page keys (F-31, F-16, ADR 257). The
      // current page is the one at the viewport's centre once the camera
      // arrives: a key pressed while the last one's tween runs steps from
      // where that tween is going (Next, First pressed quickly lands on
      // the first page, not on the second the tween went on to).
      fitPage: () => {
        const at = pageAtViewportCentre(rects, cameraDestination(), [vw, vh]);
        if (at < 0) return;
        animateCamera(fitCamera(vw, vh, rects[at]!, 40, rot));
      },
      fitSpread: async () => {
        const at = pageAtViewportCentre(rects, cameraDestination(), [vw, vh]);
        if (at < 0 || !handle) return;
        let spreads: (string | null)[] = [];
        try {
          const pages = await client.collection<{
            selfId: string;
            spreadId?: string | null;
          }>("pages");
          const byId = new Map(pages.map((p) => [p.selfId, p.spreadId]));
          spreads = handle.pageIds.map((id) => byId.get(id) ?? null);
        } catch {
          /* no spread map: the page is a spread of its own */
        }
        const rect = spreadRect(rects, spreads, at);
        if (rect) animateCamera(fitCamera(vw, vh, rect, 40, rot));
      },
      fitSelection: async () => {
        if (!handle) return;
        const ids = currentSelection().elementSelection;
        if (ids.length === 0) return;
        // A group's box is its leaves' (the page-position readout's rule).
        const leaves: ElementId[] = [];
        for (const id of ids) {
          if (id.kind !== "group") leaves.push(id);
          else leaves.push(...(await client.groupLeaves(id.id as string)));
        }
        const items = await client.elementGeometry(leaves).catch(() => []);
        const rect = selectionRect(
          rects,
          handle.pageIds.map(String),
          items.map((g) => ({
            pageId: g.pageId == null ? null : String(g.pageId),
            bounds: g.bounds,
            itemTransform: g.itemTransform,
          })),
        );
        if (!rect) return;
        // A line has no height (or width): fit a point of it, not nothing.
        const w = Math.max(rect.w, 1);
        const h = Math.max(rect.h, 1);
        animateCamera(
          fitCamera(
            vw,
            vh,
            {
              x: rect.x - (w - rect.w) / 2,
              y: rect.y - (h - rect.h) / 2,
              w,
              h,
            },
            40,
            rot,
          ),
        );
      },
      goToPage: (which) => {
        const at = pageAtViewportCentre(rects, cameraDestination(), [vw, vh]);
        const target = pageStep(which, at, rects.length);
        if (target === null) return;
        animateCamera(fitCamera(vw, vh, rects[target]!, 40, rot));
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
      getSelection: () => currentSelection().elementSelection,
      // F-41 — the spread "Unlock all / Show all on spread" act on when
      // nothing is selected: the page at the viewport's centre.
      pageInView: () =>
        pageTargetFor({ handle, camera, viewportSize })?.pageId ?? null,
      // ADR 024 — read through the SAME ref the undo routing uses, so
      // the two cannot disagree about which context is active.
      activeEditContext: () => currentEditContext().active,
      setSelection: async (ids) => {
        const applied = await client.setElementSelection(ids, "replace");
        currentSelection().setElementSelection(applied);
        try {
          currentSelection().setElementGeometry(
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
        const selected = currentSelection().elementSelection;
        const shown = currentSelection().elementGeometry.map((g) => g.id);
        const ids = shown.length > 0 ? shown : selected;
        if (ids.length === 0) return;
        const items = await client.elementGeometry(ids);
        // The selection moved on while the engine answered: the path
        // that changed it fetched its own geometry, and this answer is
        // for something no longer on screen.
        if (currentSelection().elementSelection !== selected) return;
        currentSelection().setElementGeometry(items);
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
      editClippingContents: fresh(() => editClippingContents(objectDeps)),
      lock: fresh(() => lockSelection(objectDeps)),
      unlockAllOnSpread: fresh(() => unlockAllOnSpread(objectDeps)),
      hide: fresh(() => hideSelection(objectDeps)),
      showAllOnSpread: fresh(() => showAllOnSpread(objectDeps)),
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
      placeImage: (p, dropped) => {
        problemsSink.clear(INSERT_DIAGNOSTIC_SOURCE);
        return placeImage(
          p,
          (severity, message) => {
            insertReport(severity, message);
            if (severity === "error") {
              void registries.commands.invoke(
                "paged.panel.show.paged.problems",
              );
            }
          },
          dropped,
        );
      },
      newPage: freshInsert((p) => addPage(p, insertReport)),
    });
    // ADR 323 — Align / Distribute and Transform Each as TYPED commands
    // (transform-commands.ts): declared args, one batch = one undo.
    // WP4.4 — Object ▸ Transform ▸ Transform each… opens its dialog over
    // the selection's addresses.
    const transformEachDialogCommands = buildTransformEachDialogCommands(
      (paged) =>
        ((paged as PagedEditor | null)?.selection.elementSelection ?? []).map(
          (id) => instance.services.objects.addressOfElement(id),
        ),
    );
    const alignCommands = buildTransformCommands(
      instance.services.objects.registry,
      (address) =>
        instance.services.objects.model.elementIdOf?.(address) ?? null,
    );
    // ADR 221 — every Claude entry point opens the AI Assistant panel;
    // the palette's "Ask Claude" row also runs the request there.
    setAssistantOpener(
      instance.scope,
      () =>
        void registries.commands.invoke("paged.panel.show.paged.ai-assistant"),
    );
    const aiCommands = [
      {
        id: AI_ASK_COMMAND,
        title: t(M.askClaude),
        category: "Assistant",
        args: { kind: "text" } as const,
        handler: (_paged: unknown, payload?: unknown) => {
          openAssistant(instance.scope, {
            view: "ask",
            draft: String(payload ?? ""),
            autoRun: true,
          });
        },
      },
    ];
    // ADR 231 — the page-item clipboard: Cut, Copy, Paste, Paste in
    // place, Duplicate. Cut's delete is Object ▸ Delete's own.
    const clipboardCommands = buildClipboardCommands({
      report: (severity, message) =>
        problemsSink.publish(CLIPBOARD_DIAGNOSTIC_SOURCE, "clipboard", [
          { severity, message, source: "clipboard" },
        ]),
      system: browserClipboard(),
      deleteSelection: () => deleteSelection(objectDeps),
    });
    // Engine ADR 1031 — File ▸ Import ▸ SVG… and File ▸ Export ▸ SVG.
    const svgCommands = buildSvgCommands({
      report: (rows) =>
        problemsSink.publish(
          "paged.svg",
          "svg",
          rows.map((r) => ({ ...r, source: "svg" })),
        ),
    });
    // Editor ADR 287 — View ▸ Outline / Overprint / Pixel Preview, the
    // grids, snapping and Rotate View.
    const viewCommands = buildViewCommands({
      rotateView: (deg) =>
        animateCamera(
          rotateCameraAbout(camera, (deg * Math.PI) / 180, vw / 2, vh / 2),
        ),
      resetRotation: () =>
        animateCamera(
          rotateCameraAbout(camera, -(camera.rotation ?? 0), vw / 2, vh / 2),
        ),
      openPreferences: (paged) => openViewPreferences(scopeOf(paged)),
    });
    const cmdDisposables = [
      ...commands,
      ...aiCommands,
      ...clipboardCommands,
      ...svgCommands,
      // Editor ADR 288 — Asset Export.
      ...buildAssetExportCommands(),
      CANVAS_CONTEXT_MENU_COMMAND,
      ...objectCommands,
      ...insertCommands,
      ...alignCommands,
      ...GLOBAL_LIGHT_COMMANDS,
      // Editor ADR 309 — Object ▸ Effects ▸ <group> ▸ <effect>.
      ...buildEffectMenuCommands(),
      ...transformEachDialogCommands,
      ...buildBatchCommands(),
      ...viewCommands,
      ...OPEN_AS_TEMPLATE_COMMANDS,
      ...PDF_VECTORS_COMMANDS,
      SELECT_ALL_COMMAND,
      // ADR 303 — Find & Replace, Go to page.
      ...FIND_COMMANDS,
      // ADR 323 §4 — the typed core commands' menu / palette doors.
      ...buildCoreCommandEntries(),
    ].map((c) => registries.commands.register(c));
    const menuDisposables = [
      ...APP_MENU_ITEMS,
      SELECT_ALL_MENU_ITEM,
      ...FIND_MENU_ITEMS,
      ...CLIPBOARD_MENU_ITEMS,
      ...SVG_MENU_ITEMS,
      ...ASSET_EXPORT_MENU_ITEMS,
      ...OBJECT_MENU_ITEMS,
      ...INSERT_MENU_ITEMS,
      ...CORE_COMMAND_MENU_ITEMS,
      ...GLOBAL_LIGHT_MENU_ITEMS,
      ...buildEffectMenuItems(),
      ...TRANSFORM_EACH_MENU_ITEMS,
      ...BATCH_MENU_ITEMS,
      ...VIEW_MENU_ITEMS,
      ...OPEN_AS_TEMPLATE_MENU_ITEMS,
      ...PDF_VECTORS_MENU_ITEMS,
      ...COCKPIT_MENU_SEAMS,
    ]
      // The profile keeps only the host menus its menu bar names. Whole-
      // menu removal falls out of this for free: MenuBar builds a top-level
      // menu only if at least one item carries that first path segment,
      // so dropping every `Layout/…` item removes the Layout menu — no
      // per-menu predicate needed, and none exists.
      .filter((m) => instance.surfaces.keepMenu(m))
      .map((m) => registries.menus.register(m));
    const keyDisposables = [
      ...APP_KEYBINDINGS,
      ...SELECT_ALL_KEYBINDINGS,
      ...FIND_KEYBINDINGS,
      ...CLIPBOARD_KEYBINDINGS,
      ...CANVAS_CONTEXT_MENU_KEYBINDINGS,
      ...OBJECT_KEYBINDINGS,
      ...INSERT_KEYBINDINGS,
      ...VIEW_KEYBINDINGS,
    ].map((k) => registries.keybindings.register(k));
    return () => {
      for (const d of cmdDisposables) d.dispose();
      for (const d of menuDisposables) d.dispose();
      for (const d of keyDisposables) d.dispose();
    };
  }, [
    registries,
    instance,
    instance.surfaces,
    client,
    camera,
    viewportSize,
    handle,
    sourceName,
    animateCamera,
    cameraDestination,
    problemsSink,
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
  readonly #boot: BootGate;

  constructor(
    boot: BootGate,
    options: ConstructorParameters<typeof CanvasClient>[0],
  ) {
    super(options);
    this.#boot = boot;
  }

  override async loadDocument(
    ...args: Parameters<CanvasClient["loadDocument"]>
  ): ReturnType<CanvasClient["loadDocument"]> {
    await this.#boot.settled();
    return super.loadDocument(...args);
  }

  override async newBlankDocument(
    ...args: Parameters<CanvasClient["newBlankDocument"]>
  ): ReturnType<CanvasClient["newBlankDocument"]> {
    await this.#boot.settled();
    return super.newBlankDocument(...args);
  }
}

/**
 * Root: owns the CanvasClient lifecycle and hands it to PagedShell.
 */
/** Hands the mounted shell to the embedding API (`onShell`), once. */
function InstanceBridge() {
  const instance = useEditorInstance();
  const paged = usePaged();
  const registries = useRegistries();
  const client = useCanvasClient();
  const theme = useOptionalTheme();
  const setThemeMode = theme?.setTheme;
  const root = useEditorRoot();
  const handed = useRef(false);
  useEffect(() => {
    if (handed.current || !instance.onShell || !root) return;
    handed.current = true;
    instance.onShell({
      paged,
      registries,
      client,
      setThemeMode: (mode) => setThemeMode?.(mode),
      root,
    });
  }, [instance, paged, registries, client, setThemeMode, root]);
  return null;
}

function CanvasAppRoot() {
  const instance = useEditorInstance();
  const strings = useStrings();
  const role = useSyncExternalStore(
    instance.role.subscribe,
    instance.role.get,
    instance.role.get,
  );
  const [client, setClient] = useState<CanvasClient | null>(null);

  useEffect(() => {
    // SDK Phase 1 — `@paged-media/client` is framework-agnostic, so the
    // Worker is constructed HERE in the app's module graph. We hand the
    // client a `workerFactory` backed by Vite's `?worker` import (see the
    // top-of-file import): Vite then fully bundles the worker chunk and its
    // `?url` wasm asset, instead of opaquely copying a raw `.ts` URL across
    // the package boundary (the D6/E8 prod-dist bug).
    const c = new GatedCanvasClient(instance.services.boot, {
      workerFactory: () => {
        const w = new CanvasRenderWorker();
        // The first message, before the client's own: the worker boots
        // the engine from it (worker.ts `startInit`).
        if (instance.engineWasm)
          w.postMessage({ kind: "engineWasm", url: instance.engineWasm });
        return w;
      },
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
          problemsOf(instance.scope).publish("paged.editor", "default-font", [
            {
              severity: "warning",
              message: t(M.defaultFontUnavailable),
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
    instance.onClient?.(c);
    return () => {
      c.dispose();
      setClient(null);
    };
  }, [instance]);

  if (!client) {
    return (
      <div
        style={{
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
          padding: 16,
        }}
      >
        {strings.t(M.initialising)}
      </div>
    );
  }

  return (
    <PagedShell
      client={client}
      panels={instance.surfaces.panels}
      overlays={BUILT_IN_OVERLAYS}
      tools={instance.surfaces.tools}
      modes={instance.surfaces.modes}
      panelRail={instance.surfaces.panelRail}
      canvasComponent={CanvasPanel}
      // The corpus picker is an Envato IDML-pack browser — DTP
      // furniture with no meaning in a drawing app.
      headerExtras={instance.surfaces.plain ? <CorpusPicker /> : null}
      // A template opened as a document says so and offers "Edit
      // template" (ADR 293).
      notices={<TemplateNotice />}
      initialMode={instance.surfaces.initialMode}
      initialDocumentSizePt={instance.surfaces.initialDocumentSizePt}
      regions={instance.profile.regions}
      canvasFurniture={instance.profile.canvas}
      compactLayout={instance.profile.compact}
      features={instance.profile.features}
      sessionPolicy={{ role, overrides: [] }}
      onSessionRoleChange={instance.role.set}
      bindingProviders={instance.services.bindingProviders}
      objectModel={instance.services.objects.model}
      scope={instance.scope}
      ownsPage={instance.ownsPage}
      guardUnload={instance.guardUnload}
    >
      <CanvasAppIntegration />
      <InstanceBridge />
      <CanvasContextMenuHost />
      <PluginBundles />
      <ConsentDialog controller={instance.services.consent.controller} />
      <SecretPromptDialog controller={instance.services.secrets.controller} />
      <CoreCommandDialog />
      <GlobalLightDialog />
      <ViewPreferencesDialog />
      <TransformEachDialog />
      <BatchDialog />
      <OpenAsTemplateDialog />
      <FindReplaceDialog />
      <GoToDialog />
      <PdfVectorsDialog />
      {/* The live-demo playground UI and the docs' iframe scripting bridge:
          the page entry's tools (they drive the page's `__canvas`), only in
          the dev and `demo` builds, only when the URL asks (they render
          null otherwise). */}
      {instance.devTools &&
        (import.meta.env.MODE === "demo" || !import.meta.env.PROD) && (
          <PlaygroundController />
        )}
      {instance.devTools &&
        (import.meta.env.MODE === "demo" || !import.meta.env.PROD) && (
          <IframeScriptBridge />
        )}
    </PagedShell>
  );
}

// ── THE EDITOR PROFILE ───────────────────────────────────────────────
//
// Resolved ONCE PER MOUNT, before anything renders (docs/composable-editor.md
// §5; solo mode is the preset `solo:<name>`, ADR 213), and handed down in an
// EditorInstance (plan task E1).
//
// NOT recomputed in render: `PagedShell` registers panels in an effect whose
// deps include the `panels` array and whose ref guard resets on cleanup, so a
// NEW ARRAY IDENTITY disposes ~55 panels and re-registers them. One instance
// per mount keeps every list's identity for the editor's lifetime.
//
// Resolution is TOTAL: an unknown preset resolves to the ordinary editor and
// reports a problem.

/** How a host mounts an editor (concept §8.1). */
export interface MountOptions {
  /** A preset id (`template-fill`) or a profile; else the URL's. */
  profile?: string | EditorProfile;
  /** The query string a URL-configured editor reads (`?profile=`, `?solo=`). */
  search?: string;
  /** What the host decides: save, submit, close, back. */
  actions?: HostActions;
  /** Start the local document library (OPFS). Default: the plain editor only. */
  library?: boolean;
  /** Called once the editor's client exists. */
  onClient?: (client: CanvasClient) => void;
  /** Called once the shell is mounted (the embedding API's handle). */
  onShell?: (shell: ShellAccess) => void;
  /** The words the editor shows (a locale's catalogue); else English. */
  strings?: Strings;
  /** Where the engine's wasm is served; else this build's own asset. */
  engineWasm?: string;
  /** The page's dev and demo tools: the live-demo playground and the docs'
   *  iframe scripting bridge, which drive the page's `__canvas`. The page
   *  entry's (entry.tsx); an embedded editor has none. */
  devTools?: boolean;
  /** The editor is the page (the page entry): keys typed with nothing
   *  focused are its from the start. Default false: an embedded editor
   *  takes the keyboard once it is pointed at or focused, and keys typed
   *  in the host's own elements stay the host's. */
  ownsPage?: boolean;
  /** Ask before the page unloads with unsaved edits (`beforeunload`).
   *  Default false: the page is the host's, and so is that question. The
   *  page entry asks. */
  guardUnload?: boolean;
  /** Where the editor keeps its settings (theme, workflow mode, dock tabs,
   *  palette recents, export options, remembered grants): an adapter with
   *  Web Storage's getItem / setItem / removeItem, `localStorage` itself
   *  for the page entry. Default: memory, for this editor's lifetime, so
   *  an embedded editor never touches its host's origin storage unasked. */
  storage?: StorageAdapter;
}

export function createEditorInstance(
  options: MountOptions = {},
): EditorInstance {
  // PM-0013, amendment 2: a host's old ids are read as their replacements, and each is
  // reported once (the console here; the handle's `idDeprecated` event).
  const idAliases = createIdAliases(
    DEPRECATED_IDS.deprecated as readonly IdDeprecation[],
  );
  idAliases.subscribe((d) =>
    console.warn(`[editor profile] ${deprecationWarning(d)}`),
  );
  const resolved =
    options.profile === undefined
      ? profileFromSearch(options.search ?? "")
      : resolveProfile(
          typeof options.profile === "string"
            ? { extends: options.profile }
            : migrateProfileIds(options.profile, idAliases),
          PRESETS,
        );
  const profile = resolved.profile;
  // The editor's own stores, and its services over them.
  const scope = createEditorScope();
  // Namespace the chrome's localStorage before the first read. A solo
  // preset runs the cockpit under the mode id "design", and
  // `paged.cockpit.v1` is keyed BY MODE ID — unscoped, solo and the
  // ordinary editor would overwrite each other's right-dock tabs.
  setChromeStorageScope(scope, profile.storageScope);
  setEditorStorage(scope, options.storage ?? memoryStorage());
  // ALLOW-LIST: a profile names what it SHOWS, so a host panel added later
  // is absent from a preset until someone puts it there deliberately
  // (`scripts/profile-presets-guard.mjs` catches a renamed id).
  const surfaces = applyProfile(profile, {
    panels: BUILT_IN_PANELS,
    tools: BUILT_IN_TOOLS,
    panelRail: PANEL_RAIL,
    modes: COCKPIT_MODES,
    bundles: PLUGIN_BUNDLES,
  });
  const problems = [...resolved.problems, ...surfaces.problems];
  for (const problem of problems) {
    console.warn(`[editor profile] ${problem.path}: ${problem.message}`);
  }
  return {
    profile,
    surfaces,
    actions: options.actions ?? {},
    problems,
    onClient: options.onClient,
    onShell: options.onShell,
    role: createRoleStore(profile.role),
    devTools: options.devTools === true,
    ownsPage: options.ownsPage === true,
    guardUnload: options.guardUnload === true,
    scope,
    services: createEditorServices(scope),
    idAliases,
    ...(options.engineWasm ? { engineWasm: options.engineWasm } : {}),
  };
}

// ADR 180 — the local library (every document a repository in the
// origin-private file system). Optional: without OPFS, or with
// `localStorage["paged.library"] = "off"`, the editor runs exactly as before.
function startLibrary(scope: EditorScope): void {
  try {
    if (globalThis.localStorage?.getItem("paged.library") === "off") return;
  } catch {
    /* storage blocked — the library needs it no more than the check does */
  }
  const storage = navigator.storage as StorageManager & {
    getDirectory?: unknown;
  };
  if (typeof storage?.getDirectory !== "function") return;
  setLibrary(scope, connectLibrary(new LibraryWorker()));
  // Ask the browser not to evict the library under storage pressure.
  void storage.persist?.().catch(() => false);
}
/** A mounted editor (concept §8). */
export interface MountedEditor {
  readonly instance: EditorInstance;
  /** Unmount the editor and release its worker. */
  dispose(): void;
}

/**
 * Mount an editor into `element` (plan task E1). The page entry
 * (`entry.tsx`) mounts one into `#root` configured by the URL; an embedding
 * host passes a preset or a profile and its actions.
 */
export function mountEditor(
  element: HTMLElement,
  options: MountOptions = {},
): MountedEditor {
  // Fail fast + loud if the static host didn't ship the COOP/COEP headers
  // the worker's SharedArrayBuffer needs — otherwise the editor dies deep in
  // the worker with an opaque SecurityError far from the real cause (W0.17).
  assertCrossOriginIsolated();
  const strings = options.strings ?? createStrings();
  // The words of what is built before the first render (the profile's
  // panels and modes) follow the editor's locale too.
  setActiveStrings(strings);
  const instance = createEditorInstance(options);
  if (options.library ?? instance.surfaces.plain) startLibrary(instance.scope);
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <StringsProvider strings={strings}>
        <EditorInstanceProvider instance={instance}>
          <CanvasAppRoot />
        </EditorInstanceProvider>
      </StringsProvider>
    </StrictMode>,
  );
  return { instance, dispose: () => root.unmount() };
}
