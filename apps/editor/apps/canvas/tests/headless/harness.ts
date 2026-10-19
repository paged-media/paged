/*
 * This file is part of paged (https://paged.media).
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

// THE HEADLESS EDITOR (test layer 3): the editor's shell + client + the
// real canvas-wasm engine under `bun test`, with no browser.
//
//   real   the engine (canvas-wasm, one module per process, a fresh engine
//          per editor), the client (`CanvasClient`, driving an in-process
//          render worker that mirrors worker.ts message for message), the
//          shell registries (`createShellRegistries`), the app's command
//          sets with their real runners (registered as main.tsx registers
//          them), the app's object registry (`host.objects` / `editor.get`
//          / Boa `paged.invoke`), the `editor.*` / `demo.*` automation
//          (`buildAutomation`), Boa `paged.*` scripts (with the host bridge
//          armed), plugin hosts (`createBundleHost`), the editor's default
//          font (Inter, roman + italic) on every load.
//   stand-in  the shell's React state contexts (document, selection,
//          camera, tool, content selection, tool settings, screen mode,
//          overlay signals) are plain objects with the same members, so a
//          handler that reads or writes them behaves as under React;
//          nothing renders. The camera is fixed (scale 1, a 1200 × 800
//          viewport) unless a test sets it.
//   off    painting (no canvas, no tiles, no GPU), panels' React trees,
//          dialogs (the typed-command dialog, file pickers, the
//          assistant) — a command whose handler opens one is reachable
//          but its dialog never appears; `opened` records what it asked for.
//
// Usage:
//   const ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
//   await ed.select([GESTURE_TARGETS.frame.id]);
//   await ed.invoke("paged.object.delete");
//   expect(ed.problems()).toEqual([]);
//   const after = await ed.dump();        // canonical model JSON (test-kit)
//   await ed.dispose();
//
// One editor per test (each is a fresh engine; the wasm module is shared),
// or one per file with `ed.load(bytes)` between tests.

import {
  buildAutomation,
  buildExportAseCommand,
  buildExportPdfCommand,
  buildImportAseCommand,
  buildNewDocumentCommand,
  buildNewFromBriefCommand,
  createShellRegistries,
  runDemoScript,
  AI_ASK_COMMAND,
  openAssistant,
  setAssistantOpener,
  type CanvasHandleLike,
  type DemoGlobals,
  type PagedEditor,
  type RunResult,
  type ShellRegistries,
} from "@paged-media/shell";
import {
  CanvasClient,
  GestureBuffer,
  type DocumentHandle,
  type ElementId,
  type MainToWorkerKind,
  type WorkerToMain,
} from "@paged-media/client";
import {
  createBundleHost,
  createBindingProviderRegistry,
  createDataProviderRegistry,
  loadBundle as sdkLoadBundle,
  type CreateBundleHostOptions,
} from "@paged-media/plugin-sdk";
import type {
  BundleHost,
  PagedBundle,
  PagedEditor as ContractEditor,
  PluginManifest,
} from "@paged-media/plugin-api";
import {
  canonicalJson,
  createEngineWorker,
  headlessEngineModule,
  modelDump,
  type EngineWorker,
  type ModelDump,
  type ModelDumpOptions,
} from "@paged-media/test-kit";

import {
  buildAppCommands,
  APP_KEYBINDINGS,
  APP_MENU_ITEMS,
} from "../../src/app-commands";
import {
  arrangeSelection,
  buildObjectCommands,
  deleteSelection,
  groupSelection,
  makeClippingMask,
  nudgeSelection,
  releaseClippingMask,
  selectParentGroup,
  ungroupSelection,
  OBJECT_DIAGNOSTIC_SOURCE,
  OBJECT_KEYBINDINGS,
  OBJECT_MENU_ITEMS,
  type ObjectCommandDeps,
} from "../../src/object-commands";
import {
  addPage,
  buildInsertCommands,
  deleteCurrentPage,
  insertEllipse,
  insertLine,
  insertRectangle,
  insertTable,
  insertTextFrame,
  placeImage,
  INSERT_DIAGNOSTIC_SOURCE,
  INSERT_KEYBINDINGS,
  INSERT_MENU_ITEMS,
  type InsertReport,
} from "../../src/insert-commands";
import {
  SELECT_ALL_COMMAND,
  SELECT_ALL_KEYBINDINGS,
  SELECT_ALL_MENU_ITEM,
} from "../../src/select-all";
import {
  buildCoreCommandEntries,
  CORE_COMMAND_MENU_ITEMS,
} from "../../src/core-command-entries";
import { invokeCoreCommand } from "../../src/core-command-dialog";
import {
  GLOBAL_LIGHT_COMMANDS,
  GLOBAL_LIGHT_MENU_ITEMS,
} from "../../src/panels/global-light-dialog";
import { COCKPIT_MENU_SEAMS } from "../../src/cockpit-menus";
import {
  ALIGN_ARGS,
  ALIGN_COMMAND,
  runAlign,
  type AlignKind,
} from "../../src/align-plan";
import { objectRegistry, setObjectModelEditor } from "../../src/object-model";
import {
  getProblemsSnapshot,
  problemsSink,
  resetProblems,
  type ProblemEntry,
} from "../../src/panels/problems-store";

// ------------------------------------------------------------------ fonts

const FONT_DIR = new URL("../../public/fonts/", import.meta.url);
let fontCache: Promise<{ roman: Uint8Array; italic: Uint8Array }> | null = null;
/** The editor's default family (public/fonts, what `fetchDefaultFont` /
 *  `fetchDefaultFontFaces` serve in the browser). */
function editorFonts() {
  fontCache ??= (async () => ({
    roman: new Uint8Array(
      await Bun.file(new URL("Inter.ttf", FONT_DIR)).arrayBuffer(),
    ),
    italic: new Uint8Array(
      await Bun.file(new URL("Inter-Italic.ttf", FONT_DIR)).arrayBuffer(),
    ),
  }))();
  return fontCache;
}

// --------------------------------------------------------- state stand-ins

type Camera = { scale: number; tx: number; ty: number };

/** A slice whose `setX(v)` stores `x` and whose unknown reads are null —
 *  for the overlay signals, which the commands only ever publish into. */
function recordingSlice(seed: Record<string, unknown> = {}) {
  const fields: Record<string, unknown> = { ...seed };
  return new Proxy(fields, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return target[prop];
      if (/^set[A-Z]/.test(prop)) {
        const key = prop[3].toLowerCase() + prop.slice(4);
        return (value: unknown) => {
          target[key] = value;
        };
      }
      return null;
    },
  });
}

/** What the headless editor holds in place of the shell's React state. */
export interface HeadlessState {
  document: {
    handle: DocumentHandle | null;
    setHandle(h: DocumentHandle | null): void;
    sourceName: string | null;
    setSourceName(n: string | null): void;
    loading: unknown;
    setLoading(l: unknown): void;
    snapshots: Map<string, string>;
    setSnapshots(
      next:
        Map<string, string> | ((m: Map<string, string>) => Map<string, string>),
    ): void;
    snapshotsReady: boolean;
    setSnapshotsReady(r: boolean): void;
    resolution: unknown;
    setResolution(r: unknown): void;
    resetForNewDocument(): void;
  };
  selection: {
    elementSelection: ElementId[];
    setElementSelection(ids: ElementId[]): void;
    elementGeometry: unknown[];
    setElementGeometry(items: unknown[]): void;
    activeGroup: string | null;
    setActiveGroup(id: string | null): void;
    [key: string]: unknown;
  };
  camera: {
    camera: Camera;
    setCamera(c: Camera): void;
    viewportSize: [number, number];
    setViewportSize(s: [number, number]): void;
  };
  tool: {
    toolState: { base: string; overrides: string[] };
    effectiveTool: string;
    lastReason: string;
    setBaseTool(id: string): void;
    pushOverride(id: string): void;
    popOverride(id: string): void;
    clearOverrides(): void;
    toolStateRef: { current: { base: string; overrides: string[] } };
  };
  contentSelection: {
    contentSelection: { storyId: string; start: number; end: number } | null;
    setContentSelection(
      s: { storyId: string; start: number; end: number } | null,
    ): void;
    caret: unknown;
    setCaret(c: unknown): void;
    selectionRects: unknown[];
    setSelectionRects(r: unknown[]): void;
    contentSelectionRef: { current: unknown };
  };
  toolSettings: {
    get(toolId: string): Record<string, unknown>;
    getValue(toolId: string, key: string): unknown;
    set(toolId: string, key: string, value: unknown): void;
    subscribe(toolId: string, listener: () => void): () => void;
  };
  screenMode: {
    screenMode: string;
    setScreenMode(m: string): void;
    togglePreview(): void;
  };
  overlaySignals: Record<string, unknown>;
  /** ADR 024 — the edit context the user is inside (`null`: the document
   *  root). Set it to drive a command "inside a plugin content type". */
  editContext: { type: string; [key: string]: unknown } | null;
}

function headlessState(): HeadlessState {
  const doc: HeadlessState["document"] = {
    handle: null,
    setHandle(h) {
      doc.handle = h;
    },
    sourceName: null,
    setSourceName(n) {
      doc.sourceName = n;
    },
    loading: null,
    setLoading(l) {
      doc.loading = l;
    },
    snapshots: new Map(),
    setSnapshots(next) {
      doc.snapshots = typeof next === "function" ? next(doc.snapshots) : next;
    },
    snapshotsReady: false,
    setSnapshotsReady(r) {
      doc.snapshotsReady = r;
    },
    resolution: null,
    setResolution(r) {
      doc.resolution = r;
    },
    resetForNewDocument() {
      doc.snapshots = new Map();
      doc.snapshotsReady = false;
      doc.resolution = null;
      selection.elementSelection = [];
      selection.elementGeometry = [];
    },
  };
  const selection = recordingSlice({
    elementSelection: [],
    elementGeometry: [],
    placedGeometry: [],
    activeTool: "select",
    pathEditMode: false,
    selectedAnchors: [],
    selectedAnchorIndex: null,
    pathEditSession: null,
    activeGroup: null,
  }) as unknown as HeadlessState["selection"];
  const camera: HeadlessState["camera"] = {
    camera: { scale: 1, tx: 0, ty: 0 },
    setCamera(c) {
      camera.camera = c;
    },
    viewportSize: [1200, 800],
    setViewportSize(s) {
      camera.viewportSize = s;
    },
  };
  const toolStateRef = {
    current: { base: "select", overrides: [] as string[] },
  };
  const tool: HeadlessState["tool"] = {
    get toolState() {
      return toolStateRef.current;
    },
    get effectiveTool() {
      const o = toolStateRef.current.overrides;
      return o.length > 0 ? o[o.length - 1] : toolStateRef.current.base;
    },
    lastReason: "init",
    setBaseTool(id) {
      toolStateRef.current = { base: id, overrides: [] };
      tool.lastReason = "base";
    },
    pushOverride(id) {
      toolStateRef.current = {
        ...toolStateRef.current,
        overrides: [...toolStateRef.current.overrides, id],
      };
    },
    popOverride(id) {
      toolStateRef.current = {
        ...toolStateRef.current,
        overrides: toolStateRef.current.overrides.filter((t) => t !== id),
      };
    },
    clearOverrides() {
      toolStateRef.current = { ...toolStateRef.current, overrides: [] };
    },
    toolStateRef,
  };
  const contentSelectionRef = { current: null as unknown };
  const contentSelection: HeadlessState["contentSelection"] = {
    contentSelection: null,
    setContentSelection(s) {
      contentSelection.contentSelection = s;
      contentSelectionRef.current = s;
    },
    caret: null,
    setCaret(c) {
      contentSelection.caret = c;
    },
    selectionRects: [],
    setSelectionRects(r) {
      contentSelection.selectionRects = r;
    },
    contentSelectionRef,
  };
  const settings = new Map<string, Record<string, unknown>>();
  const settingListeners = new Map<string, Set<() => void>>();
  const toolSettings: HeadlessState["toolSettings"] = {
    get: (id) => ({ ...(settings.get(id) ?? {}) }),
    getValue: (id, key) => settings.get(id)?.[key],
    set(id, key, value) {
      settings.set(id, { ...(settings.get(id) ?? {}), [key]: value });
      for (const l of settingListeners.get(id) ?? []) l();
    },
    subscribe(id, listener) {
      let set = settingListeners.get(id);
      if (!set) settingListeners.set(id, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  const screenMode: HeadlessState["screenMode"] = {
    screenMode: "normal",
    setScreenMode(m) {
      screenMode.screenMode = m;
    },
    togglePreview() {
      screenMode.screenMode =
        screenMode.screenMode === "preview" ? "normal" : "preview";
    },
  };
  return {
    document: doc,
    selection,
    camera,
    tool,
    contentSelection,
    toolSettings,
    screenMode,
    overlaySignals: recordingSlice(),
    editContext: null,
  };
}

// ------------------------------------------------------------- the editor

export interface HeadlessEditorOptions {
  /** A document to open (IDML or `.paged` bytes), as File ▸ Open does. */
  idml?: Uint8Array;
  /** Or a blank document of this size (pt), as File ▸ New does. */
  blank?: readonly [number, number];
  /** Load the editor's default font family on every load (default true). */
  fonts?: boolean;
  /** Extra options for every plugin host this editor builds, merged over
   *  the defaults (see {@link HeadlessEditor.host}). */
  hostOptions?: (ed: HeadlessEditor) => Partial<CreateBundleHostOptions>;
}

/** The `__canvas`-shaped handle `editor.*` automation runs against. */
export interface HeadlessCanvasHandle extends CanvasHandleLike {
  client: CanvasClient;
  registries: ShellRegistries;
  objects: typeof objectRegistry;
  readonly handle: DocumentHandle | null;
  readonly elementSelection: ElementId[];
}

export interface HeadlessEditor {
  readonly client: CanvasClient;
  readonly worker: EngineWorker;
  readonly registries: ShellRegistries;
  /** The handle every command handler receives (the shell's PagedEditor). */
  readonly editor: PagedEditor;
  readonly state: HeadlessState;
  /** The app's object registry (`host.objects`, `editor.get/set/…`). */
  readonly objects: typeof objectRegistry;
  /** The `__canvas` handle (also published on `globalThis.__canvas`). */
  readonly canvas: HeadlessCanvasHandle;
  /** `paged.*` / `editor.*` / `demo.*`, as a demo script sees them. */
  readonly automation: DemoGlobals;
  /** What a dialog-opening command asked for (panels, the assistant, …). */
  readonly opened: Array<{ kind: string; detail?: unknown }>;
  /** Open bytes (IDML or `.paged`) as the active document. */
  load(bytes: Uint8Array): Promise<DocumentHandle>;
  /** Run a registered command through the real registry (`when`-gated). */
  invoke(id: string, payload?: unknown): Promise<unknown>;
  /** Select as a click does: engine, mirror and geometry. */
  select(ids: ElementId[], mode?: "replace" | "add" | "toggle"): Promise<void>;
  /** A Boa `paged.*` script, with the host-object bridge armed. */
  script(source: string): Promise<{ output: string[]; error: string | null }>;
  /** A demo script (`paged` / `editor` / `demo` globals). */
  runDemo(source: string): Promise<RunResult>;
  /** Run a typed core command as its dialog / panel button does. */
  invokeCore(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** A plugin host over this editor (createBundleHost). */
  host(manifest?: Partial<PluginManifest>): BundleHost;
  /** Load a bundle through the SDK's `loadBundle`, as the editor's
   *  `__loadTestBundle` does; resolves to the host its activate got. */
  loadBundle(bundle: PagedBundle): Promise<BundleHost>;
  /** The engine's raw channel (the client's `send`). */
  send(message: MainToWorkerKind): Promise<WorkerToMain>;
  /** The canonical model dump (test-kit `modelDump`). */
  dump(options?: ModelDumpOptions): Promise<ModelDump>;
  /** `canonicalJson(await dump())`. */
  dumpJson(options?: ModelDumpOptions): Promise<string>;
  /** Press a key as the keyboard does (`"cmd+z"`, `"delete"`, `"a"`):
   *  the keybinding registry resolves it against the live editor and runs
   *  the winning command. Resolves to whether a binding took the key. */
  press(combo: string): Promise<boolean>;
  /** Problems-panel entries the commands published since the last load. */
  problems(): ProblemEntry[];
  /** Every message posted to the engine settled. */
  idle(): Promise<void>;
  dispose(): Promise<void>;
}

/** Combo names → `KeyboardEvent.key`. */
const KEY_NAMES: Record<string, string> = {
  delete: "Delete",
  backspace: "Backspace",
  escape: "Escape",
  esc: "Escape",
  enter: "Enter",
  tab: "Tab",
  space: " ",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
};

/** The driver host's manifest: a test drives every document door, so it
 *  declares broad read and write (pass `capabilities` to narrow it). */
const DEFAULT_MANIFEST: PluginManifest = {
  id: "test.headless",
  name: "Headless test host",
  version: "0.0.0",
  apiVersion: "^0.2.0",
  capabilities: { document: { read: "broad", write: "broad" } },
} as PluginManifest;

let live: HeadlessEditor | null = null;

export async function createHeadlessEditor(
  options: HeadlessEditorOptions = {},
): Promise<HeadlessEditor> {
  const engines = await headlessEngineModule();
  const worker = createEngineWorker(engines.create(), {
    gestureReader: (buffer) => new GestureBuffer(buffer),
  });
  const fonts = options.fonts === false ? null : await editorFonts();
  const client = new CanvasClient({
    workerFactory: () => worker as unknown as Worker,
    defaultFontProvider: fonts ? async () => fonts.roman.slice() : undefined,
    defaultFontFaces: fonts
      ? async () => [
          { family: "Inter", style: "Italic", bytes: fonts.italic.slice() },
        ]
      : undefined,
  });
  const state = headlessState();
  const opened: HeadlessEditor["opened"] = [];

  let editor!: PagedEditor;
  // The keybinding registry listens on `window` from birth. Headlessly it
  // listens on a private target instead (`press` dispatches there), and
  // `window` is never left defined: code that asks `typeof window` must
  // keep knowing it is not in a browser.
  const keyTarget = new EventTarget();
  const g = globalThis as { window?: unknown };
  const hadWindow = "window" in g;
  if (!hadWindow) g.window = keyTarget;
  let registries: ShellRegistries;
  try {
    registries = createShellRegistries(() => editor);
  } finally {
    if (!hadWindow) delete g.window;
  }
  // The PagedEditorBinder's assembly (shell/src/state/paged-editor.tsx),
  // over the stand-in slices.
  editor = {
    client,
    get document() {
      return state.document;
    },
    get camera() {
      return state.camera;
    },
    get selection() {
      return state.selection;
    },
    get tool() {
      return state.tool;
    },
    get screenMode() {
      return state.screenMode;
    },
    get overlaySignals() {
      return state.overlaySignals;
    },
    get toolSettings() {
      return state.toolSettings;
    },
    get contentSelection() {
      return state.contentSelection;
    },
    text: {
      measure: (
        family: string,
        style: string | null,
        str: string,
        sizePt: number,
      ) => client.measureText(family, style, str, sizePt),
      measureMany: (
        family: string,
        style: string | null,
        texts: readonly string[],
        sizePt: number,
      ) => client.measureTexts(family, style, texts, sizePt),
    },
    sceneLayers: {
      submit: (elementId: string, layer: never, caller?: string) =>
        client.submitSceneLayer(elementId, layer, caller),
      clear: (elementId: string) => client.clearSceneLayer(elementId),
      submitImage: async (
        elementId: string,
        image: never,
        caller?: string,
        transfer?: boolean,
      ) => {
        await client.submitSceneImageBinary(elementId, image, caller, transfer);
      },
      submitImageTiles: async (
        elementId: string,
        tiles: never,
        caller?: string,
        transfer?: boolean,
      ) => {
        await client.submitSceneImageTilesBinary(
          elementId,
          tiles,
          caller,
          transfer,
        );
      },
    },
    parts: {
      write: (path: string, bytes: Uint8Array, caller?: string) =>
        client.writePagedPartBinary(path, bytes, caller),
      read: (path: string) => client.readPagedPartBinary(path),
      delete: (path: string, caller?: string) =>
        client.deletePagedPart(path, caller),
    },
    mutateWithBytes: (mutation: never, bytes: Uint8Array, transfer?: boolean) =>
      client.mutateWithBytes(mutation, bytes, transfer),
    images: {
      claim: (claim: never) => client.claimImageResource(claim),
      release: (imageId: string) => client.releaseImageResource(imageId),
      submitTiles: (
        imageId: string,
        level: number,
        tiles: never,
        generation: number,
      ) => client.submitResourceTiles(imageId, level, tiles, generation),
      onResourceTilesNeeded: (listener: never) =>
        client.onResourceTilesNeeded(listener),
    },
    get editContext() {
      return state.editContext;
    },
    registries,
  } as unknown as PagedEditor;

  // The object registry reads the editor lazily and arms the Boa host
  // bridge on the client (main.tsx: setObjectModelEditor(paged)).
  setObjectModelEditor(editor as unknown as ContractEditor);

  const setSelection = async (ids: ElementId[]) => {
    const applied = await client.setElementSelection(ids, "replace");
    state.selection.setElementSelection(applied);
    try {
      state.selection.setElementGeometry(await client.elementGeometry(applied));
    } catch {
      /* geometry is selection chrome */
    }
  };

  // ---- the app's command sets, as main.tsx's CanvasAppIntegration
  // registers them (keep in step with main.tsx "SDK Phase 4").
  const viewport = () => state.camera.viewportSize;
  const zoomBy = (factor: number) => {
    const [vw, vh] = viewport();
    const cam = state.camera.camera;
    const cx = vw / 2;
    const cy = vh / 2;
    const docX = (cx - cam.tx) / cam.scale;
    const docY = (cy - cam.ty) / cam.scale;
    const scale = factor === 0 ? 1 : cam.scale * factor;
    state.camera.setCamera({
      scale,
      tx: cx - docX * scale,
      ty: cy - docY * scale,
    });
  };
  const undoOwner = () =>
    state.editContext
      ? (registries.editContexts.get(state.editContext.type) as
          { onUndo?(): void; onRedo?(): void } | undefined)
      : undefined;
  const appCommands = buildAppCommands({
    undo: () => {
      const owner = undoOwner();
      if (owner?.onUndo) return owner.onUndo();
      void client.undo();
    },
    redo: () => {
      const owner = undoOwner();
      if (owner?.onUndo) return owner.onRedo?.();
      void client.redo();
    },
    openPdf: () => {
      opened.push({ kind: "filePicker", detail: "pdf" });
    },
    saveAsIdml: async () => {
      if (!state.document.handle || state.document.handle.pageCount === 0)
        return;
      opened.push({ kind: "download", detail: await client.exportIdml() });
    },
    savePaged: async () => {
      if (!state.document.handle || state.document.handle.pageCount === 0)
        return;
      const mark = client.editMark;
      opened.push({ kind: "download", detail: await client.exportPaged() });
      client.markSaved(mark);
    },
    zoomIn: () => zoomBy(1.5),
    zoomOut: () => zoomBy(1 / 1.5),
    zoom100: () => zoomBy(0),
    zoomFit: () => {
      opened.push({ kind: "camera", detail: "fit" });
    },
  });
  const objectDeps: ObjectCommandDeps = {
    client,
    getSelection: () => state.selection.elementSelection,
    activeEditContext: () => state.editContext,
    setSelection,
    refreshSelectionGeometry: async () => {
      const ids = state.selection.elementSelection;
      if (ids.length === 0) return;
      state.selection.setElementGeometry(await client.elementGeometry(ids));
    },
    report: (severity, message) =>
      problemsSink.publish(OBJECT_DIAGNOSTIC_SOURCE, "object", [
        { severity, message, source: "object" },
      ]),
  };
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
    placeImage: freshInsert((p) => placeImage(p, insertReport)),
    newPage: freshInsert((p) => addPage(p, insertReport)),
  });
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
  setAssistantOpener(() => {
    opened.push({ kind: "assistant" });
  });
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
          autoRun: false,
        });
      },
    },
  ];
  // The shell's own file commands that the barrel exports (ShellChrome
  // registers them in the browser); their pickers record instead.
  const status = (s: string) => opened.push({ kind: "status", detail: s });
  const warn = (w: string) => opened.push({ kind: "warning", detail: w });
  const shellCommands = [
    buildNewDocumentCommand({ setStatus: status, pushWarning: warn }),
    buildImportAseCommand({
      pickFile: async () => {
        opened.push({ kind: "filePicker", detail: "ase" });
        return null;
      },
      setStatus: status,
    }),
    buildExportAseCommand({ setStatus: status }),
    buildNewFromBriefCommand(() => openAssistant({ view: "brief" })),
    buildExportPdfCommand(),
  ];
  const registrations = [
    ...[
      ...appCommands,
      ...aiCommands,
      ...objectCommands,
      ...insertCommands,
      ...alignCommands,
      ...GLOBAL_LIGHT_COMMANDS,
      SELECT_ALL_COMMAND,
      ...buildCoreCommandEntries(),
      ...shellCommands,
    ].map((c) => registries.commands.register(c)),
    ...[
      ...APP_MENU_ITEMS,
      SELECT_ALL_MENU_ITEM,
      ...OBJECT_MENU_ITEMS,
      ...INSERT_MENU_ITEMS,
      ...CORE_COMMAND_MENU_ITEMS,
      ...GLOBAL_LIGHT_MENU_ITEMS,
      ...COCKPIT_MENU_SEAMS,
    ].map((m) => registries.menus.register(m)),
    ...[
      ...APP_KEYBINDINGS,
      ...SELECT_ALL_KEYBINDINGS,
      ...OBJECT_KEYBINDINGS,
      ...INSERT_KEYBINDINGS,
    ].map((k) => registries.keybindings.register(k)),
  ];

  // ---- documents
  const adopt = (handle: DocumentHandle) => {
    state.document.resetForNewDocument();
    state.document.setHandle(handle);
    state.contentSelection.setContentSelection(null);
    resetProblems();
    return handle;
  };
  // A document the engine loaded on its own (File ▸ New, a plugin's
  // documents.open) reaches the shell as a `documentLoaded` broadcast.
  const unsubscribe = client.subscribe((msg) => {
    if (msg.kind === "documentLoaded") {
      const handle = msg.payload as DocumentHandle;
      if (state.document.handle?.docId !== handle.docId) adopt(handle);
    }
  });

  // ---- automation
  const canvas: HeadlessCanvasHandle = {
    client,
    registries,
    objects: objectRegistry,
    openPanel: (id) => opened.push({ kind: "panel", detail: id }),
    setActiveTool: (t) => state.tool.setBaseTool(t),
    setMode: (m) => opened.push({ kind: "mode", detail: m }),
    setElementSelection: (ids) =>
      state.selection.setElementSelection(ids as ElementId[]),
    setElementGeometry: (items) => state.selection.setElementGeometry(items),
    get elementSelection() {
      return state.selection.elementSelection;
    },
    get handle() {
      return state.document.handle;
    },
  } as HeadlessCanvasHandle;
  const automation = buildAutomation(canvas, { isSilent: () => true });

  const hosts: Array<{ dispose(): void }> = [];
  const sharedHost = {
    objects: objectRegistry,
    dataProviders: createDataProviderRegistry(),
    bindingProviders: createBindingProviderRegistry(),
  };
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const hostOptionsFor = (): CreateBundleHostOptions => ({
    ...sharedHost,
    toolSettings: state.toolSettings as never,
    diagnosticsSink: {
      publish: (source: string, key: string, diagnostics: unknown) =>
        problemsSink.publish(source, key, diagnostics as never),
      clear: (source: string) => problemsSink.clear(source),
    } as never,
    console: silent,
    ...(options.hostOptions?.(ed) ?? {}),
  });

  const ed: HeadlessEditor = {
    client,
    worker,
    registries,
    editor,
    state,
    objects: objectRegistry,
    canvas,
    automation,
    opened,
    async load(bytes) {
      return adopt(await client.loadDocument(bytes.slice()));
    },
    invoke: (id, payload) => registries.commands.invoke(id, payload),
    async select(ids, mode = "replace") {
      const applied = await client.setElementSelection(ids, mode);
      state.selection.setElementSelection(applied);
      try {
        state.selection.setElementGeometry(
          await client.elementGeometry(applied),
        );
      } catch {
        /* chrome only */
      }
    },
    script: (source) => client.executeScript(source),
    runDemo: (source) => runDemoScript(source, automation),
    invokeCore: (op, args) => invokeCoreCommand(op, args as never),
    host(manifest = {}) {
      const handle = createBundleHost(
        () => editor as unknown as ContractEditor,
        { ...DEFAULT_MANIFEST, ...manifest } as PluginManifest,
        hostOptionsFor(),
      );
      hosts.push(handle);
      return handle.host;
    },
    async loadBundle(bundle) {
      let received: BundleHost | null = null;
      const wrapped = {
        ...bundle,
        activate: (host: BundleHost) => {
          received = host;
          return bundle.activate(host);
        },
      } as PagedBundle;
      const loaded = sdkLoadBundle(
        () => editor as unknown as ContractEditor,
        wrapped,
        hostOptionsFor(),
      );
      hosts.push(loaded);
      if (!loaded.active) {
        throw new Error(
          `loadBundle: ${loaded.id} did not activate: ${String(loaded.activationError)}`,
        );
      }
      if (!received) throw new Error("loadBundle: activate never ran");
      return received;
    },
    send: (message) => client.send(message),
    dump: (opts) => modelDump(client.send.bind(client) as never, opts),
    async dumpJson(opts) {
      return canonicalJson(await ed.dump(opts));
    },
    async press(combo) {
      const parts = combo.toLowerCase().split("+");
      const key = parts.pop() ?? "";
      const event = Object.assign(new Event("keydown", { cancelable: true }), {
        key: KEY_NAMES[key] ?? key,
        metaKey: parts.includes("cmd") || parts.includes("meta"),
        ctrlKey: parts.includes("ctrl"),
        shiftKey: parts.includes("shift"),
        altKey: parts.includes("alt") || parts.includes("option"),
      });
      keyTarget.dispatchEvent(event);
      await worker.idle();
      return event.defaultPrevented;
    },
    problems: () => getProblemsSnapshot(),
    idle: () => worker.idle(),
    async dispose() {
      unsubscribe();
      for (const h of hosts.splice(0)) {
        try {
          h.dispose();
        } catch {
          /* a bundle's teardown is not this editor's to judge */
        }
      }
      for (const r of registrations) r.dispose();
      setAssistantOpener(null);
      if (live === ed) {
        live = null;
        setObjectModelEditor(null);
        delete (globalThis as { __canvas?: unknown }).__canvas;
      }
      client.dispose();
    },
  };

  live = ed;
  (globalThis as { __canvas?: unknown }).__canvas = canvas;

  if (options.idml) await ed.load(options.idml);
  else if (options.blank) {
    adopt(await client.newBlankDocument(options.blank[0], options.blank[1]));
  }
  return ed;
}
