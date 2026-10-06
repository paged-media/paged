/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

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
  ToolSettingValue,
  WillSaveEvent,
  ClipboardPayload,
  CommandContribution,
  CollectionName,
  Disposable,
  DocumentMeta,
  EditContextContribution,
  ElementId,
  ElementGeometryItem,
  ExporterContribution,
  ImporterContribution,
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
  createBindingProviderRegistry,
  type BindingProviderBackend,
  type BlobStore,
  type ClipboardBackend,
  type DocumentsBackend,
  type SecretStoreBackend,
  type CreateBundleHostOptions,
  type ToolSettingsBackend,
  type WillSaveBackend,
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
    | "objectType"
    | "importer"
    | "exporter";
  id: string;
  value:
    | ToolContribution
    | PanelContribution
    | SchemaPanelContribution
    | CommandContribution
    | KeybindingContribution
    | OverlayContribution
    | EditContextContribution
    | ObjectTypeContribution
    | ImporterContribution
    | ExporterContribution;
}

export interface HarnessOptions
  extends LoadHeadlessEngineOptions,
    Pick<
      CreateBundleHostOptions,
      | "console"
      | "storage"
      | "capabilityMode"
      | "assetSource"
      | "blobStore"
      | "clipboard"
      | "secrets"
      | "bindingProviders"
      | "willSave"
      | "toolSettings"
    > {
  /** D-27 — back `host.text` with the ENGINE's shaper
   *  (`CanvasWorker.measureText`, the one the editor's worker calls)
   *  instead of the estimate, so `measureString` / `measureStrings`
   *  answer real widths against the loaded document's fonts and
   *  `supports("text.measure@1")` / `("text.measureStrings@1")` are true.
   *  Off by default: existing headless suites pinned the estimate. */
  engineShaper?: boolean;
  /** D-26 — the headless stand-in for the editor's keep/discard prompt.
   *  `host.documents.open` calls it ONLY when the active document has
   *  unsaved edits; resolve `false` to keep them (the door then answers
   *  `{ opened: false, reason: "declined" }`). Default: discard. */
  confirmReplace?: (request: {
    name: string | null;
    requester: { id: string; name: string };
  }) => boolean | Promise<boolean>;
  /** D-28 — the default font every load lays out with, the headless
   *  stand-in for the editor's `defaultFontProvider` (the editor passes
   *  `/fonts/Inter.ttf`). The engine lays text out, and reports a story
   *  `overset`, only when it has a font: without one nothing is laid out and
   *  every story reads `overset: false` (not measured). Passed to every
   *  load, `load()` and `host.documents.open` alike. Absent: no font, as
   *  before. */
  defaultFont?: Uint8Array;
}

/** A headless will-save registry: listeners register per plugin and
 *  `fire()` awaits them all, the way the editor's save path does — so a
 *  bundle's commit-before-save is assertable without an editor. */
export function inMemoryWillSave(): WillSaveBackend & {
  fire(): Promise<void>;
  count(): number;
} {
  const listeners = new Set<(e: WillSaveEvent) => Promise<void>>();
  return {
    register(_pluginId, listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    async fire() {
      await Promise.all([...listeners].map((l) => l({ format: "paged" })));
    },
    count: () => listeners.size,
  };
}

/** A headless tool-options store: what the editor's tool-options UI would
 *  hold, settable from a test with `set`. */
export function inMemoryToolSettings(): ToolSettingsBackend & {
  set(toolId: string, key: string, value: ToolSettingValue): void;
} {
  const values = new Map<string, Record<string, ToolSettingValue>>();
  const subs = new Map<string, Set<() => void>>();
  return {
    get: (toolId) => ({ ...(values.get(toolId) ?? {}) }),
    subscribe(toolId, listener) {
      const set = subs.get(toolId) ?? new Set();
      set.add(listener);
      subs.set(toolId, set);
      return () => void set.delete(listener);
    },
    set(toolId, key, value) {
      values.set(toolId, { ...(values.get(toolId) ?? {}), [key]: value });
      for (const l of subs.get(toolId) ?? []) l();
    },
  };
}

/** A headless in-memory `BlobStore` — per-plugin byte maps, so the
 *  conformance harness exercises `host.blob` (K-4 / S-08) without OPFS.
 *  Default-injected so `supports("storage.blob@1")` is true headlessly. */
export function inMemoryBlobStore(): BlobStore {
  const byPlugin = new Map<string, Map<string, Uint8Array>>();
  const dir = (id: string) => {
    let d = byPlugin.get(id);
    if (!d) byPlugin.set(id, (d = new Map()));
    return d;
  };
  return {
    async write(id, key, bytes) {
      dir(id).set(key, bytes.slice());
    },
    async read(id, key) {
      const v = dir(id).get(key);
      return v ? v.slice() : null;
    },
    async delete(id, key) {
      dir(id).delete(key);
    },
    async keys(id) {
      return Array.from(dir(id).keys());
    },
    async used(id) {
      let n = 0;
      for (const v of dir(id).values()) n += v.byteLength;
      return n;
    },
  };
}

/** A headless in-memory `ClipboardBackend` — a single shared payload slot,
 *  so the conformance harness exercises `host.clipboard` (K-6 / S-14)
 *  without a real system clipboard. Default-injected so
 *  `supports("clipboard@1")` is true headlessly. Round-trips the payload
 *  by value (a fresh object on read) so a consumer test can't mutate the
 *  stored copy. */
export function inMemoryClipboard(): ClipboardBackend {
  let slot: ClipboardPayload | null = null;
  return {
    async read() {
      if (!slot) return null;
      // Clone so the reader can't mutate the stored grid.
      return {
        ...(slot.text !== undefined ? { text: slot.text } : {}),
        ...(slot.tabular
          ? { tabular: { rows: slot.tabular.rows.map((r) => [...r]) } }
          : {}),
      };
    },
    async write(payload) {
      slot = {
        ...(payload.text !== undefined ? { text: payload.text } : {}),
        ...(payload.tabular
          ? { tabular: { rows: payload.tabular.rows.map((r) => [...r]) } }
          : {}),
      };
    },
  };
}

/** A headless in-memory `SecretStoreBackend` (D-11; rfc-credential-store) —
 *  per-plugin `ref→secret` maps, so the conformance harness exercises
 *  `host.secrets` set/exists/forget without a real keychain. Default-
 *  injected so `supports("secrets@1")` is true headlessly. It STORES the
 *  secret silently (no prompt) — the prompt is the EDITOR backing's job
 *  ("via host UI only"); a headless driver has no UI. Critically there is
 *  NO read-back path here either: the map is write-only from the door's
 *  perspective (`exists` is the only observation), upholding the no-`get`
 *  trust line even in the reference backing. */
export function inMemorySecretStore(): SecretStoreBackend {
  const byPlugin = new Map<string, Set<string>>();
  const dir = (id: string) => {
    let d = byPlugin.get(id);
    if (!d) byPlugin.set(id, (d = new Set()));
    return d;
  };
  return {
    async set(id, ref, _secret) {
      // The secret value is intentionally NOT retained by the harness —
      // only the fact that the ref is "held" — so a test can never recover
      // it (the no-get invariant, end to end).
      dir(id).add(ref);
    },
    async exists(id, ref) {
      return dir(id).has(ref);
    },
    async forget(id, ref) {
      dir(id).delete(ref);
    },
  };
}

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
  /** Document importers registered through `contribute.importer` (K-2 /
   *  S-06), recorded verbatim (extensions + the `import()` callback). */
  importersContributed(): ImporterContribution[];
  /** Document exporters registered through `contribute.exporter` (K-2 /
   *  S-06), recorded verbatim. */
  exportersContributed(): ExporterContribution[];
  /** The last tool preview a bundle pushed through
   *  `host.overlay.setToolPreview` (B-07). There is no overlay SURFACE
   *  headlessly, but the channel is RECORDED so conformance can assert a
   *  pen/anchor handler emits the cubic `ToolPreviewPath` variant (true
   *  Béziers) rather than a flattened polyline. `null` until set, and
   *  reset to `null` when the bundle clears its preview. */
  lastToolPreview(): ToolPreviewShape | null;
  /** K-9 — the last LIST a bundle pushed through
   *  `host.overlay.setToolPreviews`, or `null` when it cleared / never
   *  used the multi-shape door. The harness wires the multi-shape sink,
   *  so `supports("overlay.multiPreview@1")` is true headlessly and a
   *  bundle's "geometry AND label at once" claim is assertable without a
   *  browser. `lastToolPreview()` tracks the list's FIRST shape. */
  lastToolPreviews(): readonly ToolPreviewShape[] | null;
  /** ADR-023 phase A — the SHARED binding-provider registry this host
   *  injected. It is the HOST side of the seam, so a conformance test
   *  plays the part the editor's shared panel plays in phase C: enter
   *  the bundle's edit context, then `readProperty` / `readCollection` /
   *  `applyMutation` through here and assert the bundle answered (and
   *  that a path it does not declare comes back as a typed refusal to
   *  fall through to core). */
  readonly bindingProviders: BindingProviderBackend;
  /** The will-save registry this host injected: `fire()` runs every
   *  bundle's `document.onWillSave` listener and awaits them, as a save
   *  would. */
  readonly willSave: ReturnType<typeof inMemoryWillSave>;
  /** The tool-options store this host injected: `set()` stands in for the
   *  editor's tool-options UI, and `host.tools` reads it back. */
  readonly toolSettings: ReturnType<typeof inMemoryToolSettings>;
  /** Load an IDML package into the headless document. Resolves to the
   *  loaded page ids (or throws on a parse failure). */
  load(idml: Uint8Array): Promise<string[]>;
  /** D-26 — every document a bundle opened through `host.documents.open`,
   *  in order (declined opens are not listed). */
  openedDocuments(): ReadonlyArray<{
    name: string | null;
    requester: string;
    pageIds: string[];
  }>;
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
  onToolPreview: (value: ToolPreviewShape | null) => void,
  onToolPreviews: (value: readonly ToolPreviewShape[] | null) => void,
  engineShaper = false,
): { editor: PagedEditor; fanOut: (reply: WorkerToMain) => void } {
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
  let toolPreviews: readonly ToolPreviewShape[] | null = null;

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
      importers: recordingRegistry<ImporterContribution, "importer">("importer"),
      exporters: recordingRegistry<ExporterContribution, "exporter">("exporter"),
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
        // No overlay SURFACE headlessly, but the channel is RECORDED so
        // conformance can assert the cubic ToolPreviewPath variant (B-07).
        onToolPreview(toolPreview);
      },
      // K-9 — the MULTI-shape sink. Wiring it headlessly is what makes
      // `supports("overlay.multiPreview@1")` true in the harness, so a
      // bundle's "geometry AND label at once" claim is conformance-
      // assertable without a browser. One slot: the list also updates
      // `lastToolPreview()` (to its first shape) so an older assertion
      // still reads something true rather than a stale value.
      setToolPreviews(value: readonly ToolPreviewShape[] | null) {
        toolPreviews = value && value.length > 0 ? value : null;
        toolPreview = toolPreviews ? toolPreviews[0] : null;
        onToolPreviews(toolPreviews);
        onToolPreview(toolPreview);
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

  // D-27 — the engine shaper, opt-in (HarnessOptions.engineShaper). The
  // same `CanvasWorker.measureText` the editor's worker serves; a null
  // answer (no document / unresolved face) is zeroed like the editor's.
  const measureText = worker.measureText?.bind(worker);
  if (engineShaper && measureText) {
    const zero = { advance: 0, ascender: 0, descender: 0 };
    const one = (family: string, style: string | null, t: string, sizePt: number) => {
      const m = measureText(family, style, t, sizePt);
      return m ? { advance: m.advance, ascender: m.ascender, descender: m.descender } : zero;
    };
    editor.text = {
      async measure(family, style, t, sizePt) {
        return one(family, style, t, sizePt);
      },
      async measureMany(family, style, texts, sizePt) {
        return texts.map((t) => one(family, style, t, sizePt));
      },
    };
  }

  return { editor, fanOut };
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
  // Last preview pushed through `overlay.setToolPreview` — recorded so
  // a bundle's pen/anchor handler can be asserted to emit the cubic
  // `ToolPreviewPath` variant rather than a flattened polyline (B-07).
  let lastPreview: ToolPreviewShape | null = null;
  // K-9 — the LIST a bundle pushed through `overlay.setToolPreviews`.
  let lastPreviews: readonly ToolPreviewShape[] | null = null;
  const { editor, fanOut } = makeEngineEditor(
    worker,
    contributions,
    (value) => {
      lastPreview = value;
    },
    (value) => {
      lastPreviews = value;
    },
    options.engineShaper === true,
  );

  /** Load bytes into the engine; the raw reply (documentLoaded or not). */
  const loadDirect = (bytes: Uint8Array): WorkerToMain => {
    const reply = JSON.parse(
      options.defaultFont
        ? worker.loadDocumentDirect(seqCounter++, bytes, options.defaultFont)
        : worker.loadDocumentDirect(seqCounter++, bytes),
    ) as WorkerToMain;
    if (reply.kind === "documentLoaded") {
      try {
        worker.runResolveJson();
      } catch {
        /* resolve is best-effort */
      }
    }
    return reply;
  };
  const loadFailure = (reply: WorkerToMain): Error => {
    const errKind =
      reply.kind === "loadFailed" ? reply.payload.error.kind : reply.kind;
    return new Error(`headless load failed (${reply.kind}: ${errKind})`);
  };

  // D-26 — the headless documents backend: exportPaged through the engine,
  // open = the keep/discard decision (only when dirty) + a direct load whose
  // `documentLoaded` reply is FANNED OUT to subscribers, as the editor's
  // client broadcasts it (a bundle that resets on a document switch sees
  // this one too).
  const opened: Array<{ name: string | null; requester: string; pageIds: string[] }> = [];
  const documentsBackend: DocumentsBackend = {
    async exportPaged() {
      const reply = await editor.client.send({ kind: "exportPaged", payload: {} });
      if (reply.kind === "pagedExported") return Uint8Array.from(reply.payload.bytes);
      if (reply.kind === "pagedPartFailed") throw new Error(reply.payload.error);
      throw new Error(`unexpected reply: ${reply.kind}`);
    },
    async open(bytes, request) {
      let dirty = false;
      try {
        dirty = (await editor.client.documentMeta()).dirty;
      } catch {
        dirty = false; // no document: nothing to lose
      }
      if (dirty && options.confirmReplace && !(await options.confirmReplace(request))) {
        return { opened: false, reason: "declined" };
      }
      const reply = loadDirect(bytes);
      if (reply.kind !== "documentLoaded") throw loadFailure(reply);
      fanOut(reply);
      opened.push({
        name: request.name,
        requester: request.requester.id,
        pageIds: reply.payload.pageIds,
      });
      return { opened: true, pageIds: reply.payload.pageIds };
    },
  };

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
  // One in-memory blob store shared across the harness's hosts (so a
  // reloaded bundle sees its own persisted bytes — K-4 / S-08), unless a
  // test injects its own.
  const blobStore = options.blobStore ?? inMemoryBlobStore();
  // One in-memory clipboard shared across the harness's hosts (K-6 / S-14),
  // unless a test injects its own — so a consumer's copy→paste round-trips
  // headlessly and `supports("clipboard@1")` is true.
  const clipboard = options.clipboard ?? inMemoryClipboard();
  // One in-memory credential store shared across the harness's hosts (D-11),
  // unless a test injects its own — so a bundle's set→exists→forget door is
  // exercisable headlessly and `supports("secrets@1")` is true. Reference-
  // only: the value is never retained (the no-get trust line, end to end).
  const secrets = options.secrets ?? inMemorySecretStore();
  // ONE shared binding-provider registry across the harness's hosts
  // (ADR-023 phase A), unless a test injects its own — so a bundle's
  // provider registration, its context-driven activation, and the host-
  // side resolution are all exercisable headlessly and
  // `supports("bindings.provider@1")` is true. It has to be shared for
  // the same reason the editor shares one: resolution is CROSS-bundle.
  const bindingProviders =
    options.bindingProviders ?? createBindingProviderRegistry();
  // Protocol 66 batch — the save hook and the tool-options store, shared
  // across the harness's hosts like the stores above. A test-injected
  // backend replaces the in-memory one but loses `fire` / `set`, so the
  // handle always exposes the in-memory pair it can drive.
  const willSave = inMemoryWillSave();
  const toolSettings = inMemoryToolSettings();

  const buildHost = (
    manifest: PluginManifest,
    mode: CreateBundleHostOptions["capabilityMode"],
  ) =>
    createBundleHost(() => editor, manifest, {
      console: options.console,
      storage: options.storage,
      blobStore,
      clipboard,
      secrets,
      bindingProviders,
      willSave: options.willSave ?? willSave,
      toolSettings: options.toolSettings ?? toolSettings,
      capabilityMode: mode,
      // W-06 — a recordable fake asset source the conformance harness
      // can pass so a bundle's `@font-face` byte path is exercisable
      // headlessly (the editor's real adapter currently serves null;
      // DESIGN.md §13.4). Absent → the no-bytes door.
      assetSource: options.assetSource,
      documents: documentsBackend,
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
      rendering: ["overlay", "hitTest", "sceneLayer"],
      keybindings: true,
      storage: { blob: true },
      secrets: { sources: true },
      documents: { export: true, open: true },
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
      importers: ["media.paged.harness.importer.xlsx"],
      exporters: ["media.paged.harness.exporter.xlsx"],
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
    importersContributed() {
      return contributions
        .filter((c) => c.kind === "importer")
        .map((c) => c.value as ImporterContribution);
    },
    exportersContributed() {
      return contributions
        .filter((c) => c.kind === "exporter")
        .map((c) => c.value as ExporterContribution);
    },
    lastToolPreview() {
      return lastPreview;
    },
    lastToolPreviews() {
      return lastPreviews;
    },
    bindingProviders,
    willSave,
    toolSettings,
    async load(idml: Uint8Array): Promise<string[]> {
      // loadDirect mirrors the worker's post-load resolve step.
      const reply = loadDirect(idml);
      if (reply.kind === "documentLoaded") return reply.payload.pageIds;
      throw loadFailure(reply);
    },
    openedDocuments() {
      return opened;
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
        lastPreview = null;
        worker.free();
      }
    },
  };

  return headless;
}
