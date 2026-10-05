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

// A minimal fake PagedEditor for host-adapter tests: Map-backed
// registries with the real register()->Disposable contract, a client
// that scripts mutate/subscribe replies, and plain state slices.

import type { PagedEditor } from "@paged-media/plugin-api";

type Listener = (msg: unknown) => void;

export interface FakeRegistry {
  ids(): string[];
  get(id: string): unknown;
  register(c: { id: string }): { dispose(): void };
}

function fakeRegistry(): FakeRegistry {
  const byId = new Map<string, unknown>();
  return {
    ids: () => Array.from(byId.keys()),
    get: (id) => byId.get(id),
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
    /** The most recently registered contribution — lets a test inspect
     *  what the SDK derived (e.g. the `when` built from a menu scope). */
    last: () => items[items.length - 1],
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
 *  (C-6) onto the editor handle. `multiPreview` wires the K-9
 *  MULTI-shape tool-preview sink (`overlaySignals.setToolPreviews`);
 *  OFF by default, which is the older-host path the door must degrade
 *  onto. */
export function makeFakeEditor(opts?: {
  wireContextRegistries?: boolean;
  images?: ReturnType<typeof makeFakeImageChannel>["channel"];
  multiPreview?: boolean;
}) {
  const wireContextRegistries = opts?.wireContextRegistries ?? true;
  const listeners = new Set<Listener>();
  const tools = fakeRegistry();
  const panels = fakeRegistry();
  const commands = fakeRegistry();
  const overlays = fakeRegistry();
  const keybindings = fakeKeybindingRegistry();
  // Same recording shape — the menu door registers and disposes like the
  // keybinding door does.
  const menus = fakeKeybindingRegistry();
  const editContexts = fakeTypeRegistry();
  const objectTypes = fakeTypeRegistry();
  const mutations: unknown[] = [];
  let selectionIds: unknown[] = [];
  let toolPreview: unknown = null;
  let toolPreviews: unknown = null;
  // C-16 — the scriptable `requestSceneTree` reply (the parentage
  // source). Empty roots by default, as before.
  let sceneTreeRoots: unknown[] = [];
  // v51 .paged container parts — an in-memory store so host.parts round-trips.
  const pagedParts = new Map<string, number[]>();
  let nextMutateReply: unknown = {
    kind: "mutationApplied",
    payload: { createdId: null, pageIds: ["p1"] },
  };
  let elementPropertiesReply: unknown = {
    kind: "elementProperties",
    payload: { result: null },
  };
  // B-22 (v57) — scripted `planarRegions` reply. `null` = this fake
  // engine predates the door, so `send` falls through to the generic
  // `noop` (the honest unsupported path the adapter must survive).
  let planarRegionsReply: unknown = null;
  // v67 — scripted `snapPoint` reply; `null` = a pre-v67 engine.
  let snapPointReply: unknown = null;
  /** Every message that crossed `client.send`, in order. */
  const sent: { kind: string; payload?: unknown }[] = [];

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
    send: async (msg: { kind: string; payload?: unknown }) => {
      sent.push({ kind: msg.kind, payload: msg.payload });
      if (msg.kind === "requestPlanarRegions" && planarRegionsReply !== null) {
        return planarRegionsReply;
      }
      if (msg.kind === "requestSnapPoint" && snapPointReply !== null) {
        return snapPointReply;
      }
      if (msg.kind === "hitTest") {
        return { kind: "hitResult", payload: { element: null } };
      }
      if (msg.kind === "requestSceneTree") {
        return { kind: "sceneTree", payload: { roots: sceneTreeRoots } };
      }
      if (msg.kind === "requestElementProperties") {
        return elementPropertiesReply;
      }
      if (msg.kind === "writePagedPart") {
        const m = msg as unknown as { payload: { path: string; bytes: number[] } };
        pagedParts.set(m.payload.path, m.payload.bytes);
        return { kind: "pagedPartWritten", payload: {} };
      }
      if (msg.kind === "readPagedPart") {
        const m = msg as unknown as { payload: { path: string } };
        const b = pagedParts.get(m.payload.path);
        return { kind: "pagedPartRead", payload: { found: b !== undefined, bytes: b ?? [] } };
      }
      if (msg.kind === "deletePagedPart") {
        const m = msg as unknown as { payload: { path: string } };
        const existed = pagedParts.delete(m.payload.path);
        return { kind: "pagedPartDeleted", payload: { existed } };
      }
      if (msg.kind === "listPagedParts") {
        const m = msg as unknown as { payload: { prefix: string } };
        const paths = [...pagedParts.keys()].filter((p) => p.startsWith(m.payload.prefix));
        return { kind: "pagedPartList", payload: { paths } };
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
      menus,
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
        toolPreviews = null;
      },
      // K-9 — present ONLY when the test asks for it, so the same fake
      // covers both hosts the door must serve (multi-shape sink wired /
      // not wired).
      ...(opts?.multiPreview
        ? {
            setToolPreviews: (v: unknown) => {
              toolPreviews = v;
              toolPreview = null;
            },
          }
        : {}),
    },
    ...(opts?.images ? { images: opts.images } : {}),
  };

  return {
    setElementProperties(reply: unknown) {
      elementPropertiesReply = reply;
    },
    /** B-22 — script the `requestPlanarRegions` reply (pass `null` to go
     *  back to a pre-v57 engine that never answers the kind). */
    setPlanarRegionsReply(reply: unknown) {
      planarRegionsReply = reply;
    },
    /** v67 — script the `requestSnapPoint` reply. */
    setSnapPointReply(reply: unknown) {
      snapPointReply = reply;
    },
    /** Every `client.send` message, in order (kind + payload). */
    sent,
    /** The menu registry, so a test can count what `contribute.menu`
     *  registered and inspect the `when` the SDK derived from `scope`. */
    menus,
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
    /** K-9 — the last LIST written through `setToolPreviews` (only ever
     *  non-null when the fake was built with `multiPreview: true`). */
    getToolPreviews: () => toolPreviews,
    /** C-16 — script the scene tree the parentage read derives from.
     *  Counts the `requestSceneTree` sends via `sent`, which is how the
     *  memoization is asserted. */
    setSceneTree: (roots: unknown[]) => {
      sceneTreeRoots = roots;
    },
    setNextMutateReply: (r: unknown) => {
      nextMutateReply = r;
    },
  };
}
