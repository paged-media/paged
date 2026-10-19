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

// Shared pieces of the built-in command tests: the editor's REAL typed
// client (`CanvasClient`'s methods) over the test kit's recording fake, a
// scene-tree builder, and the scripted replies the object verbs read.

import { CanvasClient } from "@paged-media/client";
import type {
  ElementId,
  ElementProperties,
  LayerSummary,
  MainToWorkerKind,
  Mutation,
  SceneTreeNode,
  WorkerToMain,
} from "@paged-media/client";
import {
  createFakeShellEditor,
  type ShellFakeEditor,
  type ShellFakeOptions,
} from "@paged-media/test-kit";

/**
 * A `CanvasClient` whose transport is `send`. Every typed method of the
 * real client (`sceneTree`, `layers`, `elementProperties`, `mutate`, …)
 * is a thin wrapper over `this.send`, so the command runners exercise the
 * client the app ships, and the fake records every message it posts.
 */
export function typedClient(
  send: (m: MainToWorkerKind) => Promise<WorkerToMain>,
): CanvasClient {
  const client = Object.create(CanvasClient.prototype) as CanvasClient;
  Object.defineProperty(client, "send", { value: send });
  return client;
}

// ── scene trees ─────────────────────────────────────────────────────

export const id = (kind: string, raw: string) =>
  ({ kind, id: raw }) as unknown as ElementId;

export const leaf = (kind: string, raw: string): SceneTreeNode => ({
  id: id(kind, raw),
  kind,
  label: raw,
  children: [],
});

export const group = (raw: string, ...children: SceneTreeNode[]) =>
  ({
    id: id("group", raw),
    kind: "group",
    label: raw,
    children,
  }) as SceneTreeNode;

export const page = (...items: SceneTreeNode[]): SceneTreeNode => ({
  id: null,
  kind: "Page",
  label: "1",
  children: items,
});

export const spread = (...pages: SceneTreeNode[]): SceneTreeNode => ({
  id: null,
  kind: "Spread",
  label: "Spread 1",
  children: pages,
});

// ── the fake ────────────────────────────────────────────────────────

export interface ScriptedDocument {
  tree?: SceneTreeNode[];
  layers?: LayerSummary[];
  /** `requestElementProperties` per element key (`kind:id`). */
  properties?: Record<string, ElementProperties | null>;
  /** Override the mutate reply (return undefined for the default). */
  mutate?: (m: Mutation) => WorkerToMain | undefined;
}

export const key = (e: ElementId) =>
  `${e.kind}:${String((e as { id: unknown }).id)}`;

export function layer(selfId: string, z: number): LayerSummary {
  return {
    selfId,
    name: selfId,
    visible: true,
    locked: false,
    printable: true,
    z,
  } as LayerSummary;
}

/** A recording fake whose replies answer the reads the object, insert and
 *  select-all verbs make. Unscripted reads keep the kit's defaults. */
export function scriptedFake(
  doc: ScriptedDocument,
  options: ShellFakeOptions = {},
): ShellFakeEditor {
  return createFakeShellEditor({
    ...options,
    reply(message) {
      const scripted = options.reply?.(message);
      if (scripted) return scripted;
      const m = message as { kind: string; payload?: Record<string, unknown> };
      if (m.kind === "requestSceneTree" && doc.tree)
        return { kind: "sceneTree", payload: { roots: doc.tree } };
      if (m.kind === "requestLayers")
        return { kind: "layers", payload: { items: doc.layers ?? [] } };
      if (m.kind === "requestElementProperties") {
        const target = m.payload?.id as ElementId;
        return {
          kind: "elementProperties",
          payload: { result: doc.properties?.[key(target)] ?? null },
        };
      }
      if (m.kind === "mutate" && doc.mutate) {
        return doc.mutate(m.payload as unknown as Mutation);
      }
      return undefined;
    },
  });
}

/** A `mutationFailed` reply with an engine sentence. */
export function refused(what: string): WorkerToMain {
  return {
    kind: "mutationFailed",
    payload: { error: { kind: "notImplemented", details: { what } } },
  } as unknown as WorkerToMain;
}

/** A `mutationApplied` reply that names a created element. */
export function appliedWith(createdId: ElementId | null): WorkerToMain {
  return {
    kind: "mutationApplied",
    payload: {
      clientSeq: 0,
      appliedSeq: 1,
      pageIds: ["page-1"],
      cacheStats: null,
      createdId,
    },
  } as unknown as WorkerToMain;
}

/** The mutations the fake carried, in order. */
export const sent = (fake: ShellFakeEditor): Mutation[] => fake.mutations();
