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

// THE COMMAND CONFORMANCE KIT — what every `commands-*.spec.ts` in this
// directory asks of a command, against the REAL engine:
//
//   · it CHANGES THE MODEL when it applies (`expectApplies`): the whole
//     model is dumped before and after — the scene tree, every element's
//     properties (plugin metadata included), the document meta and the
//     page / spread / swatch / layer collections — and must differ;
//   · that change is ONE undo step: one undo restores the dump byte for
//     byte and one redo re-applies it byte for byte (INV-1 + INV-4, the
//     gesture kit's `checkUndoRedo`);
//   · it is DISABLED where it does not apply (`expectRefuses`): with the
//     wrong selection the model is byte-identical afterwards and the
//     undo stack did not move.
//
// What the dump does not hold: the bundle's container parts (a recipe
// part is not on the undo stack, by design: `one-batch.ts`) and the
// selection (the host's, and no undo puts it back). A command whose
// whole effect is the selection is asserted with `expectSelects`.

import { expect } from "bun:test";

import type {
  CommandContribution,
  ElementId,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import {
  checkUndoRedo,
  engineModelChannel,
  InvariantError,
  stableJson,
  type InvariantId,
  type ModelChannel,
} from "@paged-media/test-kit";

import { drawBundle } from "../../src";
import { openHost } from "./host";

/** A booted host with paged.draw activated, and a model channel over it. */
export interface CommandRig {
  h: HeadlessHost;
  channel: ModelChannel;
  /** Load a fixture and select `selection` in it. */
  open(bytes: Uint8Array, selection?: readonly ElementId[]): Promise<void>;
  /** Run a command's REGISTERED handler, as the editor dispatches it. */
  run(id: string, payload?: unknown): Promise<unknown>;
  dispose(): void;
}

export async function commandRig(): Promise<CommandRig> {
  const h = await openHost();
  h.loadBundle(drawBundle);
  const channel = drawModelChannel(h);
  const commandOf = (id: string): CommandContribution => {
    const rec = h.contributions.find(
      (c) => c.kind === "command" && c.id === id,
    );
    if (!rec) throw new Error(`paged.draw registered no command ${id}`);
    return rec.value as CommandContribution;
  };
  return {
    h,
    channel,
    async open(bytes, selection = []) {
      await h.load(bytes);
      await h.host.selection.set([...selection]);
    },
    run: (id, payload) =>
      Promise.resolve(commandOf(id).handler(undefined, payload)),
    dispose: () => h.dispose(),
  };
}

/**
 * The gesture kit's engine model channel, plus what a path command
 * changes and the base dump does not read: every element's ANCHOR TABLE
 * (`pathAnchors`) and its geometry (`elementGeometry`: bounds and item
 * transform). Element properties alone do not carry the outline.
 */
export function drawModelChannel(h: HeadlessHost): ModelChannel {
  const base = engineModelChannel((message) =>
    h.host.editor.client.send(message),
  );
  return {
    async dump() {
      const ids: ElementId[] = [];
      const walk = (nodes: readonly SceneTreeNode[]): void => {
        for (const node of nodes) {
          if (node.id) ids.push(node.id);
          walk(node.children ?? []);
        }
      };
      walk(await h.host.document.tree());
      const outlines: unknown[] = [];
      for (const id of ids) {
        outlines.push({
          id,
          anchors: await h.host.document.pathAnchors(id).catch(() => null),
          geometry: await h.host.document
            .elementGeometry([id])
            .catch(() => null),
        });
      }
      return `${await base.dump()}\n${stableJson(outlines)}`;
    },
    undo: () => base.undo(),
    redo: () => base.redo(),
  };
}

/** The command changes the model, as ONE undo step that undoes and
 *  redoes exactly. Returns the dumps for a domain assertion. */
export async function expectApplies(
  rig: CommandRig,
  id: string,
  payload?: unknown,
): Promise<{ before: string; after: string }> {
  const report = await checkUndoRedo(
    rig.channel,
    () => rig.run(id, payload),
    id,
  );
  expect(report.changed, `${id} changed nothing in the model`).toBe(true);
  return { before: report.before, after: report.after };
}

/** The command does not apply to `selection` in `bytes`: opened fresh
 *  (so the undo stack is empty), the command runs, the model is
 *  byte-identical afterwards and an undo finds nothing to take. */
export async function expectRefuses(
  rig: CommandRig,
  bytes: Uint8Array,
  selection: readonly ElementId[],
  id: string,
  payload?: unknown,
): Promise<void> {
  await rig.open(bytes, selection);
  const before = await rig.channel.dump();
  await rig.run(id, payload);
  expect(await rig.channel.dump(), `${id} changed the model`).toBe(before);
  const undo = await rig.h.host.editor.client.send({ kind: "undo" });
  expect(undo.kind, `${id} put a step on the undo stack`).not.toBe(
    "undoApplied",
  );
}

/** The command's effect is the SELECTION: it selects what `expected`
 *  says (as a set of ids) and leaves the model alone. */
export async function expectSelects(
  rig: CommandRig,
  id: string,
  expected: (selection: readonly ElementId[]) => void,
  payload?: unknown,
): Promise<void> {
  const before = await rig.channel.dump();
  await rig.run(id, payload);
  expect(await rig.channel.dump(), `${id} changed the model`).toBe(before);
  expected(rig.h.host.selection.get());
}

/** How many writes the engine committed while `run` ran — every
 *  `mutationApplied` / `gestureCommitted` the host fanned out. A write is
 *  an undo step; zero means the stack did not move. */
export async function writesDuring(
  rig: CommandRig,
  run: () => Promise<unknown>,
): Promise<number> {
  let writes = 0;
  const off = rig.h.host.editor.client.subscribe((msg) => {
    if (msg.kind === "mutationApplied" || msg.kind === "gestureCommitted") {
      writes++;
    }
  });
  try {
    await run();
  } finally {
    off();
  }
  return writes;
}

/** Every container part the bundle holds, as text, keyed by path. */
async function partsOf(rig: CommandRig): Promise<string> {
  const out: Record<string, string> = {};
  for (const path of (await rig.h.host.parts.list()).sort()) {
    const bytes = await rig.h.host.parts.read(path);
    out[path] = bytes ? new TextDecoder().decode(bytes) : "";
  }
  return JSON.stringify(out);
}

/** The command's whole effect is a LIBRARY in a container part (a
 *  symbol or style definition): the part changes, the model does not,
 *  and nothing goes on the undo stack — a library is not undoable by
 *  design (`one-batch.ts`). Returns the parts after, for an assertion. */
export async function expectLibraryOnly(
  rig: CommandRig,
  id: string,
  payload?: unknown,
): Promise<string> {
  const model = await rig.channel.dump();
  const parts = await partsOf(rig);
  const writes = await writesDuring(rig, () => rig.run(id, payload));
  expect(await rig.channel.dump(), `${id} changed the model`).toBe(model);
  const after = await partsOf(rig);
  expect(after, `${id} left the library as it was`).not.toBe(parts);
  expect(writes, `${id} wrote to the document`).toBe(0);
  return after;
}

/**
 * How many undo steps it takes to get from the model `run` leaves back
 * to the one before it (opened fresh, so the stack holds only `run`'s
 * steps). One is the contract; a finding names the number it measured.
 */
export async function undoStepsOf(
  rig: CommandRig,
  run: () => Promise<unknown>,
): Promise<number> {
  const before = await rig.channel.dump();
  await run();
  let steps = 0;
  while ((await rig.channel.dump()) !== before) {
    const reply = await rig.h.host.editor.client.send({ kind: "undo" });
    if (reply.kind !== "undoApplied") return -1;
    steps++;
  }
  return steps;
}

/**
 * A FINDING, as an expected failure: `run` breaks `invariant` today.
 * Only that invariant's error is rethrown, so an `it.failing` around it
 * passes for the finding's reason and for no other — a different error,
 * or none at all (the bug fixed), makes the expected failure fail.
 */
export async function brokenInvariant(
  invariant: InvariantId,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof InvariantError && error.invariant === invariant) {
      throw error;
    }
    console.error(`expected ${invariant} to break, got:`, error);
  }
}

/** An element id of the kind the fixtures author. */
export const el = (kind: ElementId["kind"], id: string): ElementId =>
  ({ kind, id }) as ElementId;
