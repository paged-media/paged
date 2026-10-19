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

// THE COMMAND UNIT KIT — paged.draw's commands with NO ENGINE.
//
// The real bundle is activated through the real host adapter
// (`loadBundle`) over the test kit's recording fake editor, and a command
// runs through the handler it registered, as the editor dispatches it.
// What the fake cannot do is compute geometry, so the unit layer asserts
// what a command DECIDES and SENDS: which mutations, aimed at which
// elements, as how many undo steps; that it refuses (and says so) where it
// does not apply; and, for a "…" command, that it raises its panel at the
// right section. Whether the engine turns those mutations into the right
// model, and whether one undo takes them back, is the headless layer's
// question (`test/headless/commands-*.spec.ts`).
//
// The fake document answers the reads the commands make: element
// properties (with this plugin's metadata), the scene tree (with its
// per-row metadata and groups), anchor tables, geometry and the container
// parts. It applies the writes a later read depends on — inserted paths
// (with the ids a batch's `bindCreated` handles name, reported back as
// `minted` the way the engine does), groups, deletions, plugin metadata
// and element properties — and records everything else. It computes no
// geometry: an outline, an offset or a boolean is the engine's.

import type {
  BundleHost,
  ElementGeometryItem,
  ElementId,
  Mutation,
  PathAnchorsResult,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import { createBundleHost } from "@paged-media/plugin-sdk";
import {
  createFakeEditor,
  flattenMutation,
  type FakeEditor,
  type WorkerToMainKindLike,
} from "@paged-media/test-kit";

import { drawBundle } from "../../src";

export const META_KEY = "x-paged:media.paged.draw";
const STATS = { hits: 0, misses: 0, len: 0, capacity: 0, rebuildMs: 0 };
export const PAGE = "page-1";

type Vec = [number, number];

/** One element of the fake document. */
export interface FakeElement {
  id: ElementId;
  /** `[top, left, bottom, right]` on the page, in pt (the wire's
   *  `elementGeometry` order). */
  bounds: [number, number, number, number];
  /** The anchor table (corners only); absent for an oval or a frame
   *  that reports none. */
  anchors?: Vec[];
  /** Where each subpath starts in `anchors` (default: one subpath). */
  starts?: number[];
  open?: boolean;
  /** Property rows, as `requestElementProperties` reports them. */
  props?: Record<string, unknown>;
  /** This plugin's metadata envelope. */
  meta?: PluginMetadataEnvelope | null;
}

export interface UnitRig {
  fake: FakeEditor;
  /** The bundle's own host (its published bindings, its storage). */
  host: BundleHost;
  /** Run a command through its registered handler and let it settle. */
  run(id: string, payload?: unknown): Promise<void>;
  /** The mutations sent since the rig was built (or `reset`). */
  sent(): Mutation[];
  /** `sent()`, every batch flattened into its leaves. */
  leaves(): Mutation[];
  /** Undo steps on the stack since `reset`: every applied mutation (a
   *  batch included) is one, every undo takes one away. */
  steps(): number;
  /** Forget what was sent (the document and the stack stay). */
  reset(): void;
  /** Every log line the bundle wrote, `level: text`. */
  logs: string[];
  /** Panels the bundle asked the shell to raise. */
  opened: string[];
  /** The element's metadata envelope as the fake holds it now. */
  metaOf(id: ElementId): PluginMetadataEnvelope | null;
  /** The container parts, decoded, keyed by path. */
  parts(): Record<string, unknown>;
  /** Every element of the fake document now, in paint order. */
  elements(): ElementId[];
  /** A comparable picture of the fake document (elements, groups,
   *  metadata), for "undo put it back" assertions. */
  picture(): string;
  /** Undo one step, as the editor's Cmd-Z would. */
  undo(): Promise<void>;
}

const key = (id: ElementId) => `${id.kind}:${String(id.id)}`;

const anchorTable = (e: FakeElement): PathAnchorsResult | null =>
  e.anchors
    ? ({
        id: e.id,
        pageId: PAGE,
        anchors: e.anchors.map((p) => ({ anchor: p, left: p, right: p })),
        subpathStarts: e.starts ?? [0],
        subpathOpen: (e.starts ?? [0]).map(() => e.open ?? false),
        itemTransform: null,
      } as unknown as PathAnchorsResult)
    : null;

/** A closed rectangle path element, given as `[x0, y0, x1, y1]`. */
export function rectEl(
  kind: ElementId["kind"],
  id: string,
  [x0, y0, x1, y1]: [number, number, number, number],
  props: Record<string, unknown> = {},
): FakeElement {
  return {
    id: { kind, id } as ElementId,
    bounds: [y0, x0, y1, x1],
    anchors: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    props: {
      frameFillColor: { type: "colorRef", value: "Color/Black" },
      frameStrokeColor: { type: "colorRef", value: "Color/Black" },
      frameStrokeWeight: { type: "length", value: 1 },
      ...props,
    },
  };
}

/** An open polyline element. */
export function openEl(
  id: string,
  anchors: Vec[],
  props: Record<string, unknown> = {},
  kind: ElementId["kind"] = "polygon",
): FakeElement {
  const xs = anchors.map((a) => a[0]);
  const ys = anchors.map((a) => a[1]);
  return {
    id: { kind, id } as ElementId,
    bounds: [
      Math.min(...ys),
      Math.min(...xs),
      Math.max(...ys),
      Math.max(...xs),
    ],
    anchors,
    open: true,
    props: {
      frameFillColor: { type: "colorRef", value: null },
      frameStrokeColor: { type: "colorRef", value: "Color/Black" },
      frameStrokeWeight: { type: "length", value: 2 },
      ...props,
    },
  };
}

/** Build the fake editor over `elements`, select `selection`, activate
 *  paged.draw. `shell: true` gives the host shell doors, so a "…"
 *  command raises its panel instead of applying. */
export function unitRig(
  elements: FakeElement[],
  options: {
    selection?: ElementId[];
    shell?: boolean;
    /** Camera scale (CSS px per pt). */
    zoom?: number;
    /** What `collection(name)` answers (`stories`, …). */
    collections?: Partial<Record<string, readonly unknown[]>>;
    /** Extra scripted replies (`requestPlanarRegions`, …). */
    reply?: (message: {
      kind: string;
      payload?: unknown;
    }) => WorkerToMainKindLike | undefined;
  } = {},
): UnitRig {
  // THE FAKE DOCUMENT. Elements in paint order; a group is an element
  // whose members point at it.
  const doc: FakeElement[] = elements.map((e) => ({ ...e }));
  const parent = new Map<string, string>();
  const byKey = () => new Map(doc.map((e) => [key(e.id), e]));
  const byRawId = (id: string) => doc.find((e) => String(e.id.id) === id);
  const meta = new Map<string, PluginMetadataEnvelope | null>(
    doc.map((e) => [key(e.id), e.meta ?? null]),
  );
  let minted = 0;
  let steps = 0;

  // THE UNDO STACK, as snapshots of the fake document: one per applied
  // mutation, so `undo` (the bundle's own, or a test's) puts back exactly
  // what the write changed.
  type Snapshot = {
    doc: FakeElement[];
    parent: Map<string, string>;
    meta: Map<string, PluginMetadataEnvelope | null>;
  };
  const snapshot = (): Snapshot => ({
    doc: doc.map((e) => structuredClone(e)),
    parent: new Map(parent),
    meta: new Map([...meta].map(([k, v]) => [k, structuredClone(v)])),
  });
  const restore = (snap: Snapshot) => {
    doc.splice(0, doc.length, ...snap.doc);
    parent.clear();
    for (const [k, v] of snap.parent) parent.set(k, v);
    meta.clear();
    for (const [k, v] of snap.meta) meta.set(k, v);
  };
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  const history = (action: "undo" | "redo"): WorkerToMainKindLike => {
    const from = action === "undo" ? undoStack : redoStack;
    const to = action === "undo" ? redoStack : undoStack;
    const snap = from.pop();
    if (!snap) {
      return {
        kind: "mutationFailed",
        payload: {
          error: {
            kind: "notImplemented",
            details: { what: "undo log empty" },
          },
        },
      };
    }
    to.push(snapshot());
    restore(snap);
    steps += action === "undo" ? -1 : 1;
    const base = { appliedSeq: steps, pageIds: [PAGE], cacheStats: STATS };
    return action === "undo"
      ? { kind: "undoApplied", payload: { ...base, undoneSeq: steps + 1 } }
      : { kind: "redoApplied", payload: { ...base, redoneSeq: steps } };
  };

  const entriesOf = (e: FakeElement) => {
    const rows = Object.entries(e.props ?? {}).map(([path, value]) => ({
      path,
      value,
    }));
    const env = meta.get(key(e.id));
    if (env) {
      rows.push({
        path: "pluginMetadata",
        value: {
          type: "pluginMetadata",
          value: { key: META_KEY, value: JSON.stringify(env) },
        },
      });
    }
    return rows;
  };

  /** Apply one mutation (a batch is one undo step); answer what the
   *  engine would: `createdId` (the last mint) and `minted` (every mint,
   *  with the `bindCreated` handle that named it). */
  const mutate = (m: Mutation): WorkerToMainKindLike => {
    if (m.op.startsWith("mediaPagedDraw")) {
      return {
        kind: "mutationFailed",
        payload: {
          error: {
            kind: "invalidMutation",
            details: `unknown variant \`${m.op}\`, expected one of \`closePath\`, \`joinPaths\``,
          },
        },
      };
    }
    undoStack.push(snapshot());
    redoStack.length = 0;
    const handles = new Map<string, ElementId>();
    const made: { handle: string | null; element: ElementId; storyId: null }[] =
      [];
    const resolve = (id: unknown): FakeElement | undefined => {
      if (!id || typeof id !== "object") return undefined;
      const raw = String((id as ElementId).id);
      const named = raw.startsWith("$h:") ? handles.get(raw.slice(3)) : null;
      return named
        ? byKey().get(key(named))
        : byKey().get(key(id as ElementId));
    };
    const mint = (e: FakeElement) => {
      doc.push(e);
      meta.set(key(e.id), null);
      made.push({ handle: null, element: e.id, storyId: null });
    };
    for (const leaf of flattenMutation(m)) {
      const args = (leaf as { args?: Record<string, unknown> }).args ?? {};
      switch (leaf.op) {
        case "insertPath": {
          const anchors = (
            (args.anchors as { anchor: Vec }[] | undefined) ?? []
          ).map((a) => a.anchor);
          mint(
            anchors.length
              ? {
                  ...openEl(`fake-${++minted}`, anchors),
                  open: args.open === true,
                }
              : rectEl("polygon", `fake-${++minted}`, [0, 0, 1, 1]),
          );
          break;
        }
        case "insertFrame":
        case "insertOval":
        case "insertTextFrame": {
          const b = args.bounds as [number, number, number, number];
          const kind =
            leaf.op === "insertOval"
              ? "oval"
              : leaf.op === "insertTextFrame"
                ? "textFrame"
                : "rectangle";
          mint(rectEl(kind as ElementId["kind"], `fake-${++minted}`, b));
          break;
        }
        case "bindCreated": {
          const last = made.at(-1);
          if (last) {
            last.handle = String(args.handle);
            handles.set(String(args.handle), last.element);
          }
          break;
        }
        case "createGroup": {
          const group: FakeElement = {
            id: { kind: "group", id: `fake-${++minted}` } as ElementId,
            bounds: [0, 0, 0, 0],
          };
          mint(group);
          for (const member of (args.memberIds as unknown[]) ?? []) {
            const e = resolve(member);
            if (e) parent.set(key(e.id), key(group.id));
          }
          break;
        }
        case "dissolveGroup": {
          const g = byRawId(String(args.groupId));
          if (g) {
            for (const [child, of] of [...parent]) {
              if (of === key(g.id)) parent.delete(child);
            }
            doc.splice(doc.indexOf(g), 1);
          }
          break;
        }
        case "deleteFrame": {
          const e = byRawId(String(args.frameId));
          if (e) {
            doc.splice(doc.indexOf(e), 1);
            parent.delete(key(e.id));
          }
          break;
        }
        case "setPluginMetadata": {
          const e = resolve(args.elementId);
          if (e) {
            const value = args.value as string | null | undefined;
            meta.set(key(e.id), value ? JSON.parse(value) : null);
          }
          break;
        }
        case "setElementProperty": {
          const e = resolve(args.elementId);
          if (!e) break;
          const value = args.value as { type?: string; value?: unknown };
          if (args.path === "framePath" && value?.type === "framePath") {
            const path = value.value as {
              anchors: { anchor: Vec }[];
              subpathStarts: number[];
            };
            e.anchors = path.anchors.map((a) => a.anchor);
            e.starts = path.subpathStarts;
          } else {
            e.props = { ...(e.props ?? {}), [String(args.path)]: args.value };
          }
          break;
        }
        default:
          break;
      }
    }
    steps++;
    return {
      kind: "mutationApplied",
      payload: {
        clientSeq: 0,
        appliedSeq: steps,
        pageIds: [PAGE],
        cacheStats: STATS,
        createdId: made.at(-1)?.element ?? null,
        ...(m.op === "batch" ? { minted: made } : {}),
      },
    };
  };

  // The container parts (symbol / style / recipe libraries), in memory.
  const parts = new Map<string, number[]>();

  const treeRows = () => {
    const rowOf = (e: FakeElement): Record<string, unknown> => ({
      id: e.id,
      kind: e.id.kind,
      label: String(e.id.id),
      pluginMetadata: meta.get(key(e.id))
        ? [{ key: META_KEY, value: JSON.stringify(meta.get(key(e.id))) }]
        : [],
      children: doc
        .filter((c) => parent.get(key(c.id)) === key(e.id))
        .map(rowOf),
    });
    return doc.filter((e) => !parent.has(key(e.id))).map(rowOf);
  };

  const reply = (message: { kind: string; payload?: unknown }) => {
    const scripted = options.reply?.(message);
    if (scripted) return scripted;
    const p = (message.payload ?? {}) as Record<string, unknown>;
    switch (message.kind) {
      case "mutate":
        return mutate(message.payload as Mutation);
      case "undo":
      case "redo":
        return history(message.kind);
      case "writePagedPart":
        parts.set(String(p.path), [...(p.bytes as number[])]);
        return {
          kind: "pagedPartWritten",
          payload: {},
        } as WorkerToMainKindLike;
      case "readPagedPart": {
        const bytes = parts.get(String(p.path));
        return {
          kind: "pagedPartRead",
          payload: { found: bytes !== undefined, bytes: bytes ?? [] },
        } as WorkerToMainKindLike;
      }
      case "listPagedParts":
        return {
          kind: "pagedPartList",
          payload: {
            paths: [...parts.keys()].filter((k) =>
              k.startsWith(String(p.prefix ?? "")),
            ),
          },
        } as WorkerToMainKindLike;
      case "deletePagedPart":
        return {
          kind: "pagedPartDeleted",
          payload: { existed: parts.delete(String(p.path)) },
        } as WorkerToMainKindLike;
      case "requestElementProperties": {
        const e = byKey().get(key(p.id as ElementId));
        return {
          kind: "elementProperties",
          payload: {
            result: e
              ? { id: e.id, kind: e.id.kind, entries: entriesOf(e) }
              : null,
          },
        } as WorkerToMainKindLike;
      }
      case "requestSceneTree":
        return {
          kind: "sceneTree",
          payload: {
            roots: [
              {
                id: null,
                kind: "Spread",
                label: "Spread 1",
                children: treeRows(),
              },
            ],
          },
        } as WorkerToMainKindLike;
      default:
        return undefined;
    }
  };

  const fake = createFakeEditor({
    selection: options.selection ?? [],
    ...(options.zoom ? { zoom: options.zoom } : {}),
    ...(options.collections ? { collections: options.collections } : {}),
    geometry: (id) => {
      const e = byKey().get(key(id));
      return e
        ? ({
            id: e.id,
            pageId: PAGE,
            spreadId: "spread-1",
            bounds: e.bounds,
            itemTransform: null,
            hasImage: false,
          } as unknown as ElementGeometryItem)
        : null;
    },
    pathAnchors: (id) => {
      const e = byKey().get(key(id));
      return e ? anchorTable(e) : null;
    },
    reply: reply as never,
    // The topmost element whose bounds hold the point (page space).
    hitTest: (_page, [x, y]) => {
      const hit = [...doc]
        .reverse()
        .find(
          (e) =>
            e.id.kind !== "group" &&
            y >= e.bounds[0] &&
            x >= e.bounds[1] &&
            y <= e.bounds[2] &&
            x <= e.bounds[3],
        );
      return hit?.id ?? null;
    },
    // Every element a page-space rect `[x0, y0, x1, y1]` touches.
    marqueeHits: (_page, [x0, y0, x1, y1]) =>
      doc
        .filter(
          (e) =>
            e.id.kind !== "group" &&
            e.bounds[1] <= Math.max(x0, x1) &&
            e.bounds[3] >= Math.min(x0, x1) &&
            e.bounds[0] <= Math.max(y0, y1) &&
            e.bounds[2] >= Math.min(y0, y1),
        )
        .map((e) => e.id),
  });

  const logs: string[] = [];
  const line =
    (level: string) =>
    (...args: unknown[]) =>
      void logs.push(`${level}: ${args.map(String).join(" ")}`);
  const opened: string[] = [];
  const storage = new Map<string, string>();
  // The host adapter the editor's loader builds, and the bundle activated
  // on it — kept, so a test can read what the bundle published.
  const { host } = createBundleHost(() => fake.editor, drawBundle.manifest, {
    console: {
      debug: line("debug"),
      info: line("info"),
      warn: line("warn"),
      error: line("error"),
    },
    storage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      keys: () => [...storage.keys()],
    },
    ...(options.shell
      ? {
          shell: {
            openPanel: (id: string) => void opened.push(id),
            closePanel: () => {},
            pickFile: async () => [],
          },
        }
      : {}),
  });
  drawBundle.activate(host);

  let mark = fake.mutations().length;
  let depth = steps;
  return {
    fake,
    host,
    async run(id, payload) {
      await fake.invokeCommand(id, payload);
      await fake.settle();
    },
    sent: () => fake.mutations().slice(mark),
    leaves: () => fake.mutations().slice(mark).flatMap(flattenMutation),
    steps: () => steps - depth,
    reset() {
      mark = fake.mutations().length;
      depth = steps;
      logs.length = 0;
      opened.length = 0;
    },
    logs,
    opened,
    metaOf: (id) => meta.get(key(id)) ?? null,
    elements: () => doc.map((e) => e.id),
    picture: () =>
      JSON.stringify({
        doc,
        parent: [...parent].sort(),
        meta: [...meta].sort(([a], [b]) => a.localeCompare(b)),
      }),
    async undo() {
      await fake.editor.client.send({ kind: "undo" });
      await fake.settle();
    },
    parts: () =>
      Object.fromEntries(
        [...parts].map(([path, bytes]) => {
          const text = new TextDecoder().decode(Uint8Array.from(bytes));
          try {
            return [path, JSON.parse(text)];
          } catch {
            return [path, text];
          }
        }),
      ),
  };
}
