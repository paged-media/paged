// Editor ADR 291's record markers, the bundle's half [data.bind.record-status]:
// the page items that show one record are read from their labels (a merged
// record's frames, a record-flow frame's records), handed to the engine, and
// the placements come back with the record each shows now.

import { describe, expect, it } from "bun:test";

import type { DataEngineLike } from "../engine";
import type { LabelledElement, PayloadJson } from "../labels";
import {
  engineRecordStatus,
  recordInstances,
  toDataRecordStatus,
  withRecords,
  type EngineRecordStatus,
} from "../record-status";

const PAYLOAD: PayloadJson = {
  bindings: [
    { id: "v", kind: "variable", query: "q" },
    { id: "rf", kind: "recordFlow", query: "q" },
    { id: "t", kind: "table", query: "q" },
  ],
};

const el = (id: string, data: Record<string, unknown> | null) =>
  ({ element: { kind: "textFrame", id }, data }) as LabelledElement;

describe("record markers [data.bind.record-status]", () => {
  it("reads merged records and record-flow frames from their labels", () => {
    const got = recordInstances(PAYLOAD, [
      el("m1", { kind: "merge", merge: "merge-q", query: "q", record: 3 }),
      // A merge label written before it named its query: `merge-<query>`.
      el("m2", { kind: "merge", merge: "merge-q", record: 4 }),
      el("m3", { kind: "merge", merge: "custom", record: 5 }),
      el("f0", {
        kind: "recordFlow",
        binding: "rf",
        frame: 0,
        records: [0, 2],
      }),
      el("f1", { kind: "recordFlow", binding: "nope", records: [1] }),
      el("x", null),
    ]);
    expect(got).toEqual([
      { binding: "merge-q", address: "textFrame:m1", query: "q", record: 3 },
      { binding: "merge-q", address: "textFrame:m2", query: "q", record: 4 },
      { binding: "rf", address: "textFrame:f0", query: "q", record: 0 },
      { binding: "rf", address: "textFrame:f0", query: "q", record: 2 },
    ]);
  });

  it("gives each placement the record it shows now", () => {
    const asked: [string, readonly number[]][] = [];
    const status: EngineRecordStatus = {
      query: "q",
      key: ["sku"],
      baseline: false,
      added: [],
      changed: [],
      removed: 1,
      placed: [0, 1],
      first: 1,
      // merged record 3 is row 0 now; flow row 0 is gone; flow row 2 is 1.
      instances: [0, null, 1],
    };
    const out = withRecords(
      [
        { binding: "v", address: "textFrame:a" },
        { binding: "t", address: "textFrame:b" },
      ],
      PAYLOAD,
      [
        { binding: "merge-q", address: "rectangle:m", query: "q", record: 3 },
        { binding: "rf", address: "textFrame:f", query: "q", record: 0 },
        { binding: "rf", address: "textFrame:f", query: "q", record: 2 },
      ],
      (q, i) => (asked.push([q, i]), status),
    );
    expect(asked).toEqual([["q", [3, 0, 2]]]);
    expect(out).toEqual([
      { binding: "v", address: "textFrame:a", record: 1 },
      { binding: "t", address: "textFrame:b" },
      { binding: "merge-q", address: "rectangle:m", record: 0 },
      { binding: "rf", address: "textFrame:f", record: 1 },
    ]);
  });

  it("asks the engine with the key, and says nothing without the lane", () => {
    const calls: unknown[] = [];
    const engine = {
      record_status: (q: string, opts: unknown) => (
        calls.push([q, opts]),
        { query: q, added: [1], changed: [], removed: 0, placed: [1] }
      ),
    } as unknown as DataEngineLike;
    const st = engineRecordStatus(engine, "q", [4], ["sku"]);
    expect(calls).toEqual([["q", { instances: [4], key: ["sku"] }]]);
    expect(toDataRecordStatus("q", st)).toEqual({
      query: "q",
      added: [1],
      changed: [],
      removed: 0,
      placed: [1],
    });
    expect(engineRecordStatus({} as DataEngineLike, "q", [], null)).toBeNull();
    expect(toDataRecordStatus("q", null)).toEqual({
      query: "q",
      added: [],
      changed: [],
      removed: 0,
      placed: [],
    });
  });
});
