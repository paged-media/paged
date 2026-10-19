// ADR 558 — committing property bindings. The engine decided every value
// (`resolve_properties_at`); `data-host-model` `planProperties` turned the
// decisions into `set` ops; this resolves what only the live document knows
// (which objects a selector names, which swatches exist) and commits the lot
// as ONE `host.objects.batch` — one undo step per apply.
//
// Host calls per apply (the count budget, `property-real-core.spec.ts`):
// one `objects.query` per DISTINCT target selector, one `swatches` read when
// a value is a colour, and one `objects.batch`. A literal colour that no
// swatch has yet is created IN that batch (`create` op, engine protocol 71):
// swatch and apply are one undo step. Before 71 `host.objects` cannot create
// a core object, so the swatch goes in one `createSwatch` mutate before the
// apply (a second undo step, first use only, one more call).

import type {
  BundleHost,
  Mutation,
  ObjectOp,
  ObjectsSurface,
} from "@paged-media/plugin-api";

import {
  planProperties,
  targetSelector,
  type PropertyApply,
  type SwatchRow,
} from "../../data-host-model/src";
import { textVariablesOn } from "./text-variables";

export interface PropertyLaneResult {
  /** Objects written. */
  applied: number;
  /** Engine undo steps the apply took (0, 1, or 2 with a swatch mint). */
  undoSteps: number;
  /** `binding → why it wrote nothing` (keep, fail, no target, refused). */
  skipped: Record<string, string>;
  /** `binding → objects written`. */
  written: Record<string, number>;
  /** Host calls made (the count budget). */
  calls: number;
  /** What became of the `alongside` wire mutations: written in the same
   *  batch (`applied`), or not sent (`unsent`: no batch could carry them,
   *  nothing of theirs landed; the caller writes them itself). */
  alongside: "applied" | "unsent";
}

/** `host.objects`, when this host announces the object model (`objects@1`). */
export function objectsOf(host: BundleHost): ObjectsSurface | null {
  return host.supports("objects@1") ? host.objects : null;
}

export const NO_OBJECT_MODEL =
  "this host has no object model (host.objects, plugin-sdk 0.2.42) — property bindings cannot be written here";

/**
 * Commit one apply's property writes. `hostOids` maps a binding carried by
 * its element's label (`target: "host"`) to that element's oid.
 */
export async function commitProperties(
  host: BundleHost,
  applies: readonly PropertyApply[],
  hostOids: Readonly<Record<string, string>> = {},
  label = "Apply data",
  alongside: readonly Mutation[] = [],
): Promise<PropertyLaneResult> {
  const result: PropertyLaneResult = {
    applied: 0,
    undoSteps: 0,
    skipped: {},
    written: {},
    calls: 0,
    alongside: "unsent",
  };
  // Wire mutations of another lane (a data set's visibility writes) ride in
  // the SAME batch as object `set` ops, so the whole apply is one undo step
  // (finding DAT-2). A mutation with no object form keeps them all out.
  const asSets = alongside.map(asObjectSet);
  let side: ObjectOp[] = asSets.every((o) => o !== null)
    ? (asSets as ObjectOp[])
    : [];
  const objects = objectsOf(host);
  if (!objects) {
    for (const a of applies) result.skipped[a.binding] = NO_OBJECT_MODEL;
    return result;
  }
  const writes = applies.filter((a) => a.property.outcome.outcome === "write");
  // 1. Which objects each distinct selector names today.
  const targets = new Map<string, string[]>();
  for (const a of writes) {
    const sel = targetSelector(a.property.target, hostOids[a.binding]);
    if (!sel || targets.has(sel)) continue;
    result.calls++;
    try {
      targets.set(sel, await objects.query(sel));
    } catch (err) {
      result.skipped[a.binding] =
        `the target ${sel} could not be resolved: ${String(err)}`;
    }
  }
  // 2. The swatches, once, when a value is a colour.
  let swatches: SwatchRow[] = [];
  if (
    writes.some(
      (a) => a.property.outcome.outcome === "write" && a.property.outcome.color,
    )
  ) {
    result.calls++;
    try {
      swatches = [...(await host.document.collection<SwatchRow>("swatches"))];
    } catch {
      swatches = [];
    }
  }
  const plan = planProperties(applies, targets, swatches, hostOids);
  Object.assign(result.skipped, plan.skipped);
  // 3. New swatches: in the batch from protocol 71 (the `textVariable` kind
  // is the protocol's mark, see text-variables.ts), else a step before it.
  let creates: ObjectOp[] = [];
  if (plan.mint.length > 0 && (await textVariablesOn(host))) {
    creates = plan.mint.map(createSwatchOp);
  } else if (plan.mint.length > 0) {
    result.calls++;
    const minted = await host.document.mutate(
      plan.mint.length === 1
        ? plan.mint[0]!
        : ({ op: "batch", args: { ops: plan.mint } } as Mutation),
    );
    if (minted.applied) result.undoSteps++;
    else
      host.log.warn(
        `property bindings: the new swatches were refused (${String(minted.error)})`,
      );
  }
  // 4. ONE batch. A refused op names its index: that binding is reported and
  // the batch is sent again without it (nothing landed — it is all or nothing).
  let ops = plan.ops;
  let bindings = plan.bindings;
  while (ops.length > 0) {
    result.calls++;
    const out = await objects.batch([...creates, ...side, ...ops], { label });
    if (out.applied) {
      result.undoSteps += out.undoSteps;
      result.applied = ops.length;
      if (side.length > 0) result.alongside = "applied";
      for (const b of bindings)
        result.written[b] = (result.written[b] ?? 0) + 1;
      break;
    }
    const at =
      out.index !== undefined
        ? out.index - creates.length - side.length
        : undefined;
    // A refusal of the other lane's ops (or one that names no op) is not a
    // binding's: send the bindings alone and give the caller its mutations
    // back (`alongside: "unsent"`).
    if (side.length > 0 && (at === undefined || at < 0)) {
      side = [];
      continue;
    }
    const failed = at !== undefined && at >= 0 ? bindings[at] : undefined;
    if (failed === undefined) {
      for (const b of new Set(bindings))
        result.skipped[b] =
          `the host refused the apply: ${out.reason ?? out.code ?? "unknown"}`;
      break;
    }
    result.skipped[failed] =
      `the host refused ${ops[at!]!.op === "set" ? (ops[at!] as { path: string }).path : "the write"}: ${out.reason ?? out.code}`;
    const keep = bindings.map((b) => b !== failed);
    ops = ops.filter((_, i) => keep[i]);
    bindings = bindings.filter((_, i) => keep[i]);
  }
  return result;
}

/** A `createSwatch` mutation as a `host.objects` create op (protocol 71). */
function createSwatchOp(m: Mutation): ObjectOp {
  const spec = (
    m.args as {
      spec: {
        name: string;
        space: string;
        value: number[];
        model?: string | null;
      };
    }
  ).spec;
  return {
    op: "create",
    kind: "swatch",
    props: {
      name: spec.name,
      color: {
        space: spec.space,
        value: spec.value,
        model: spec.model ?? "Process",
      },
    },
  };
}

/** A wire property write as the object model's `set` op, or `null` when it
 *  has no such form (a text pour, a structural op, a value kind the object
 *  layer spells differently). */
function asObjectSet(m: Mutation): ObjectOp | null {
  const plain = (v: unknown): { ok: boolean; value?: unknown } => {
    const w = v as { type?: string; value?: unknown } | null;
    if (
      w &&
      typeof w === "object" &&
      ["bool", "number", "length", "text", "int"].includes(String(w.type))
    )
      return { ok: true, value: w.value };
    return { ok: false };
  };
  if (m.op === "setElementProperty") {
    const { elementId, path, value } = m.args as {
      elementId: { kind: string; id: unknown };
      path: string;
      value: unknown;
    };
    const v = plain(value);
    if (!v.ok || typeof elementId?.id !== "string") return null;
    return {
      op: "set",
      address: `${elementId.kind}:${elementId.id}`,
      path,
      value: v.value,
    } as ObjectOp;
  }
  if (m.op === "set") {
    const { address, path, value } = m.args as {
      address: string;
      path: string;
      value: unknown;
    };
    const v = plain(value);
    if (!v.ok) return null;
    return { op: "set", address, path, value: v.value } as ObjectOp;
  }
  return null;
}
