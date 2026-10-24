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

// The engine's record-set shapes on the TypeScript side: the `data-core`
// RecordSet serde JSON (`{t, v}` per cell) and the column door's typed
// buffers (`ColumnBatch`, sent by `ingestColumnBatch` with one copy per
// column). The query store delivers its rows to the engine itself (ADR 561);
// these shapes stay for a host that materialises rows of its own — a test, a
// headless job, a provider's records.
//
// Type contract: Date = days since 1970-01-01, DateTime = ms since the epoch
// (UTC), every number an f64, BLOB = bytes.

/** A tagged value matching `data-core::Value` serde (`tag="t", content="v"`). */
export type ValueJson =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "number"; v: number }
  | { t: "text"; v: string }
  | { t: "date"; v: number }
  | { t: "datetime"; v: number }
  | { t: "bytes"; v: number[] };

/** A field logical type matching `data-core::FieldType` serde (lowercase). */
export type FieldTypeJson =
  "bool" | "int" | "float" | "text" | "date" | "datetime" | "bytes" | "null";

export interface FieldJson {
  name: string;
  ty: FieldTypeJson;
  nullable: boolean;
  /** The declared scale of a DECIMAL(p, s) column: a bare reference to it
   *  displays with exactly `s` digits (`1234.50`). Absent for other types. */
  scale?: number;
}

/** The `data-core::RecordSet` serde shape (note `row_count` snake_case). */
export interface RecordSetJson {
  schema: { fields: FieldJson[] };
  columns: ValueJson[][];
  row_count: number;
}

export type DecodedColumn =
  | { kind: "f64"; values: Float64Array; valid: Uint8Array | null }
  | { kind: "bool"; values: Uint8Array; valid: Uint8Array | null }
  | { kind: "date"; values: Int32Array; valid: Uint8Array | null }
  | { kind: "datetime"; values: Float64Array; valid: Uint8Array | null }
  | {
      kind: "utf8";
      bytes: Uint8Array;
      offsets: Int32Array;
      valid: Uint8Array | null;
    }
  | {
      kind: "binary";
      bytes: Uint8Array;
      offsets: Int32Array;
      valid: Uint8Array | null;
    };

/** A whole result as typed column buffers — what `ingestColumnBatch` sends. */
export interface ColumnBatch {
  schema: { fields: FieldJson[] };
  row_count: number;
  columns: DecodedColumn[];
}

function isValid(valid: Uint8Array | null, i: number): boolean {
  return valid === null || ((valid[i >> 3] >> (i & 7)) & 1) === 1;
}

/** Bytes per value buffer kind, for the boundary-bytes trend. */
export function batchBytes(batch: ColumnBatch): number {
  let n = 0;
  for (const c of batch.columns) {
    n += c.valid?.byteLength ?? 0;
    n +=
      "bytes" in c
        ? c.bytes.byteLength + c.offsets.byteLength
        : c.values.byteLength;
  }
  return n;
}

/** Floor-divide a BigInt timestamp in `unit` (0 s, 1 ms, 2 µs, 3 ns) to ms. */
const decoder = new TextDecoder();

/** One decoded column as `{t, v}` cells. */
export function columnToValues(c: DecodedColumn, rows: number): ValueJson[] {
  const out: ValueJson[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    if (!isValid(c.valid, i)) {
      out[i] = { t: "null" };
      continue;
    }
    switch (c.kind) {
      case "f64":
        out[i] = { t: "number", v: c.values[i] };
        break;
      case "bool":
        out[i] = { t: "bool", v: c.values[i] === 1 };
        break;
      case "date":
        out[i] = { t: "date", v: c.values[i] };
        break;
      case "datetime":
        out[i] = { t: "datetime", v: c.values[i] };
        break;
      case "utf8":
        out[i] = {
          t: "text",
          v: decoder.decode(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])),
        };
        break;
      case "binary":
        out[i] = {
          t: "bytes",
          v: Array.from(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])),
        };
        break;
    }
  }
  return out;
}
