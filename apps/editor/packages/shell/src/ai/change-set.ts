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

// Editor ADR 1241 — a PROPOSAL is a change set of ordinary writes: each item
// one property of one object (an object-model `set`, the write every panel
// field makes) or one object label (the engine's `setPluginMetadata`), with
// the value before and after and why. A rule or Claude proposes; nothing
// here writes until `applyChangeSet`, which the user's Approve calls: the
// approved items land as ONE undo step through the normal pipeline (the
// object model's batch inside the client's undo group, engine ADR 1004), so
// the policy checks every write as it checks a panel's, and one Undo takes
// the change back. There are no assistant-only mutation semantics.

import type { ShellObjectsSurface } from "../catalog/object-model-types";

/** How an item is written. */
export type ChangeWrite =
  /** `host.objects` `set` of `path` on `address`. */
  | { kind: "set" }
  /** The engine's `setPluginMetadata` on the element (an `x-paged:` label
   *  the editor owns, such as the alternative text). */
  | { kind: "label"; key: string };

export interface ChangeItem {
  id: string;
  /** The object it changes (ADR 131). */
  address: string;
  /** The property path, or the label key for a label write. */
  path: string;
  /** What it is, in words: a text's first words, an object's kind. */
  subject: string;
  before: unknown;
  /** The value Approve writes. */
  after: unknown;
  reason: string;
  /** The rule or the source that proposed it. */
  rule: string;
  write?: ChangeWrite;
  /** The user supplies the value (alternative text): Approve refuses the
   *  item while `after` is empty. */
  needsValue?: boolean;
}

export interface ChangeSet {
  id: string;
  /** `checks` (deterministic rules, on this device) or `claude`. */
  source: "checks" | "claude";
  title: string;
  summary: string;
  items: ChangeItem[];
}

/** What applying needs: the object model and the client's write doors. */
export interface ApplyDoors {
  objects: Pick<ShellObjectsSurface, "batch">;
  /** A raw write (a label): the client's `mutate`. */
  mutate(
    mutation: unknown,
    options?: { label?: string },
  ): Promise<{ kind: string }>;
  beginUndoGroup?(options?: { continueSeq?: number | null }): void;
  endUndoGroup?(): Promise<{
    steps: number;
    writes: number;
    lastSeq: number | null;
  } | null>;
  /** The element a label is written on, from its address. */
  elementIdOf(address: string): unknown;
  /** Undo down to the step `seq` (a refused label after the batch applied:
   *  the approval is all or nothing). */
  undoTo?(seq: number): Promise<unknown>;
}

export interface ApplyResult {
  applied: number;
  /** Undo steps the approval became: 1 when the group held it. */
  undoSteps: number;
  /** The step to undo it with, when it is one. */
  lastSeq: number | null;
  /** Why it was refused (nothing applied), or null. */
  refused: string | null;
}

/** The items `accepted` names that can be applied (a value the user must
 *  supply and has not is left out). */
export function applicableItems(
  set: ChangeSet,
  accepted: ReadonlySet<string>,
): ChangeItem[] {
  return set.items.filter(
    (i) =>
      accepted.has(i.id) &&
      !(i.needsValue && (i.after === "" || i.after == null)),
  );
}

/**
 * Apply the approved items as ONE undo step. The object-model writes are
 * one batch (validated and planned before anything applies: all or
 * nothing); label writes join it through the client's undo group.
 */
export async function applyChangeSet(
  items: readonly ChangeItem[],
  doors: ApplyDoors,
  label: string,
): Promise<ApplyResult> {
  if (items.length === 0)
    return { applied: 0, undoSteps: 0, lastSeq: null, refused: null };
  const sets = items.filter((i) => (i.write?.kind ?? "set") === "set");
  const labels = items.filter((i) => i.write?.kind === "label");
  doors.beginUndoGroup?.({});
  let refused: string | null = null;
  if (sets.length > 0) {
    const result = await doors.objects.batch(
      sets.map((i) => ({
        op: "set" as const,
        address: i.address,
        path: i.path,
        value: i.after,
      })),
      { label },
    );
    if (!result.applied) refused = result.reason ?? "refused";
  }
  const batchApplied = sets.length > 0 && !refused;
  if (!refused) {
    for (const i of labels) {
      const elementId = doors.elementIdOf(i.address);
      if (!elementId) {
        refused = `${i.address}: not an element`;
        break;
      }
      const reply = await doors.mutate(
        {
          op: "setPluginMetadata",
          args: {
            elementId,
            key: (i.write as { key: string }).key,
            value: JSON.stringify({ v: 1, data: { text: String(i.after) } }),
          },
        },
        { label },
      );
      if (reply.kind !== "mutationApplied") {
        refused = `${i.address}: ${reply.kind}`;
        break;
      }
    }
  }
  const group = (await doors.endUndoGroup?.()) ?? null;
  // All or nothing: a label refused after the batch landed takes the batch
  // back (it is the group's one step).
  if (refused && batchApplied && group?.lastSeq != null && group.steps === 1)
    await doors.undoTo?.(group.lastSeq);
  return {
    applied: refused ? 0 : items.length,
    undoSteps: group?.steps ?? (refused ? 0 : 1),
    lastSeq: group?.lastSeq ?? null,
    refused,
  };
}

/** A value as the preview shows it. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
