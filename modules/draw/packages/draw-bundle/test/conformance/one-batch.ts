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

// THE HOSTS A ONE-BATCH FLOW IS RUN AGAINST, besides the real one.
//
// A view of the REAL headless host with one thing taken away — the
// engine still answers everything else, so what a flow leaves in the
// document can be compared element by element with what the real host
// leaves:
//
//  · `refusingBindCreated` — an engine that refuses `bindCreated` (as one
//    before C-15 did). It refuses any batch carrying a `bindCreated`
//    child, which is what sends a flow down its STEPWISE lane (the two
//    batches it was before).
//
// (Until B3b this file also held views of an SDK whose outcome carried no
// `minted`, and of a host without the raw client, for the reply and diff
// lanes `src/commands/minted.ts` no longer has.)
//
// AND HOW TWO RUNS ARE COMPARED. A batch can apply and still be the wrong
// edit, so "one batch" is never asserted alone: `runThrough` runs a flow
// through one of the `LANES`, describes the document it left
// (`documentPicture` — the tree, every leaf's paint, outline and links,
// the selection, the recipe parts), measures the undo steps against the
// undo log, checks that taking exactly those steps back restores the
// document, and then puts everything back so the next lane starts from
// the same place. Two lanes agree when their pictures are EQUAL.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  MutationOutcome,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { countingHost, type WorkLog } from "../perf/counting-host";

/** A view of `host` with `document.mutate` replaced. */
function withMutate(
  host: BundleHost,
  mutate: (
    mutation: MutationInput,
    real: BundleHost["document"]["mutate"],
  ) => Promise<MutationOutcome>,
): BundleHost {
  const real: BundleHost["document"]["mutate"] = (mutation) =>
    host.document.mutate(mutation);
  const document = new Proxy(host.document, {
    get(target, prop, receiver) {
      if (prop !== "mutate") return Reflect.get(target, prop, receiver) as unknown;
      return (mutation: MutationInput) => mutate(mutation, real);
    },
  });
  return new Proxy(host, {
    get(target, prop, receiver) {
      return prop === "document"
        ? document
        : (Reflect.get(target, prop, receiver) as unknown);
    },
  });
}

const carriesBind = (mutation: MutationInput): boolean =>
  mutation.op === "batch" &&
  (mutation.args as { ops: readonly MutationInput[] }).ops.some(
    (op) => op.op === "bindCreated",
  );

/** The sentence a refused bind batch is answered with here. */
export const NO_BIND_CREATED =
  "unknown variant `bindCreated` — the spec standing in for an engine that predates C-15";

/** An engine without `bindCreated`: every batch that carries one is
 *  refused, everything else passes through. */
export function refusingBindCreated(host: BundleHost): BundleHost {
  return withMutate(host, (mutation, real) =>
    carriesBind(mutation)
      ? Promise.resolve({ applied: false, error: NO_BIND_CREATED })
      : real(mutation),
  );
}

// ------------------------------------------------------------ undo steps
//
// AN UNDO STEP IS MEASURED, never derived from the mutation count (the
// rule `test/perf/workload.ts` states, with the measurement that earned
// it). The raw client's replies carry what the facade drops: a
// `mutationApplied` names the `appliedSeq` it was logged under and an
// `undoApplied` names the `undoneSeq` it reverted. So a MARK is one
// state-neutral, undoable write; undo until its seq comes back, and
// every undo before it was a step the measured code left behind.

interface RawReply {
  kind: string;
  payload?: { appliedSeq?: number; undoneSeq?: number };
}

/** Put a mark on the undo stack: re-write `carrier`'s fill with the value
 *  it already has. Nothing changes, no element is added, and the engine
 *  logs it. */
export async function undoMarkOn(
  h: HeadlessHost,
  carrier: ElementId,
): Promise<number> {
  const props = await h.host.document.elementProperties(carrier);
  const fill = props?.entries.find((e) => e.path === "frameFillColor")?.value;
  if (!fill || fill.type !== "colorRef") {
    throw new Error("undoMarkOn: the carrier exposes no frameFillColor");
  }
  const reply = (await h.host.editor.client.mutate({
    op: "setElementProperty",
    args: {
      elementId: carrier,
      path: "frameFillColor",
      value: { type: "colorRef", value: fill.value },
    },
  })) as RawReply;
  const seq = reply.payload?.appliedSeq;
  if (reply.kind !== "mutationApplied" || typeof seq !== "number") {
    throw new Error(`undoMarkOn: the mark was refused — ${JSON.stringify(reply)}`);
  }
  return seq;
}

/** How many undo steps the document gained since `mark` — and take them
 *  all back, the mark included. Throws rather than guessing. */
export async function undoStepsBackTo(
  h: HeadlessHost,
  mark: number,
  limit = 500,
): Promise<number> {
  for (let steps = 0; steps <= limit; steps++) {
    const reply = (await h.host.editor.client.undo()) as RawReply;
    if (reply.kind !== "undoApplied") {
      throw new Error(
        `undoStepsBackTo: undo #${steps + 1} was refused — ${JSON.stringify(reply)}`,
      );
    }
    const undone = reply.payload?.undoneSeq;
    if (undone === mark) return steps;
    if (typeof undone === "number" && undone < mark) {
      throw new Error(`undoStepsBackTo: undid past the mark (${undone} < ${mark})`);
    }
  }
  throw new Error(`undoStepsBackTo: the mark did not come back in ${limit} undos`);
}

// ------------------------------------------------------- document pictures

/** The scene tree as nested ids — `u1 u2 g[u3 u4]`. Two documents with
 *  the same string have the same elements in the same order under the
 *  same groups. */
export function treeShapeOf(roots: readonly SceneTreeNode[]): string {
  return roots
    .map((node) => {
      const below = treeShapeOf(node.children ?? []);
      if (!node.id) return below;
      const id =
        typeof node.id.id === "string" ? node.id.id : JSON.stringify(node.id.id);
      return node.id.kind === "group" || (node.children ?? []).length > 0
        ? `${id}[${below}]`
        : id;
    })
    .filter((s) => s.length > 0)
    .join(" ");
}

/** {@link treeShapeOf} of the live document. */
export async function treeShape(h: HeadlessHost): Promise<string> {
  return treeShapeOf(await h.host.document.tree());
}

/** One leaf as the document holds it: what it looks like and what it
 *  links to. */
interface LeafPicture {
  kind: string;
  fill: unknown;
  stroke: unknown;
  weight: unknown;
  opacity: unknown;
  anchors: unknown;
  subpathStarts: unknown;
  subpathOpen: unknown;
  metadata: unknown;
}

/**
 * EVERYTHING a flow can change, as one comparable value: the tree, per
 * leaf its paint, its outline and this plugin's metadata, the selection,
 * and — for the recipe `parts` named — what the container holds.
 *
 * `names: "ordinal"` writes every element id — in the tree, inside the
 * metadata, in the selection and in the recipes — as its position in
 * tree order (`#7`) instead of the id the engine minted. Two RUNS of a
 * flow mint their own ids, so that is how "the stepwise lane leaves the
 * same document as the one batch" is compared; `"id"` keeps the real
 * ids, which is how "one undo restores the document" is.
 */
export async function documentPicture(
  h: HeadlessHost,
  names: "id" | "ordinal" = "id",
  parts: readonly string[] = [],
): Promise<string> {
  const roots = await h.host.document.tree();
  const order: ElementId[] = [];
  const walk = (nodes: readonly SceneTreeNode[]): void => {
    for (const node of nodes) {
      if (node.id) order.push(node.id);
      walk(node.children ?? []);
    }
  };
  walk(roots);
  const ordinal = new Map<string, string>();
  order.forEach((id, i) => {
    if (typeof id.id === "string") ordinal.set(id.id, `#${i}`);
  });
  const rename = (value: unknown): unknown => {
    if (names === "id") return value;
    if (typeof value === "string") return ordinal.get(value) ?? value;
    if (Array.isArray(value)) return value.map(rename);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, rename(v)]),
      );
    }
    return value;
  };
  const leaves: Record<string, LeafPicture> = {};
  for (const id of order) {
    if (id.kind === "group" || typeof id.id !== "string") continue;
    const props = await h.host.document.elementProperties(id);
    const value = (path: string): unknown =>
      props?.entries.find((e) => e.path === path)?.value ?? null;
    const table = await h.host.document.pathAnchors(id).catch(() => null);
    leaves[String(rename(id.id))] = {
      kind: id.kind,
      fill: value("frameFillColor"),
      stroke: value("frameStrokeColor"),
      weight: value("frameStrokeWeight"),
      opacity: value("frameOpacity"),
      anchors: table?.anchors ?? null,
      subpathStarts: table?.subpathStarts ?? null,
      subpathOpen: table?.subpathOpen ?? null,
      metadata: rename(await h.host.document.getMetadata(id).catch(() => null)),
    };
  }
  const recipes: Record<string, unknown> = {};
  for (const path of parts) {
    const bytes = await h.host.parts.read(path).catch(() => null);
    let parsed: unknown = null;
    try {
      parsed = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch {
      parsed = "unreadable";
    }
    recipes[path] = rename(parsed);
  }
  const shape = treeShapeOf(roots);
  return JSON.stringify({
    tree:
      names === "id"
        ? shape
        : shape.replace(/[A-Za-z0-9_]+/g, (id) => ordinal.get(id) ?? id),
    leaves,
    selection: rename(h.host.selection.get()),
    recipes,
  });
}

/** A {@link documentPicture} with the selection taken out — what "undo
 *  restored the document" compares: the selection is the host's, and no
 *  undo puts it back. */
export function withoutSelection(picture: string): string {
  const parsed = JSON.parse(picture) as Record<string, unknown>;
  delete parsed.selection;
  return JSON.stringify(parsed);
}

/** Every container part the bundle holds, by path — a recipe part is NOT
 *  on the undo stack, so a scenario that runs a flow and undoes it puts
 *  the recipes back itself. */
export async function snapshotRecipes(
  h: HeadlessHost,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const path of await h.host.parts.list()) {
    const bytes = await h.host.parts.read(path);
    if (bytes) out.set(path, new Uint8Array(bytes));
  }
  return out;
}

/** Write a {@link snapshotRecipes} back, and empty what it did not hold. */
export async function restoreRecipes(
  h: HeadlessHost,
  snapshot: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  for (const path of await h.host.parts.list()) {
    if (!snapshot.has(path)) await h.host.parts.write(path, new Uint8Array());
  }
  for (const [path, bytes] of snapshot) {
    await h.host.parts.write(path, new Uint8Array(bytes));
  }
}

// ------------------------------------------------------------- the lanes

/** The hosts a flow is run through. `oneBatch` is the flow as shipped
 *  (its created ids come off the OUTCOME); `stepwise` refuses the bind
 *  (the file header). */
export const LANES = {
  oneBatch: (host: BundleHost): BundleHost => host,
  stepwise: refusingBindCreated,
} as const;

export type LaneName = keyof typeof LANES;

/** What one run of a flow through one lane left behind. */
export interface LaneRun<T> {
  result: T;
  /** The document right after the flow, ids as ordinals — comparable
   *  between two runs. */
  picture: string;
  /** What the flow asked of the host. */
  work: WorkLog;
  /** Undo steps the flow left, measured against the undo log. */
  undoSteps: number;
  /** Did taking exactly those steps back restore the document? */
  restored: boolean;
}

/**
 * Run `command` through `lane` over the live document, describe what it
 * left, and put the document back — recipes included.
 *
 * `setup` runs first, uncounted, and is undone too. `carrier` is any
 * leaf of the fixture (the undo mark is a no-op write on it).
 */
export async function runThrough<T>(
  h: HeadlessHost,
  lane: LaneName,
  run: {
    carrier: ElementId;
    parts?: readonly string[];
    setup?: () => Promise<void>;
    select?: readonly ElementId[];
    command: (host: BundleHost) => Promise<T>;
  },
): Promise<LaneRun<T>> {
  const recipes = await snapshotRecipes(h);
  const outer = await undoMarkOn(h, run.carrier);
  if (run.setup) await run.setup();
  if (run.select) await h.host.selection.set([...run.select]);
  const before = withoutSelection(await documentPicture(h, "id"));
  const mark = await undoMarkOn(h, run.carrier);
  const { host, work } = countingHost(LANES[lane](h.host));
  const result = await run.command(host);
  const counted = work.snapshot();
  const picture = await documentPicture(h, "ordinal", run.parts ?? []);
  const undoSteps = await undoStepsBackTo(h, mark);
  const restored = withoutSelection(await documentPicture(h, "id")) === before;
  await undoStepsBackTo(h, outer);
  await restoreRecipes(h, recipes);
  await h.host.selection.set([]);
  return { result, picture, work: counted, undoSteps, restored };
}
