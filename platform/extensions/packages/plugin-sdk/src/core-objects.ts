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

// The CORE half of `host.objects` (ADR 323 rule 5): one `CoreObjects`
// seam, two implementations, picked by the engine's protocol.
//
//   protocol >= 71   core-objects-v71.ts — address strings go straight to
//                    core: `Mutation::Set { address, path, value }`,
//                    `RequestGet { address, path }`, `RequestQuery
//                    { selector }` (selectors evaluated BY CORE); the rows
//                    are the vendored catalog's `propertySchemas`; core
//                    objects can be created and deleted.
//   protocol <  71   core-objects-v70.ts — the interim table over the
//                    protocol-69/70 wire (the published editor's engine
//                    until v0.71.0 ships).
//
// The protocol is FEATURE-DETECTED: an explicit `protocol` option (the
// headless harness knows its engine's), else one `requestQuery` probe —
// every engine reply carries `protocol`, and an engine that predates the
// message still answers it (as a failure), so the probe never hangs.

import type {
  ElementId,
  MutationInput,
  MutationOutcome,
  ObjectErrorCode,
  ObjectKindInfo,
  ObjectOp,
  ObjectValue,
  PagedEditor,
  ParsedAddress,
  PropertySchema,
} from "@paged-media/plugin-api";

import { createCoreObjectsV70 } from "./core-objects-v70";
import { createCoreObjectsV71 } from "./core-objects-v71";
import { PAGE_ITEM_KINDS, type SelectorStep } from "./object-address";

/** A core write plan: the ops, or a typed refusal. */
export type CorePlan =
  | { ok: true; mutations: MutationInput[] }
  | { ok: false; code: ObjectErrorCode; reason: string };

/** A core `create` plan (protocol 71). `address` is the new object's
 *  address when its id is known up front (a swatch, a style, a text
 *  variable), else `$h:<handle>`; `resolve` names the object after the
 *  commit (a minted page item, page or layer). `kind` is the SDK kind the
 *  rows of later ops on `$h:<handle>` come from. */
export type CoreCreatePlan =
  | {
      ok: true;
      mutations: MutationInput[];
      kind: string;
      address: string;
      /** Props the create op does not carry: set on the new object. */
      props?: Record<string, unknown>;
      resolve?: (outcome: MutationOutcome) => Promise<string | null>;
    }
  | { ok: false; code: ObjectErrorCode; reason: string };

/** The core backend the registry routes to. */
export interface CoreObjects {
  /** The engine protocol this seam speaks, once known (feature-detected
   *  on first use; the registry awaits it before reading rows). */
  ready?(): Promise<number>;
  kinds(): ObjectKindInfo[];
  schema(kind: string): PropertySchema[];
  get(a: ParsedAddress, path: string): Promise<ObjectValue>;
  /** Plan a write (value already schema-validated). `kind` names the SDK
   *  kind of a `$h:` handle address made earlier in the same batch. */
  planSet(a: ParsedAddress, path: string, value: unknown, kind?: string): Promise<CorePlan>;
  /** Plan a `create` of a core object (protocol 71). `handle` binds the
   *  new object for later ops of the same batch. */
  planCreate?(op: Extract<ObjectOp, { op: "create" }>, handle: string): Promise<CoreCreatePlan>;
  /** Plan a `delete` of a core object. */
  planDelete?(a: ParsedAddress): Promise<CorePlan>;
  /** The wire `ElementId` of an address (labels go here). */
  elementIdOf(a: ParsedAddress): Promise<ElementId | null>;
  /** The `x-paged:` labels on a label HOST — a page item, a story (range),
   *  a page or the document — as key → raw value; null when the address
   *  is not a label host or does not exist. */
  labelsOf(a: ParsedAddress): Promise<Record<string, string> | null>;
  /** The mutation that sets (`value`) or clears (`null`) one plugin label
   *  on a label host: `setPluginMetadata` (item / story), `setPageMetadata`
   *  (page, protocol 70) or `setDocumentMetadata` (doc); null when the
   *  address is not a label host. */
  planLabel(a: ParsedAddress, key: string, value: string | null, caller: string): Promise<MutationInput | null>;
  /** Evaluate core selector steps (no plugin steps). */
  query(steps: readonly SelectorStep[]): Promise<string[]>;
  /** Commit mutations as ONE engine mutation (a `batch` when > 1). */
  commit(mutations: readonly MutationInput[]): Promise<MutationOutcome>;
  /** Pre-71 only: remember a table's story (a `cell:` address carries
   *  none; the old wire's `TableCell` id needs it). A no-op at 71. */
  noteTableStory?(tableId: string, storyId: string): void;
  /** Engine changes (mutation / undo / redo / load). */
  onDidChange(listener: () => void): () => void;
  /** Drop derived caches (a host that loads without a broadcast). */
  invalidate(): void;
  /** Release the engine subscription (a private, per-host backend). */
  dispose(): void;
}

export interface CreateCoreObjectsOptions {
  /** The engine's protocol, when the caller knows it (skips the probe). */
  protocol?: number | (() => number | undefined);
}

/** The first protocol with `Set` / `RequestGet` / `RequestQuery`. */
export const OBJECT_MODEL_PROTOCOL = 71;

/**
 * The core seam over a live engine. Feature-detects the engine protocol
 * and delegates to the protocol-71 seam or the pre-71 table.
 */
export function createCoreObjects(getEditor: () => PagedEditor, options: CreateCoreObjectsOptions = {}): CoreObjects {
  const v70 = createCoreObjectsV70(getEditor);
  const v71 = createCoreObjectsV71(getEditor, v70);
  let protocol: number | null = null;
  let probing: Promise<number> | null = null;

  const known = (): number | null => {
    if (protocol !== null) return protocol;
    const p = typeof options.protocol === "function" ? options.protocol() : options.protocol;
    if (typeof p === "number") protocol = p;
    return protocol;
  };

  async function detect(): Promise<number> {
    const k = known();
    if (k !== null) return k;
    probing ??= (async () => {
      try {
        const reply = (await getEditor().client.send({ kind: "requestQuery", payload: { selector: "doc" } } as never)) as {
          kind?: string;
          protocol?: unknown;
        };
        const p = typeof reply.protocol === "number" ? reply.protocol : reply.kind === "queryResult" ? OBJECT_MODEL_PROTOCOL : 70;
        protocol = p;
        return p;
      } catch {
        // No editor yet, or a client that throws on an unknown message:
        // answer the old seam for now and probe again next time.
        return 70;
      } finally {
        probing = null;
      }
    })();
    return probing;
  }

  const pick = (): CoreObjects => ((known() ?? 0) >= OBJECT_MODEL_PROTOCOL ? v71 : v70);
  const on = async (): Promise<CoreObjects> => ((await detect()) >= OBJECT_MODEL_PROTOCOL ? v71 : v70);

  return {
    ready: detect,
    kinds: () => pick().kinds(),
    schema: (kind) => pick().schema(kind),
    get: async (a, path) => (await on()).get(a, path),
    planSet: async (a, path, value, kind) => (await on()).planSet(a, path, value, kind),
    planCreate: async (op, handle) => (await on()).planCreate!(op, handle),
    planDelete: async (a) => (await on()).planDelete!(a),
    elementIdOf: (a) => v70.elementIdOf(a),
    labelsOf: (a) => v70.labelsOf(a),
    planLabel: (a, key, value, caller) => v70.planLabel(a, key, value, caller),
    query: async (steps) => (await on()).query(steps),
    commit: (mutations) => v70.commit(mutations),
    noteTableStory: (tableId, storyId) => v70.noteTableStory!(tableId, storyId),
    onDidChange: (listener) => v70.onDidChange(listener),
    invalidate: () => v70.invalidate(),
    dispose: () => v70.dispose(),
  };
}

/** Every item kind word a selector may use for core frames. */
export const FRAME_KIND_WORDS: readonly string[] = ["frame", ...PAGE_ITEM_KINDS];
