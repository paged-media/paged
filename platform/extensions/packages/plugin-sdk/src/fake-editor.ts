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

// A RECORDING fake of the contract's `PagedEditor`: no engine, no UI.
//
// What a tool, command or panel does to the editor is the thing a unit
// test asserts, so the fake records every call in one ordered log
// (`events`): registry registrations and disposals, mutations, undo and
// redo, the gesture channel (begin / update / commit / cancel), every
// other `client.send`, the overlay primitives a handler publishes,
// selection writes, tool switches and command invocations.
//
// Replies are scripted, with defaults that keep a handler on its happy
// path: a mutation applies (an insert reports a fresh `createdId`), a
// gesture begins with a new handle and commits, reads answer what the
// options give (`collections`, `geometry`, `pathAnchors`, `hitTest`, …).
// `reply` overrides any message. Every reply is ALSO fanned out to
// `client.subscribe` listeners, as the editor's client does.
//
// The fake keeps a small UNDO STACK: an applied mutation or a committed
// gesture is one step, `undo` / `redo` move along it. That is what makes
// "one gesture is exactly one undo step" assertable without an engine
// (`undoDepth()`); the model-level version of the same invariant runs
// against a real engine (`./gesture-invariants.ts`).
//
// Runner-agnostic: nothing here imports a test runner.

import type {
  CollectionName,
  CommandContribution,
  Disposable,
  DocumentMeta,
  ElementGeometryItem,
  ElementId,
  MainToWorkerKind,
  Mutation,
  PagedEditor,
  PathAnchorsResult,
  SelectionMode,
  ToolContribution,
  ToolPreviewShape,
  WorkerToMain,
} from "@paged-media/plugin-api";

/** A page of the fake document: its id, its top-left in document pt and
 *  its size in pt. Pages may sit anywhere in document space. */
export interface FakePage {
  id: string;
  origin: readonly [number, number];
  size: readonly [number, number];
}

/** The fake's registries, by the name `PagedEditor.registries` uses. */
export type FakeRegistryName =
  | "tools"
  | "panels"
  | "commands"
  | "keybindings"
  | "overlays"
  | "editContexts"
  | "menus"
  | "objectTypes"
  | "importers"
  | "exporters";

/** The gesture-channel messages, as `client.send` carries them. */
export type GestureChannelMessage =
  "beginGesture" | "updateGesture" | "commitGesture" | "cancelGesture";

/** One entry of the fake's ordered log. */
export type FakeEditorEvent =
  | {
      channel: "registry";
      registry: FakeRegistryName;
      action: "register" | "dispose";
      /** The contribution's `id` (or `type`, or `key` for a keybinding). */
      id: string;
      value: unknown;
    }
  | { channel: "mutation"; mutation: Mutation; reply: WorkerToMain }
  | { channel: "history"; action: "undo" | "redo"; reply: WorkerToMain }
  | {
      channel: "gesture";
      message: GestureChannelMessage;
      payload: unknown;
      reply: WorkerToMain;
    }
  | { channel: "send"; message: MainToWorkerKind; reply: WorkerToMain }
  | {
      channel: "read";
      method: "collection" | "documentMeta" | "pathAnchors" | "elementGeometry";
      args: readonly unknown[];
    }
  | {
      channel: "overlay";
      method:
        | "setToolPreview"
        | "setToolPreviews"
        | "setOverlayLayer"
        | "removeOverlayLayer";
      value: unknown;
      key?: string;
    }
  | {
      channel: "selection";
      method:
        | "client.setElementSelection"
        | "setElementSelection"
        | "setElementGeometry";
      value: unknown;
    }
  | { channel: "tool"; method: "setBaseTool"; id: string }
  | { channel: "command"; id: string; payload: unknown; result: unknown }
  /** A member a SUPERSET editor adds (a host's richer handle), recorded
   *  through `record`. */
  | { channel: "extra"; member: string; args: readonly unknown[] };

/** Narrow a log entry by channel. */
export type FakeEvent<C extends FakeEditorEvent["channel"]> = Extract<
  FakeEditorEvent,
  { channel: C }
>;

export interface FakeEditorOptions {
  /** The document's pages. Default: one US Letter page (612 × 792 pt) at
   *  the document origin, id `"page-1"`. */
  pages?: readonly FakePage[];
  /** Camera scale (CSS px per pt). Default 1. */
  zoom?: number;
  /** The initial element selection. */
  selection?: readonly ElementId[];
  /** What `client.collection(name)` answers. `pages` defaults to the
   *  page list (`selfId`, `sizePt`). */
  collections?: Partial<Record<string, readonly unknown[]>>;
  /** Fields of `client.documentMeta()` (the rest is a blank document). */
  documentMeta?: Partial<DocumentMeta>;
  /** `client.elementGeometry` answer per element (null = not found). */
  geometry?: (id: ElementId) => ElementGeometryItem | null;
  /** `client.pathAnchors` answer per element. */
  pathAnchors?: (id: ElementId) => PathAnchorsResult | null;
  /** The `hitTest` answer: the element under a page-local point. */
  hitTest?: (
    pageId: string,
    point: readonly [number, number],
    filter: string,
  ) => ElementId | null;
  /** The `requestMarqueeHits` answer for a page-local rect. */
  marqueeHits?: (
    pageId: string,
    rect: readonly [number, number, number, number],
  ) => ElementId[];
  /** Refuse a mutation: return the reason (it answers `mutationFailed`)
   *  or null to apply it. */
  refuse?: (mutation: Mutation) => string | null;
  /** Override any `client.send` reply. Return `undefined` for the
   *  default. Runs before the defaults, for every message kind. */
  reply?: (
    message: MainToWorkerKind,
  ) => WorkerToMain | WorkerToMainKindLike | undefined;
  /** `"auto"` (default): every reply resolves on the next microtask.
   *  `"manual"`: replies wait until `flushReplies()`, so a test can drive
   *  the pointer-up-before-the-begin-resolved paths. */
  replies?: "auto" | "manual";
}

/** A reply without the envelope (`seq`/`protocol` are filled in). */
export type WorkerToMainKindLike = { kind: string; payload?: unknown };

export interface FakeEditor {
  /** The contract handle to pass to `onActivate`, `createBundleHost`, … */
  readonly editor: PagedEditor;
  /** Every call, in order. */
  readonly events: readonly FakeEditorEvent[];
  /** The page layout. */
  readonly pages: readonly FakePage[];
  /** The current camera. */
  camera(): { scale: number; tx: number; ty: number };
  setZoom(scale: number): void;
  setCamera(camera: { scale: number; tx: number; ty: number }): void;
  /** Replace the element selection (as the user would by clicking). */
  setSelection(ids: readonly ElementId[]): void;
  /** The current element selection. */
  selection(): readonly ElementId[];
  /** Log entries of one channel, in order. */
  ofChannel<C extends FakeEditorEvent["channel"]>(channel: C): FakeEvent<C>[];
  /** The mutations `client.mutate` (or `send({kind:"mutate"})`) carried. */
  mutations(): Mutation[];
  /** The gesture-channel messages, in order. */
  gestureMessages(): FakeEvent<"gesture">[];
  /** Every value `overlaySignals.setToolPreview` / `setToolPreviews`
   *  received, in order (`null` = cleared). */
  previews(): Array<ToolPreviewShape | readonly ToolPreviewShape[] | null>;
  /** What the tool-preview slot shows now. */
  currentPreview(): ToolPreviewShape | readonly ToolPreviewShape[] | null;
  /** The live contributions of a registry (disposed ones are gone). */
  registered<T = unknown>(registry: FakeRegistryName): T[];
  /** The live tools, for a gesture driver to mount. */
  tools(): ToolContribution[];
  /** Run a registered command's handler against this editor (recorded). */
  invokeCommand(id: string, payload?: unknown): Promise<unknown>;
  /** Push an unsolicited worker notification to `client.subscribe`. */
  emit(message: WorkerToMainKindLike): void;
  /** A position in the log, for `since`. */
  mark(): number;
  /** The log entries after `mark`. */
  since(mark: number): FakeEditorEvent[];
  /** Committed undo steps on the fake's stack (applied mutations and
   *  committed gestures, minus undos, plus redos). */
  undoDepth(): number;
  /** Resolve every reply held by `replies: "manual"`. */
  flushReplies(): void;
  /** Wait until no reply is in flight and the handler's promise chains
   *  have run (a few idle macrotasks). Throws when it never settles. */
  settle(): Promise<void>;
  /** Clear the log (the undo stack and registrations stay). */
  clearLog(): void;
  /** Append an entry: how a superset of the contract handle (a host's
   *  richer editor, built on this fake) logs its extra members. */
  record(event: FakeEditorEvent): void;
  /** Track a promise as an in-flight reply (`settle` waits for it). */
  track<T>(promise: Promise<T>): Promise<T>;
}

const LETTER: FakePage = { id: "page-1", origin: [0, 0], size: [612, 792] };

const PROTOCOL = 0;

// Captured at load, before a test can install fake timers.
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate: ((cb: () => void) => unknown) | undefined = (
  globalThis as { setImmediate?: (cb: () => void) => unknown }
).setImmediate;

/** One real macrotask. */
export function nextMacrotask(): Promise<void> {
  if (realSetImmediate) return new Promise((r) => void realSetImmediate(r));
  return new Promise((r) => void realSetTimeout(r, 0));
}

const INSERT_KIND: Partial<Record<Mutation["op"], ElementId["kind"]>> = {
  insertFrame: "rectangle",
  insertOval: "oval",
  insertLine: "graphicLine",
  insertPath: "polygon",
  insertTextFrame: "textFrame",
};

/** The element kind a mutation mints (the LAST insert of a batch), or
 *  null when it mints none. */
export function mintedKindOf(mutation: Mutation): ElementId["kind"] | null {
  if (mutation.op === "batch") {
    let kind: ElementId["kind"] | null = null;
    for (const child of mutation.args.ops) kind = mintedKindOf(child) ?? kind;
    return kind;
  }
  if (mutation.op === "onMaster") return mintedKindOf(mutation.args.mutation);
  return INSERT_KIND[mutation.op] ?? null;
}

/** A batch's leaves, depth first (a plain mutation is its own leaf). */
export function flattenMutation(mutation: Mutation): Mutation[] {
  if (mutation.op === "batch")
    return mutation.args.ops.flatMap(flattenMutation);
  return [mutation];
}

const blankMeta = (pages: readonly FakePage[]): DocumentMeta => ({
  pageCount: pages.length,
  activePage: pages[0]?.id ?? null,
  units: "pt",
  colorMode: "rgb",
  documentName: "fake",
  dirty: false,
});

const statsStub = {
  hits: 0,
  misses: 0,
  len: 0,
  capacity: 0,
  rebuildMs: 0,
};

/**
 * Create a recording fake editor. Hand `fake.editor` to a handler's
 * `onActivate`, to `createBundleHost(() => fake.editor, …)`, or to the
 * gesture driver; then assert on `fake.events` and its helpers.
 */
export function createFakeEditor(options: FakeEditorOptions = {}): FakeEditor {
  const pages = options.pages ?? [LETTER];
  const events: FakeEditorEvent[] = [];
  const listeners = new Set<(msg: WorkerToMain) => void>();
  let camera = { scale: options.zoom ?? 1, tx: 0, ty: 0 };
  let selection: ElementId[] = [...(options.selection ?? [])];
  let preview: ToolPreviewShape | readonly ToolPreviewShape[] | null = null;
  const live = new Map<FakeRegistryName, Map<object, string>>();
  // The undo stack: `done` steps behind the cursor, `undone` ahead of it.
  let done = 0;
  let undone = 0;
  let seq = 1;
  let minted = 0;
  let handle = 0;
  let inFlight = 0;
  const held: Array<() => void> = [];
  const manual = options.replies === "manual";

  const envelope = (
    kind: WorkerToMainKindLike,
    s: number | null,
  ): WorkerToMain =>
    ({ seq: s, protocol: PROTOCOL, ...kind }) as unknown as WorkerToMain;

  /** Resolve `value` the way the options say, fanning the reply out. */
  const deliver = <T>(value: T, fanOut: WorkerToMain | null): Promise<T> => {
    inFlight++;
    return new Promise<T>((resolve) => {
      const go = () => {
        inFlight--;
        if (fanOut) for (const l of [...listeners]) l(fanOut);
        resolve(value);
      };
      if (manual) held.push(go);
      else queueMicrotask(go);
    });
  };

  const applyMutation = (mutation: Mutation, s: number): WorkerToMain => {
    const refused = options.refuse?.(mutation) ?? null;
    if (refused !== null) {
      return envelope(
        {
          kind: "mutationFailed",
          payload: { error: { kind: "invalidMutation", details: refused } },
        },
        s,
      );
    }
    done++;
    undone = 0;
    const kind = mintedKindOf(mutation);
    const createdId = kind
      ? ({ kind, id: `fake-${++minted}` } as ElementId)
      : null;
    return envelope(
      {
        kind: "mutationApplied",
        payload: {
          clientSeq: s,
          appliedSeq: done,
          pageIds: pages.map((p) => p.id),
          cacheStats: statsStub,
          createdId,
        },
      },
      s,
    );
  };

  const history = (action: "undo" | "redo", s: number): WorkerToMain => {
    if (action === "undo" && done > 0) {
      done--;
      undone++;
    } else if (action === "redo" && undone > 0) {
      undone--;
      done++;
    }
    const pageIds = pages.map((p) => p.id);
    return action === "undo"
      ? envelope(
          {
            kind: "undoApplied",
            payload: {
              undoneSeq: done + 1,
              appliedSeq: done,
              pageIds,
              cacheStats: statsStub,
            },
          },
          s,
        )
      : envelope(
          {
            kind: "redoApplied",
            payload: {
              redoneSeq: done,
              appliedSeq: done,
              pageIds,
              cacheStats: statsStub,
            },
          },
          s,
        );
  };

  const pageList = () =>
    pages.map((p) => ({ selfId: p.id, sizePt: [p.size[0], p.size[1]] }));

  /** The default reply for everything that is not a mutation or history. */
  const defaultReply = (message: MainToWorkerKind, s: number): WorkerToMain => {
    const m = message as { kind: string; payload?: Record<string, unknown> };
    const p = m.payload ?? {};
    switch (m.kind) {
      case "beginGesture":
        return envelope(
          { kind: "gestureBegun", payload: { handle: ++handle } },
          s,
        );
      case "updateGesture":
        return envelope(
          {
            kind: "gestureUpdated",
            payload: { handle: p.handle, pageIds: [], snapLines: [] },
          },
          s,
        );
      case "commitGesture":
        done++;
        undone = 0;
        return envelope(
          {
            kind: "gestureCommitted",
            payload: {
              handle: p.handle,
              appliedSeq: done,
              pageIds: pages.map((pg) => pg.id),
              cacheStats: statsStub,
            },
          },
          s,
        );
      case "cancelGesture":
        return envelope(
          {
            kind: "gestureCancelled",
            payload: { handle: p.handle, pageIds: [] },
          },
          s,
        );
      case "hitTest": {
        const element =
          options.hitTest?.(
            String(p.pageId),
            p.docPoint as [number, number],
            String(p.filter ?? "any"),
          ) ?? null;
        return envelope(
          {
            kind: "hitResult",
            payload: {
              frameId:
                element && typeof element.id === "string" ? element.id : null,
              storyId: null,
              offsetWithinStory: null,
              frameBounds: null,
              element,
            },
          },
          s,
        );
      }
      case "requestMarqueeHits":
        return envelope(
          {
            kind: "marqueeHits",
            payload: {
              ids:
                options.marqueeHits?.(
                  String(p.pageId),
                  p.rect as [number, number, number, number],
                ) ?? [],
            },
          },
          s,
        );
      case "requestElementGeometry":
        return envelope(
          {
            kind: "elementGeometry",
            payload: { items: geometryOf(p.ids as ElementId[]) },
          },
          s,
        );
      case "requestPathAnchors":
        return envelope(
          {
            kind: "pathAnchors",
            payload: {
              result: options.pathAnchors?.(p.id as ElementId) ?? null,
            },
          },
          s,
        );
      case "requestCollection":
        return envelope(
          {
            kind: "collectionReply",
            payload: { name: p.name, items: collectionOf(String(p.name)) },
          },
          s,
        );
      case "requestDocumentMeta":
        return envelope(
          { kind: "documentMetaReply", payload: { meta: meta() } },
          s,
        );
      case "setElementSelection":
        selection = [...((p.ids as ElementId[]) ?? [])];
        return envelope(
          { kind: "elementSelectionApplied", payload: { ids: selection } },
          s,
        );
      case "requestStyleProperties":
        return envelope(
          { kind: "styleProperties", payload: { result: null } },
          s,
        );
      default:
        // No engine to answer: say so, as the worker does for a request it
        // cannot serve. A handler that needs the reply must script it.
        return envelope(
          {
            kind: "warning",
            payload: { kind: "fakeUnhandled", details: m.kind },
          },
          s,
        );
    }
  };

  const meta = (): DocumentMeta => ({
    ...blankMeta(pages),
    ...(options.documentMeta ?? {}),
  });
  const collectionOf = (name: string): readonly unknown[] =>
    options.collections?.[name] ?? (name === "pages" ? pageList() : []);
  const geometryOf = (ids: readonly ElementId[]): ElementGeometryItem[] =>
    ids
      .map((id) => options.geometry?.(id) ?? null)
      .filter((g): g is ElementGeometryItem => g !== null);

  const GESTURE_KINDS = new Set<string>([
    "beginGesture",
    "updateGesture",
    "commitGesture",
    "cancelGesture",
  ]);

  /** `client.send`: route, record, reply. */
  const send = (message: MainToWorkerKind): Promise<WorkerToMain> => {
    const s = seq++;
    const m = message as { kind: string; payload?: unknown };
    const scripted = options.reply?.(message);
    let reply: WorkerToMain;
    if (m.kind === "mutate") {
      reply = scripted
        ? envelope(scripted as WorkerToMainKindLike, s)
        : applyMutation(m.payload as Mutation, s);
      events.push({
        channel: "mutation",
        mutation: m.payload as Mutation,
        reply,
      });
    } else if (m.kind === "undo" || m.kind === "redo") {
      reply = scripted
        ? envelope(scripted as WorkerToMainKindLike, s)
        : history(m.kind, s);
      events.push({ channel: "history", action: m.kind, reply });
    } else {
      reply = scripted
        ? envelope(scripted as WorkerToMainKindLike, s)
        : defaultReply(message, s);
      if (GESTURE_KINDS.has(m.kind)) {
        events.push({
          channel: "gesture",
          message: m.kind as GestureChannelMessage,
          payload: m.payload,
          reply,
        });
      } else {
        events.push({ channel: "send", message, reply });
      }
    }
    return deliver(reply, reply);
  };

  const registry = (
    name: FakeRegistryName,
    idOf: (c: Record<string, unknown>) => string,
  ) => ({
    register(contribution: unknown): Disposable {
      const c = contribution as Record<string, unknown>;
      const id = idOf(c);
      let byObj = live.get(name);
      if (!byObj) live.set(name, (byObj = new Map()));
      if (name !== "keybindings" && name !== "menus") {
        for (const existing of byObj.values()) {
          if (existing === id)
            throw new Error(`fake ${name}: "${id}" already registered`);
        }
      }
      byObj.set(c, id);
      events.push({
        channel: "registry",
        registry: name,
        action: "register",
        id,
        value: c,
      });
      return {
        dispose() {
          if (byObj!.delete(c)) {
            events.push({
              channel: "registry",
              registry: name,
              action: "dispose",
              id,
              value: c,
            });
          }
        },
      };
    },
  });

  const byId = (c: Record<string, unknown>) => String(c.id ?? c.type ?? "");

  const client = {
    mutate: (mutation: Mutation) => send({ kind: "mutate", payload: mutation }),
    undo: () => send({ kind: "undo" }),
    redo: () => send({ kind: "redo" }),
    async collection<T>(name: CollectionName): Promise<readonly T[]> {
      events.push({ channel: "read", method: "collection", args: [name] });
      return deliver(collectionOf(String(name)) as readonly T[], null);
    },
    async documentMeta(): Promise<DocumentMeta> {
      events.push({ channel: "read", method: "documentMeta", args: [] });
      return deliver(meta(), null);
    },
    async pathAnchors(id: ElementId): Promise<PathAnchorsResult | null> {
      events.push({ channel: "read", method: "pathAnchors", args: [id] });
      return deliver(options.pathAnchors?.(id) ?? null, null);
    },
    async elementGeometry(ids: ElementId[]): Promise<ElementGeometryItem[]> {
      events.push({ channel: "read", method: "elementGeometry", args: [ids] });
      return deliver(geometryOf(ids), null);
    },
    async setElementSelection(
      ids: ElementId[],
      mode: SelectionMode,
    ): Promise<ElementId[]> {
      events.push({
        channel: "selection",
        method: "client.setElementSelection",
        value: { ids, mode },
      });
      if (mode === "replace") selection = [...ids];
      else if (mode === "add") selection = [...selection, ...ids];
      const reply = envelope(
        { kind: "elementSelectionApplied", payload: { ids: selection } },
        seq++,
      );
      return deliver([...selection], reply);
    },
    send,
    subscribe(listener: (msg: WorkerToMain) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const editor: PagedEditor = {
    client,
    registries: {
      tools: registry("tools", byId),
      panels: registry("panels", byId),
      commands: registry("commands", byId),
      keybindings: registry("keybindings", (c) => String(c.key ?? "")),
      overlays: registry("overlays", byId),
      editContexts: registry("editContexts", byId),
      menus: registry(
        "menus",
        (c) => `${String(c.path ?? "")}:${String(c.command ?? "")}`,
      ),
      objectTypes: registry("objectTypes", byId),
      importers: registry("importers", byId),
      exporters: registry("exporters", byId),
    } as unknown as PagedEditor["registries"],
    selection: {
      get elementSelection() {
        return selection;
      },
      setElementSelection(ids: ElementId[]) {
        selection = [...ids];
        events.push({
          channel: "selection",
          method: "setElementSelection",
          value: ids,
        });
      },
      setElementGeometry(items: ElementGeometryItem[]) {
        events.push({
          channel: "selection",
          method: "setElementGeometry",
          value: items,
        });
      },
    },
    camera: {
      get camera() {
        return camera;
      },
    },
    overlaySignals: {
      setToolPreview(value: ToolPreviewShape | null) {
        preview = value;
        events.push({ channel: "overlay", method: "setToolPreview", value });
      },
      setToolPreviews(value: readonly ToolPreviewShape[] | null) {
        preview = value;
        events.push({ channel: "overlay", method: "setToolPreviews", value });
      },
      setOverlayLayer(key: string, shapes: readonly ToolPreviewShape[]) {
        events.push({
          channel: "overlay",
          method: "setOverlayLayer",
          key,
          value: shapes,
        });
      },
      removeOverlayLayer(key: string) {
        events.push({
          channel: "overlay",
          method: "removeOverlayLayer",
          key,
          value: null,
        });
      },
    },
    tool: {
      setBaseTool(id: string) {
        events.push({ channel: "tool", method: "setBaseTool", id });
      },
    },
    contentSelection: { contentSelection: null },
  };

  const ofChannel = <C extends FakeEditorEvent["channel"]>(
    channel: C,
  ): FakeEvent<C>[] =>
    events.filter((e): e is FakeEvent<C> => e.channel === channel);

  return {
    editor,
    events,
    pages,
    camera: () => camera,
    setZoom(scale) {
      camera = { ...camera, scale };
    },
    setCamera(next) {
      camera = { ...next };
    },
    setSelection(ids) {
      selection = [...ids];
    },
    selection: () => selection,
    ofChannel,
    mutations: () => ofChannel("mutation").map((e) => e.mutation),
    gestureMessages: () => ofChannel("gesture"),
    previews: () =>
      events
        .filter(
          (e): e is FakeEvent<"overlay"> =>
            e.channel === "overlay" &&
            (e.method === "setToolPreview" || e.method === "setToolPreviews"),
        )
        .map(
          (e) =>
            e.value as ToolPreviewShape | readonly ToolPreviewShape[] | null,
        ),
    currentPreview: () => preview,
    registered<T>(name: FakeRegistryName): T[] {
      return [...(live.get(name)?.keys() ?? [])] as T[];
    },
    tools() {
      return [...(live.get("tools")?.keys() ?? [])] as ToolContribution[];
    },
    async invokeCommand(id, payload) {
      const command = [...(live.get("commands")?.keys() ?? [])].find(
        (c) => (c as CommandContribution).id === id,
      ) as CommandContribution | undefined;
      if (!command) throw new Error(`fake commands: "${id}" is not registered`);
      const result = await command.handler(editor, payload);
      events.push({ channel: "command", id, payload, result });
      return result;
    },
    emit(message) {
      const msg = envelope(message, null);
      for (const l of [...listeners]) l(msg);
    },
    mark: () => events.length,
    since: (mark) => events.slice(mark),
    undoDepth: () => done,
    flushReplies() {
      while (held.length > 0) held.shift()!();
    },
    async settle() {
      let idle = 0;
      for (let i = 0; i < 2000; i++) {
        await nextMacrotask();
        if (inFlight === 0) {
          if (++idle >= 3) return;
        } else {
          idle = 0;
          if (manual && held.length > 0 && i > 50) {
            throw new Error(
              `fake editor: ${held.length} reply(ies) held (replies: "manual"); call flushReplies()`,
            );
          }
        }
      }
      throw new Error(`fake editor: ${inFlight} reply(ies) still in flight`);
    },
    clearLog() {
      events.length = 0;
    },
    record(event) {
      events.push(event);
    },
    track(promise) {
      inFlight++;
      return promise.finally(() => {
        inFlight--;
      });
    },
  };
}
