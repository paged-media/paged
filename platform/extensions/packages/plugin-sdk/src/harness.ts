// Headless conformance harness — IMPLEMENTED (B-13 RESOLVED, residuals
// below). The paper (§12.4) puts the conformance harness in the SDK
// tier: a headless host that activates a bundle, replays Operations
// against a REAL engine, and asserts on the result — no browser, no
// editor.
//
// What makes it real (not the fiction the old throw guarded against):
//   · the engine is the PUBLISHED @paged-media/canvas-wasm, booted in
//     Node (see ./wasm-loader.ts) — the same wasm the editor ships;
//   · the document/selection/diagnostics doors drive the SAME
//     `handleMessage` JSON envelope the editor worker drives, so a
//     bundle's mutations round-trip through the true parse→apply→inverse
//     path with true undo/redo;
//   · contribution registrations (tool/panel/command/keybinding/overlay)
//     become RECORDING no-ops — there is no UI to mount, but every
//     contribution is captured in an assertable log. That IS the
//     conformance semantics: replay against a real engine + an
//     assertable contribution log.
//
// DOORS — implemented vs recorded vs reserved:
//   · document.mutate / undo / redo / collection / meta / pathAnchors /
//     hitTest / elementGeometry / tree / getMetadata / setMetadata /
//     onDidChange — REAL (engine round-trip).
//   · selection.get / set / onDidChange — REAL.
//   · diagnostics, storage, log, supports, manifest — REAL (in-memory,
//     identical to the in-process host).
//   · contribute.* (tool/panel/command/keybinding/overlay) — RECORDED
//     (captured in `contributions`; no host UI).
//   · overlay.setToolPreview, viewport.camera/pxToPt — RECORDED /
//     synthetic (no canvas; camera is a fixed identity unless set).
//   · contribute.editContext / objectType — RESERVED (still throw
//     PluginApiNotImplemented via the shared host adapter).
//
// RESIDUALS (carried in plugin-draw/BREAKAGE_LOG.md B-13): gesture
// REPLAY (driving a tool's `gesture()` machine event-by-event against
// the headless engine) and overlay PREVIEW assertions are recorded
// no-ops, not yet replayed; tree/collection reads depend on the engine
// exposing them headlessly (they do, via the JSON channel).

import type {
  BundleHost,
  CommandContribution,
  CollectionName,
  Disposable,
  DocumentMeta,
  EditContextContribution,
  ElementId,
  ElementGeometryItem,
  KeybindingContribution,
  MainToWorkerKind,
  Mutation,
  ObjectTypeContribution,
  OverlayContribution,
  PagedBundle,
  PagedEditor,
  PanelContribution,
  PathAnchorsResult,
  PluginManifest,
  SchemaPanelContribution,
  SelectionMode,
  ToolContribution,
  ToolPreviewShape,
  WorkerToMain,
} from "@paged-media/plugin-api";

import {
  createBundleHost,
  type CreateBundleHostOptions,
} from "./host-impl";
import { satisfiesApiVersion, API_VERSION } from "./version";
import {
  loadHeadlessEngine,
  type HeadlessCanvasWorker,
  type LoadHeadlessEngineOptions,
} from "./wasm-loader";

/** One captured contribution — the assertable conformance log entry.
 *  `kind` is the surface; `value` is the contribution object verbatim
 *  (so a test can assert ids, titles, shortcuts, dock edges, …). */
export interface RecordedContribution {
  kind:
    | "tool"
    | "panel"
    | "schemaPanel"
    | "command"
    | "keybinding"
    | "overlay"
    | "editContext"
    | "objectType";
  id: string;
  value:
    | ToolContribution
    | PanelContribution
    | SchemaPanelContribution
    | CommandContribution
    | KeybindingContribution
    | OverlayContribution
    | EditContextContribution
    | ObjectTypeContribution;
}

export interface HarnessOptions
  extends LoadHeadlessEngineOptions,
    Pick<CreateBundleHostOptions, "console" | "storage" | "capabilityMode"> {}

/** What `createHeadlessHost` resolves to: a real engine-backed host plus
 *  the conformance affordances (load an IDML, read the contribution log,
 *  load a bundle, dispose honestly). */
export interface HeadlessHost {
  /** The BundleHost a bundle's `activate(host)` receives. */
  readonly host: BundleHost;
  /** The booted package version (`0.<protocol>.<patch>`). */
  readonly engineVersion: string;
  /** The wasm's reported protocol (the package minor). */
  readonly protocolVersion: number;
  /** Every contribution registered through `host.contribute.*`, in
   *  registration order. Cleared structurally on dispose. */
  readonly contributions: readonly RecordedContribution[];
  /** Contributions of one surface (e.g. `tools()` for the rail). */
  toolsContributed(): ToolContribution[];
  panelsContributed(): PanelContribution[];
  /** Declarative (schema) panels registered through
   *  `contribute.schemaPanel` — the W3.1 surface, recorded verbatim. */
  schemaPanelsContributed(): SchemaPanelContribution[];
  /** Edit contexts registered through `contribute.editContext` — the
   *  W3.2 surface (B-02), recorded verbatim (matcher fn included). */
  editContextsContributed(): EditContextContribution[];
  /** Object types registered through `contribute.objectType` — the W3.2
   *  surface (W-03), recorded verbatim. */
  objectTypesContributed(): ObjectTypeContribution[];
  /** Load an IDML package into the headless document. Resolves to the
   *  loaded page ids (or throws on a parse failure). */
  load(idml: Uint8Array): Promise<string[]>;
  /** Activate a bundle against this host (apiVersion-negotiated). The
   *  returned disposer runs the bundle's teardown; the host's own
   *  facade teardown runs on `dispose()`. */
  loadBundle(bundle: PagedBundle): Disposable;
  /** Tear down: bundle teardown + facade teardown + free the wasm. The
   *  honesty contract — after dispose the contribution log is empty and
   *  the engine handle is released. */
  dispose(): void;
}

/** Reserved alias kept for source/back-compat — see `createHeadlessHost`. */
export type HeadlessHostHandle = HeadlessHost;

let seqCounter = 1;

/**
 * Build a `PagedEditor` over the wasm `CanvasWorker`. The engine
 * `handleMessage` is SYNCHRONOUS (JSON in, JSON reply out, seq-matched);
 * the client contract is async, so each call wraps the synchronous reply
 * in a resolved promise. Subscriptions: the headless engine has no
 * unsolicited push channel, so `subscribe` listeners are driven by the
 * adapter itself — it fans out the reply of every `mutate/undo/redo` and
 * `setElementSelection` to subscribers (the same envelopes the editor
 * worker would post back), which is what `document.onDidChange` /
 * `selection.onDidChange` consume.
 */
function makeEngineEditor(
  worker: HeadlessCanvasWorker,
  recorder: RecordedContribution[],
): PagedEditor {
  const protocol = worker.protocolVersion;
  const listeners = new Set<(msg: WorkerToMain) => void>();

  const fanOut = (reply: WorkerToMain): void => {
    for (const l of listeners) l(reply);
  };

  /** Send one JSON envelope through the engine and parse the reply. */
  const dispatch = (kind: string, payload?: unknown): WorkerToMain => {
    const envelope = JSON.stringify(
      payload === undefined
        ? { seq: seqCounter++, protocol, kind }
        : { seq: seqCounter++, protocol, kind, payload },
    );
    const raw = worker.handleMessage(envelope);
    return JSON.parse(raw) as WorkerToMain;
  };

  const recordingRegistry = <
    T extends Extract<RecordedContribution["value"], { id: string }>,
    K extends Exclude<RecordedContribution["kind"], "keybinding">,
  >(
    kind: K,
  ) => ({
    register(contribution: T): Disposable {
      const entry: RecordedContribution = {
        kind,
        id: contribution.id,
        value: contribution,
      };
      recorder.push(entry);
      return {
        dispose() {
          const i = recorder.indexOf(entry);
          if (i >= 0) recorder.splice(i, 1);
        },
      };
    },
  });

  // Keybindings register without a stable id in the real shell; synthesize
  // one for the log so teardown can target it.
  let keybindingSeq = 0;
  const keybindingRegistry = {
    register(contribution: KeybindingContribution): Disposable {
      const entry: RecordedContribution = {
        kind: "keybinding",
        id: `${contribution.command}#${keybindingSeq++}`,
        value: contribution,
      };
      recorder.push(entry);
      return {
        dispose() {
          const i = recorder.indexOf(entry);
          if (i >= 0) recorder.splice(i, 1);
        },
      };
    },
  };

  let elementSelection: ElementId[] = [];
  let toolPreview: ToolPreviewShape | null = null;

  const client: PagedEditor["client"] = {
    async mutate(mutation: Mutation): Promise<WorkerToMain> {
      const reply = dispatch("mutate", mutation);
      fanOut(reply);
      return reply;
    },
    async undo(): Promise<WorkerToMain> {
      const reply = dispatch("undo");
      fanOut(reply);
      return reply;
    },
    async redo(): Promise<WorkerToMain> {
      const reply = dispatch("redo");
      fanOut(reply);
      return reply;
    },
    async collection<T>(name: CollectionName): Promise<readonly T[]> {
      const reply = dispatch("requestCollection", { name });
      if (reply.kind === "collectionReply") {
        const items = (reply.payload as { items: unknown }).items;
        return Array.isArray(items) ? (items as T[]) : [];
      }
      return [];
    },
    async documentMeta(): Promise<DocumentMeta> {
      const reply = dispatch("requestDocumentMeta");
      if (reply.kind === "documentMetaReply") {
        return reply.payload.meta;
      }
      throw new Error(`unexpected reply: ${reply.kind}`);
    },
    async pathAnchors(id: ElementId): Promise<PathAnchorsResult | null> {
      const reply = dispatch("requestPathAnchors", { id });
      if (reply.kind === "pathAnchors") {
        return reply.payload.result;
      }
      return null;
    },
    async elementGeometry(ids: ElementId[]): Promise<ElementGeometryItem[]> {
      const reply = dispatch("requestElementGeometry", { ids });
      if (reply.kind === "elementGeometry") {
        return (reply.payload as { items: ElementGeometryItem[] }).items;
      }
      return [];
    },
    async setElementSelection(
      ids: ElementId[],
      mode: SelectionMode,
    ): Promise<ElementId[]> {
      const reply = dispatch("setElementSelection", { ids, mode });
      if (reply.kind === "elementSelectionApplied") {
        fanOut(reply);
        return reply.payload.ids;
      }
      throw new Error(`unexpected reply: ${reply.kind}`);
    },
    async send(message: MainToWorkerKind): Promise<WorkerToMain> {
      const m = message as { kind: string; payload?: unknown };
      const reply = dispatch(m.kind, m.payload);
      // hitTest / requestSceneTree / requestElementProperties are pure
      // reads; no fan-out (they aren't change events).
      return reply;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const editor: PagedEditor = {
    client,
    registries: {
      tools: recordingRegistry<ToolContribution, "tool">("tool"),
      panels: recordingRegistry<PanelContribution, "panel">("panel"),
      commands: recordingRegistry<CommandContribution, "command">("command"),
      keybindings: keybindingRegistry,
      overlays: recordingRegistry<OverlayContribution, "overlay">("overlay"),
    },
    selection: {
      get elementSelection() {
        return elementSelection;
      },
      setElementSelection(ids: ElementId[]) {
        elementSelection = ids;
      },
      setElementGeometry() {
        /* no overlay layer headlessly */
      },
    },
    camera: { camera: { scale: 1, tx: 0, ty: 0 } },
    overlaySignals: {
      setToolPreview(value: ToolPreviewShape | null) {
        toolPreview = value;
        void toolPreview; // recorded but inert (no overlay surface)
      },
    },
    // No tool spine + no content caret headlessly — both are inert
    // members of the narrow handle, present so the cast is total.
    tool: {
      setBaseTool() {
        /* no rail headlessly */
      },
    },
    contentSelection: { contentSelection: null },
  };

  return editor;
}

/**
 * Build a headless, engine-backed `BundleHost`. Async because booting
 * the wasm is async. The returned handle drives the conformance loop:
 * load an IDML, activate a bundle, assert its contribution log, run real
 * mutations, and dispose honestly.
 *
 * Resolves B-13 (RESOLVED + residuals — see module header). Replaces the
 * v0 throw: the harness now stands on a real engine, so a bundle can no
 * longer "pass against fiction".
 */
export async function createHeadlessHost(
  options: HarnessOptions = {},
): Promise<HeadlessHost> {
  const engine = await loadHeadlessEngine(options);
  const worker = engine.worker;
  const contributions: RecordedContribution[] = [];
  const editor = makeEngineEditor(worker, contributions);

  // A placeholder manifest until a bundle is loaded; `loadBundle`
  // rebuilds the host bound to the bundle's own manifest so the
  // namespace rule + metadata key derive correctly.
  let active: { dispose(): void } | null = null;
  let currentHost: BundleHost | null = null;
  let disposed = false;

  // The NEUTRAL driver host runs PERMISSIVE ('warn'): it is the test
  // driver that registers arbitrary contributions + drives every door
  // directly, not a subject of the capability gate. A LOADED bundle is
  // the subject — it gets the option's mode (default 'enforce'), so
  // conformance proves the bundle's manifest declarations are complete.
  const buildHost = (
    manifest: PluginManifest,
    mode: CreateBundleHostOptions["capabilityMode"],
  ) =>
    createBundleHost(() => editor, manifest, {
      console: options.console,
      storage: options.storage,
      capabilityMode: mode,
      // Record the SCHEMA verbatim at registration — the panel registry
      // only ever sees the synthesized React panel, so the conformance
      // log gets the schema through this adapter seam (no host renderer
      // headlessly; visibility/enabled gates are asserted off `bindings`
      // directly, not through a mounted UI).
      onSchemaPanelRegistered: (c) => {
        const entry: RecordedContribution = {
          kind: "schemaPanel",
          id: c.id,
          value: c,
        };
        contributions.push(entry);
        return {
          dispose() {
            const i = contributions.indexOf(entry);
            if (i >= 0) contributions.splice(i, 1);
          },
        };
      },
      // W3.2 — the editContext/objectType registries are not wired
      // headlessly (no shell stack / chrome), so the adapter takes the
      // recording-stub path and these hooks ARE the registration log.
      onEditContextRegistered: (c) => {
        const entry: RecordedContribution = {
          kind: "editContext",
          id: c.type,
          value: c,
        };
        contributions.push(entry);
        return {
          dispose() {
            const i = contributions.indexOf(entry);
            if (i >= 0) contributions.splice(i, 1);
          },
        };
      },
      onObjectTypeRegistered: (c) => {
        const entry: RecordedContribution = {
          kind: "objectType",
          id: c.type,
          value: c,
        };
        contributions.push(entry);
        return {
          dispose() {
            const i = contributions.indexOf(entry);
            if (i >= 0) contributions.splice(i, 1);
          },
        };
      },
    });

  // Eager neutral host so `host` is available before a bundle is loaded
  // (tests that drive document/selection doors directly, without a
  // bundle, e.g. metadata-gate coverage). Uses a neutral harness id.
  // The neutral manifest declares BROAD capabilities: the conformance
  // host must be able to drive every document/render door directly
  // (the capability gate is enforced from a loaded BUNDLE's manifest,
  // which is what conformance asserts — the neutral host is the test
  // driver, not the subject).
  const NEUTRAL: PluginManifest = {
    id: "media.paged.harness",
    name: "harness",
    version: "0.0.0",
    apiVersion: `^${API_VERSION.slice(0, 3)}`,
    capabilities: {
      document: { read: "broad", write: "broad" },
      rendering: ["overlay", "hitTest"],
      keybindings: true,
    },
    // Broad contribution declarations so the neutral DRIVER host (which
    // registers arbitrary contributions directly in 'warn' mode) never
    // trips the capability gate. A loaded BUNDLE is the subject — its
    // OWN manifest is enforced.
    contributes: {
      editContexts: [
        { type: "vectorGraphic", entry: "doubleClick" },
        { type: "webFrame", entry: "doubleClick" },
      ],
      objectTypes: [{ type: "webFrame", bakedFallback: "rectangle" }],
    },
  };
  let { host, dispose: disposeHostFacades } = buildHost(NEUTRAL, "warn");
  currentHost = host;

  const headless: HeadlessHost = {
    get host() {
      return currentHost!;
    },
    engineVersion: engine.version,
    protocolVersion: engine.protocolVersion,
    contributions,
    toolsContributed() {
      return contributions
        .filter((c) => c.kind === "tool")
        .map((c) => c.value as ToolContribution);
    },
    panelsContributed() {
      return contributions
        .filter((c) => c.kind === "panel")
        .map((c) => c.value as PanelContribution);
    },
    schemaPanelsContributed() {
      return contributions
        .filter((c) => c.kind === "schemaPanel")
        .map((c) => c.value as SchemaPanelContribution);
    },
    editContextsContributed() {
      return contributions
        .filter((c) => c.kind === "editContext")
        .map((c) => c.value as EditContextContribution);
    },
    objectTypesContributed() {
      return contributions
        .filter((c) => c.kind === "objectType")
        .map((c) => c.value as ObjectTypeContribution);
    },
    async load(idml: Uint8Array): Promise<string[]> {
      const raw = worker.loadDocumentDirect(seqCounter++, idml);
      const reply = JSON.parse(raw) as WorkerToMain;
      if (reply.kind === "documentLoaded") {
        // Mirror the worker's post-load resolve step (anchors/page
        // numbers); ignored result, but it primes the same engine state.
        try {
          worker.runResolveJson();
        } catch {
          /* resolve is best-effort */
        }
        return reply.payload.pageIds;
      }
      const errKind =
        reply.kind === "loadFailed" ? reply.payload.error.kind : reply.kind;
      throw new Error(`headless load failed (${reply.kind}: ${errKind})`);
    },
    loadBundle(bundle: PagedBundle): Disposable {
      if (active) {
        throw new Error(
          "headless host: a bundle is already loaded — dispose it first " +
            "(one bundle per headless host in v1)",
        );
      }
      const { manifest } = bundle;
      if (!satisfiesApiVersion(manifest.apiVersion)) {
        throw new Error(
          `headless host: ${manifest.id}@${manifest.version} requires ` +
            `plugin-api "${manifest.apiVersion}", host implements ${API_VERSION}`,
        );
      }
      // Re-bind the host to the bundle's manifest so the namespace rule
      // and the `x-paged:<id>` metadata key derive from the real id.
      // The bundle is the capability subject — enforce its declarations
      // (default), so conformance catches an undeclared-use bundle.
      disposeHostFacades();
      ({ host, dispose: disposeHostFacades } = buildHost(
        manifest,
        options.capabilityMode ?? "enforce",
      ));
      currentHost = host;
      const handle = bundle.activate(host);
      let bundleActive = true;
      active = {
        dispose() {
          if (!bundleActive) return;
          bundleActive = false;
          try {
            handle.dispose();
          } finally {
            disposeHostFacades();
            // Re-arm a neutral host so the document doors stay usable.
            ({ host, dispose: disposeHostFacades } = buildHost(
              NEUTRAL,
              "warn",
            ));
            currentHost = host;
            active = null;
          }
        },
      };
      return { dispose: () => active?.dispose() };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (active) active.dispose();
        else disposeHostFacades();
      } finally {
        // Contribution log emptied structurally by facade teardown; free
        // the wasm so the handle is honestly released.
        contributions.length = 0;
        worker.free();
      }
    },
  };

  return headless;
}
