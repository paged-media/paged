// Per-record status and record markers (editor ADR 291): which records of a
// query are new, changed or placed, and which page item shows which record.
//
// The engine decides (`record_status`, paged-data-session's
// `record_status.rs`): it keeps the result each query had when the document
// was last written from it, matches records by key and carries a placed
// record to its row now. What only the document knows rides along: the page
// items that show one record each — a merged record's frames and a record
// flow's frames — named in their labels (`merge.ts`, `flow-writer.ts`). This
// file reads those labels and turns the engine's answer into the contract's.

import type { DataRecordStatus } from "@paged-media/plugin-api";

import type { DataEngineLike } from "./engine";
import type { LabelledElement, PayloadJson } from "./labels";

/** The engine's `RecordStatus` (rows of the current result). */
export interface EngineRecordStatus {
  query: string;
  key: string[];
  baseline: boolean;
  added: number[];
  changed: number[];
  removed: number;
  placed: number[];
  /** The record single-record bindings over the query show. */
  first?: number | null;
  /** Per instance passed in: its row now, or null/undefined when gone. */
  instances: (number | null | undefined)[];
}

/** A page item that shows one record, as its label says. `record` is the
 *  row of the result the document was written from. */
export interface RecordInstance {
  /** The binding (a record flow's id) or the merge (its merge id). */
  binding: string;
  address: string;
  query: string;
  record: number;
  /** A Data Merge's frame (not a binding's). */
  merge?: boolean;
}

/** The kinds that show one record wherever they are placed. */
const SINGLE = new Set([
  "variable",
  "image",
  "barcode",
  "visibility",
  "property",
]);

/** The page items that show one record each: merged records' frames and
 *  record-flow frames (one instance per record the frame holds). */
export function recordInstances(
  payload: PayloadJson,
  elements: readonly LabelledElement[],
): RecordInstance[] {
  const flows = new Map(
    (payload.bindings ?? [])
      .filter((b) => b.kind === "recordFlow" && typeof b.query === "string")
      .map((b) => [b.id, b.query as string]),
  );
  const out: RecordInstance[] = [];
  for (const { element, data } of elements) {
    if (!data || typeof element.id !== "string") continue;
    const address = `${element.kind}:${element.id}`;
    if (data.kind === "merge" && typeof data.record === "number") {
      const merge = typeof data.merge === "string" ? data.merge : "";
      // A merge's label names its query; one written before it did is
      // `merge-<query>` by default.
      const query =
        typeof data.query === "string"
          ? data.query
          : merge.startsWith("merge-")
            ? merge.slice("merge-".length)
            : "";
      if (query)
        out.push({
          binding: merge,
          address,
          query,
          record: data.record,
          merge: true,
        });
    } else if (data.kind === "recordFlow" && Array.isArray(data.records)) {
      const binding = typeof data.binding === "string" ? data.binding : "";
      const query = flows.get(binding);
      if (!query) continue;
      for (const r of data.records)
        if (typeof r === "number")
          out.push({ binding, address, query, record: r });
    }
  }
  return out;
}

/** The engine's status of one query, given the instances over it; null on
 *  an engine without the lane or a query without a result. */
export function engineRecordStatus(
  engine: DataEngineLike,
  query: string,
  instances: readonly number[],
  key: readonly string[] | null,
): EngineRecordStatus | null {
  if (typeof engine.record_status !== "function") return null;
  try {
    return (
      (engine.record_status(query, {
        instances: [...instances],
        ...(key && key.length > 0 ? { key: [...key] } : {}),
      }) as EngineRecordStatus | null) ?? null
    );
  } catch {
    return null;
  }
}

/** The contract's shape of the engine's answer (nothing for no answer). */
export function toDataRecordStatus(
  query: string,
  st: EngineRecordStatus | null,
): DataRecordStatus {
  return {
    query,
    added: st?.added ?? [],
    changed: st?.changed ?? [],
    removed: st?.removed ?? 0,
    placed: st?.placed ?? [],
  };
}

/** A placement, with the record it shows when it shows one. */
export interface PlacedRecord {
  binding: string;
  address: string;
  record?: number;
  /** A merged record's frames have no binding and no sync state: they are
   *  what the merge wrote. */
  status?: "linked";
}

/** Placements with the record each shows: a single-record binding's at the
 *  record it resolves at, plus one placement per record instance (carried
 *  to its row now; an instance whose record is gone is left out). */
export function withRecords(
  placements: readonly { binding: string; address: string }[],
  payload: PayloadJson,
  instances: readonly RecordInstance[],
  status: (
    query: string,
    instances: readonly number[],
  ) => EngineRecordStatus | null,
): PlacedRecord[] {
  const bindingOf = new Map(
    (payload.bindings ?? []).map((b) => [b.id, b] as const),
  );
  const queries = new Set<string>(instances.map((i) => i.query));
  for (const p of placements) {
    const b = bindingOf.get(p.binding);
    if (b && SINGLE.has(b.kind) && typeof b.query === "string")
      queries.add(b.query);
  }
  const statuses = new Map<
    string,
    { st: EngineRecordStatus | null; of: RecordInstance[] }
  >();
  for (const q of queries) {
    const of = instances.filter((i) => i.query === q);
    statuses.set(q, {
      st: status(
        q,
        of.map((i) => i.record),
      ),
      of,
    });
  }
  const out: PlacedRecord[] = [];
  for (const p of placements) {
    const b = bindingOf.get(p.binding);
    const first =
      b && SINGLE.has(b.kind) && typeof b.query === "string"
        ? statuses.get(b.query)?.st?.first
        : undefined;
    out.push(typeof first === "number" ? { ...p, record: first } : p);
  }
  for (const { st, of } of statuses.values()) {
    if (!st) continue;
    of.forEach((inst, k) => {
      const record = st.instances[k];
      if (typeof record === "number")
        out.push({
          binding: inst.binding,
          address: inst.address,
          record,
          ...(inst.merge ? { status: "linked" as const } : {}),
        });
    });
  }
  return out;
}
