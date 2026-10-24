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

// Small test doubles a bundle's own suite needs beside the harness, so no
// suite hand-rolls them (community bundles included). Runner-agnostic:
// nothing here imports a test runner.
//
//   loadBundle(() => fake.editor, bundle, {
//     console: silentConsole,
//     storage: mapBacking(),
//   });
//
// `createFakeEditor` (the gesture kit) is the recording editor such a call
// takes; `createHeadlessHost` is the conformance host over the real engine.

import type {
  DataBindingInfo,
  DataRowEdit,
  DataService,
  DataTableInfo,
  MlCallOptions,
  MlCapability,
  MlImage,
  MlMask,
  MlRequests,
  MlTier,
  ProviderField,
  ProviderRecordSet,
} from "@paged-media/plugin-api";

import type {
  MlProvider,
  MlProviderAnswer,
  MlProviderHandle,
} from "./doors-ml.js";
import type { StorageBacking } from "./host-impl.js";

/** A `StorageBacking` over an in-memory map: what `host.storage` persists
 *  into in a test, private to the test (a browser-like realm's
 *  `localStorage` would leak between tests). `entries` seeds it. */
export function mapBacking(
  entries?: Iterable<readonly [string, string]>,
): StorageBacking {
  const map = new Map<string, string>(entries);
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    keys: () => Array.from(map.keys()),
  };
}

/** A console (and `PluginLogger`) that says nothing: the `console` of a
 *  host under test, or the `log` of a stub host. */
export const silentConsole: Readonly<
  Pick<Console, "debug" | "info" | "warn" | "error">
> = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

/** One table of a {@link fakeDataService}: its fields and its rows. */
export interface FakeDataTable {
  fields: readonly ProviderField[];
  rows: readonly Readonly<Record<string, unknown>>[];
  /** A query table is read-only (`write` refuses it). Default `"source"`. */
  kind?: "source" | "query";
}

/**
 * An in-memory `DataService` (`data@1`, extensions ADR 343) for a bundle's
 * tests: serve it with `harness.data.serve("test", fake)` (or a serving
 * bundle's `host.data.serve`), and a consumer under test reads, writes and
 * binds as it would against paged.data. `query` answers `SELECT * FROM
 * <table>` only, and says so for anything else: the fake runs no SQL.
 * Bindings are recorded, not resolved.
 */
export function fakeDataService(
  tables: Readonly<Record<string, FakeDataTable>>,
): DataService & {
  /** The rows as they are now, by table. */
  rows(table: string): readonly Record<string, unknown>[];
} {
  const state = new Map(
    Object.entries(tables).map(([name, t]) => [
      name,
      { ...t, rows: t.rows.map((r) => ({ ...r })), revision: 1 },
    ]),
  );
  const bindings = new Map<string, DataBindingInfo>();
  let nextBinding = 1;
  const table = (name: string) => {
    const t = state.get(name);
    if (!t) throw new Error(`no table ${name}`);
    return t;
  };
  const recordSet = (
    name: string,
    offset = 0,
    limit = Infinity,
  ): ProviderRecordSet => {
    const t = table(name);
    const rows = t.rows.slice(offset, offset + limit);
    return {
      schema: { fields: [...t.fields] },
      columns: t.fields.map((f) => rows.map((r) => r[f.name] ?? null)),
      rowCount: rows.length,
    };
  };
  const info = (name: string): DataTableInfo => {
    const t = table(name);
    return {
      name,
      kind: t.kind ?? "source",
      schema: { fields: [...t.fields] },
      rowCount: t.rows.length,
      revision: String(t.revision),
      writable: (t.kind ?? "source") === "source",
    };
  };
  return {
    tables: () => [...state.keys()].map(info),
    async records(name, range) {
      return recordSet(name, range?.offset, range?.limit);
    },
    async query(sql) {
      const m =
        /^\s*select\s+\*\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i.exec(sql);
      if (!m)
        throw new Error(
          "fakeDataService answers SELECT * FROM <table> only (it runs no SQL)",
        );
      return recordSet(m[1]!);
    },
    async write(name, edits: readonly DataRowEdit[]) {
      const t = table(name);
      if ((t.kind ?? "source") !== "source")
        throw new Error(`${name} is a query: it cannot be written`);
      const fields = new Set(t.fields.map((f) => f.name));
      for (const e of edits) {
        if (e.op === "set") {
          if (!t.rows[e.row]) throw new Error(`${name} has no row ${e.row}`);
          if (!fields.has(e.field))
            throw new Error(`${name} has no field ${e.field}`);
          t.rows[e.row]![e.field] = e.value;
        } else if (e.op === "insert") {
          t.rows.push({ ...e.values });
        } else {
          if (!t.rows[e.row]) throw new Error(`${name} has no row ${e.row}`);
          t.rows.splice(e.row, 1);
        }
      }
      t.revision++;
      return { revision: String(t.revision), rowCount: t.rows.length };
    },
    async bind(spec) {
      const b = { ...spec, id: `b${nextBinding++}` };
      bindings.set(b.id, b);
      return b;
    },
    async unbind(id) {
      bindings.delete(id);
    },
    async bindings() {
      return [...bindings.values()];
    },
    async evaluate(query, expr, record) {
      const t = table(query);
      const field = expr.trim();
      if (!t.fields.some((f) => f.name === field))
        return {
          display: "",
          value: null,
          error: "fakeDataService evaluates a bare field name only",
        };
      const value = t.rows[record]?.[field] ?? null;
      return { display: value === null ? "" : String(value), value };
    },
    rows: (name) => table(name).rows,
  };
}

// ------------------------------------------------------------------ ml

/** Options of a {@link fakeMlProvider}. */
export interface FakeMlProviderOptions {
  id?: string;
  title?: string;
  tier?: MlTier;
  capabilities?: readonly MlCapability[];
  healthy?: boolean;
  model?: string;
  /** Progress steps a call reports before it answers (default 2). */
  steps?: number;
}

/** A fake ML provider with deterministic answers, for a bundle's tests and
 *  the editor's e2e (extensions ADR 345). It computes, it does not imitate a
 *  model:
 *  - segment and matting: the pixels brighter than mid-grey;
 *  - inpaint: the masked pixels set to the mean of the unmasked ones;
 *  - superres: nearest-neighbour enlargement;
 *  - landmarks: one face, the image's centre third, with five points;
 *  - generate: a horizontal gradient of the asked size, its red channel
 *    the prompt's length mod 256;
 *  - edit: the masked pixels (all, without a mask) inverted.
 *  `setHealthy` flips its status; it calls the registered `changed`. */
export interface FakeMlProvider extends MlProvider {
  setHealthy(healthy: boolean): void;
  /** Bind to the registry handle so `setHealthy` announces itself. */
  attach(handle: MlProviderHandle): void;
  readonly calls: Array<{ capability: MlCapability; request: unknown }>;
}

export function fakeMlProvider(
  options: FakeMlProviderOptions = {},
): FakeMlProvider {
  let healthy = options.healthy ?? true;
  let handle: MlProviderHandle | null = null;
  const calls: FakeMlProvider["calls"] = [];
  const luminance = (img: MlImage): MlMask => {
    const data = new Uint8Array(img.width * img.height);
    for (let i = 0; i < data.length; i++) {
      const y =
        0.299 * img.data[i * 4]! +
        0.587 * img.data[i * 4 + 1]! +
        0.114 * img.data[i * 4 + 2]!;
      data[i] = y > 127 ? 255 : 0;
    }
    return { width: img.width, height: img.height, data };
  };
  return {
    id: options.id ?? "fake.ml",
    title: options.title ?? "Fake ML provider",
    tier: options.tier ?? "A",
    capabilities: options.capabilities ?? [
      "segment",
      "matting",
      "inpaint",
      "superres",
      "landmarks",
      "generate",
      "edit",
    ],
    calls,
    status: () =>
      healthy
        ? { healthy, model: options.model ?? "fake-model" }
        : { healthy, detail: "fake provider is down" },
    setHealthy(next) {
      healthy = next;
      handle?.changed();
    },
    attach(h) {
      handle = h;
    },
    async run<C extends MlCapability>(
      capability: C,
      request: MlRequests[C],
      opts: MlCallOptions,
    ): Promise<MlProviderAnswer<C>> {
      calls.push({ capability, request });
      const total = options.steps ?? 2;
      for (let step = 1; step <= total; step++) {
        opts.signal?.throwIfAborted();
        opts.onProgress?.({ step, total });
        await Promise.resolve();
      }
      opts.signal?.throwIfAborted();
      const answer = (value: unknown) =>
        value as unknown as MlProviderAnswer<C>;
      switch (capability as MlCapability) {
        case "segment":
          return answer({
            mask: luminance((request as MlRequests["segment"]).image),
            score: 1,
          });
        case "matting":
          return answer({
            alpha: luminance((request as MlRequests["matting"]).image),
          });
        case "inpaint": {
          const { image, mask } = request as MlRequests["inpaint"];
          const data = new Uint8ClampedArray(image.data);
          const sum = [0, 0, 0, 0];
          let n = 0;
          for (let i = 0; i < mask.data.length; i++)
            if (mask.data[i]! < 128) {
              for (let c = 0; c < 4; c++) sum[c]! += image.data[i * 4 + c]!;
              n++;
            }
          for (let i = 0; i < mask.data.length; i++)
            if (mask.data[i]! >= 128)
              for (let c = 0; c < 4; c++)
                data[i * 4 + c] = n ? Math.round(sum[c]! / n) : 0;
          return answer({
            image: { width: image.width, height: image.height, data },
          });
        }
        case "superres": {
          const { image, scale = 2 } = request as MlRequests["superres"];
          const w = image.width * scale;
          const h = image.height * scale;
          const data = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const s =
                (Math.floor(y / scale) * image.width + Math.floor(x / scale)) *
                4;
              data.set(image.data.subarray(s, s + 4), (y * w + x) * 4);
            }
          return answer({ image: { width: w, height: h, data } });
        }
        case "landmarks": {
          const { image } = request as MlRequests["landmarks"];
          const box = {
            x: image.width / 3,
            y: image.height / 3,
            width: image.width / 3,
            height: image.height / 3,
          };
          const at = (fx: number, fy: number) => ({
            x: box.x + box.width * fx,
            y: box.y + box.height * fy,
          });
          return answer({
            faces: [
              {
                box,
                points: [
                  at(0.3, 0.35),
                  at(0.7, 0.35),
                  at(0.5, 0.55),
                  at(0.35, 0.75),
                  at(0.65, 0.75),
                ],
              },
            ],
          });
        }
        case "generate": {
          const { width, height, prompt } = request as MlRequests["generate"];
          const data = new Uint8ClampedArray(width * height * 4);
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4;
              data[i] = prompt.length % 256;
              data[i + 1] = Math.round((x / Math.max(1, width - 1)) * 255);
              data[i + 2] = Math.round((y / Math.max(1, height - 1)) * 255);
              data[i + 3] = 255;
            }
          return answer({ image: { width, height, data } });
        }
        case "edit": {
          const { image, mask } = request as MlRequests["edit"];
          const data = new Uint8ClampedArray(image.data);
          for (let i = 0; i < image.width * image.height; i++)
            if (!mask || mask.data[i]! >= 128)
              for (let c = 0; c < 3; c++)
                data[i * 4 + c] = 255 - image.data[i * 4 + c]!;
          return answer({
            image: { width: image.width, height: image.height, data },
          });
        }
      }
      throw new Error(`fakeMlProvider: unknown capability ${capability}`);
    },
  };
}
