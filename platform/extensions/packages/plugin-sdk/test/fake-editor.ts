// A minimal fake PagedEditor for host-adapter tests: Map-backed
// registries with the real register()->Disposable contract, a client
// that scripts mutate/subscribe replies, and plain state slices.

import type { PagedEditor } from "@paged-media/plugin-api";

type Listener = (msg: unknown) => void;

export interface FakeRegistry {
  ids(): string[];
  register(c: { id: string }): { dispose(): void };
}

function fakeRegistry(): FakeRegistry {
  const byId = new Map<string, unknown>();
  return {
    ids: () => Array.from(byId.keys()),
    register(c: { id: string }) {
      if (byId.has(c.id)) throw new Error(`duplicate id ${c.id}`);
      byId.set(c.id, c);
      return {
        dispose() {
          byId.delete(c.id);
        },
      };
    },
  };
}

/** W3.2 — edit-context / object-type registries key off `type`, not
 *  `id`. Same Map-backed register/dispose contract. */
export interface FakeTypeRegistry {
  types(): string[];
  get(type: string): unknown;
  register(c: { type: string }): { dispose(): void };
}

function fakeTypeRegistry(): FakeTypeRegistry {
  const byType = new Map<string, unknown>();
  return {
    types: () => Array.from(byType.keys()),
    get: (t) => byType.get(t),
    register(c: { type: string }) {
      byType.set(c.type, c);
      return {
        dispose() {
          byType.delete(c.type);
        },
      };
    },
  };
}

/** Keybindings register without ids in the real shell — accept any. */
function fakeKeybindingRegistry() {
  const items: unknown[] = [];
  return {
    count: () => items.length,
    register(c: unknown) {
      items.push(c);
      return {
        dispose() {
          const i = items.indexOf(c);
          if (i >= 0) items.splice(i, 1);
        },
      };
    },
  };
}

/** C-6 — a fake renderer resource channel (the editor's `PagedEditor.images`
 *  member). Records claims/submits/releases and lets a test EMIT a
 *  `resourceTilesNeeded` notification (the worker→main event the editor
 *  surfaces), driving the SDK adapter's pull→submit plumbing. */
export function makeFakeImageChannel() {
  type Claim = {
    imageId: string;
    levels: number;
    tileSize: number;
    baseWidth: number;
    baseHeight: number;
    revision: number;
  };
  type Tile = { x: number; y: number; width: number; height: number; rgba: number[] };
  type Submit = { imageId: string; level: number; tiles: Tile[]; generation: number };
  type Need = { imageId: string; level: number; tiles: [number, number][]; generation: number };

  const claims: Claim[] = [];
  const releases: string[] = [];
  const submits: Submit[] = [];
  const listeners = new Set<(need: Need) => void>();

  const channel = {
    async claim(claim: Claim) {
      claims.push(claim);
    },
    async release(imageId: string) {
      releases.push(imageId);
    },
    async submitTiles(
      imageId: string,
      level: number,
      tiles: Tile[],
      generation: number,
    ) {
      submits.push({ imageId, level, tiles, generation });
    },
    onResourceTilesNeeded(listener: (need: Need) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    channel,
    claims,
    releases,
    submits,
    listenerCount: () => listeners.size,
    /** Drive the worker→main needed event; resolves after the queued
     *  microtasks (the adapter's async source→submit) settle. */
    async emitNeeded(need: Need) {
      for (const l of [...listeners]) l(need);
      // Let the adapter's per-tile awaits + the submit microtask flush.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** When `wireContextRegistries` is true the fake exposes shell-side
 *  editContext/objectType registries (the WITH-registry path); when
 *  false they are absent and the host adapter takes the recording-stub
 *  path. Defaults to wired. `images` injects a fake resource channel
 *  (C-6) onto the editor handle. */
export function makeFakeEditor(opts?: {
  wireContextRegistries?: boolean;
  images?: ReturnType<typeof makeFakeImageChannel>["channel"];
}) {
  const wireContextRegistries = opts?.wireContextRegistries ?? true;
  const listeners = new Set<Listener>();
  const tools = fakeRegistry();
  const panels = fakeRegistry();
  const commands = fakeRegistry();
  const overlays = fakeRegistry();
  const keybindings = fakeKeybindingRegistry();
  const editContexts = fakeTypeRegistry();
  const objectTypes = fakeTypeRegistry();
  const mutations: unknown[] = [];
  let selectionIds: unknown[] = [];
  let toolPreview: unknown = null;
  let nextMutateReply: unknown = {
    kind: "mutationApplied",
    payload: { createdId: null, pageIds: ["p1"] },
  };
  let elementPropertiesReply: unknown = {
    kind: "elementProperties",
    payload: { result: null },
  };

  const client = {
    mutate: async (m: unknown) => {
      mutations.push(m);
      return nextMutateReply;
    },
    undo: async () => ({ kind: "undoApplied" }),
    redo: async () => ({ kind: "redoApplied" }),
    collection: async () => [],
    documentMeta: async () => ({ pageCount: 1 }),
    pathAnchors: async () => null,
    elementGeometry: async () => [],
    setElementSelection: async (ids: unknown[]) => ids,
    send: async (msg: { kind: string }) => {
      if (msg.kind === "hitTest") {
        return { kind: "hitResult", payload: { element: null } };
      }
      if (msg.kind === "requestSceneTree") {
        return { kind: "sceneTree", payload: { roots: [] } };
      }
      if (msg.kind === "requestElementProperties") {
        return elementPropertiesReply;
      }
      return { kind: "noop" };
    },
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };

  const editor = {
    client,
    registries: {
      tools,
      panels,
      commands,
      overlays,
      keybindings,
      ...(wireContextRegistries ? { editContexts, objectTypes } : {}),
    },
    selection: {
      elementSelection: selectionIds,
      setElementSelection: (ids: unknown[]) => {
        selectionIds = ids;
        editor.selection.elementSelection = ids;
      },
      setElementGeometry: () => {},
    },
    camera: { camera: { scale: 2, tx: 10, ty: 20 } },
    overlaySignals: {
      setToolPreview: (v: unknown) => {
        toolPreview = v;
      },
    },
    ...(opts?.images ? { images: opts.images } : {}),
  };

  return {
    setElementProperties(reply: unknown) {
      elementPropertiesReply = reply;
    },
    editor: editor as unknown as PagedEditor,
    tools,
    panels,
    commands,
    overlays,
    keybindings,
    editContexts,
    objectTypes,
    mutations,
    emit: (msg: unknown) => {
      for (const l of listeners) l(msg);
    },
    listenerCount: () => listeners.size,
    getToolPreview: () => toolPreview,
    setNextMutateReply: (r: unknown) => {
      nextMutateReply = r;
    },
  };
}
