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

// The surface-conformance environments for paged.data: the REAL bundle
// (`dataBundle.activate`, every contribution it registers) over the real
// data-js engine and a real DuckDB, on two hosts:
//
//   · `unitEnv()` — the SDK's in-process `BundleHost` adapter over the
//     gesture kit's RECORDING fake editor (no canvas engine: mutations are
//     recorded and answered with happy defaults);
//   · `headlessEnv()` — the plugin-sdk harness over the REAL canvas engine,
//     the minimal one-page document (page "usp", rectangle "urect") loaded.
//
// The bundle boots its two engines the browser's way (the glue fetches the
// wasm by URL; DuckDB-WASM spawns a worker). Node can do neither, so the
// two boot functions are swapped for the Node boots of ./real-duckdb.ts —
// the same artifacts, booted from disk. `loadDataModule()` does that and
// imports the bundle after it.
//
// `shell.openPanel` (which panel a command opened) is recorded around the
// host, and so is every write the bundle makes: `document.mutate` and
// `objects.batch`.

import { mock } from "bun:test";

import {
  createBundleHost,
  createDataProviderRegistry,
  createHeadlessHost,
  type DataProviderBackend,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";
import {
  createFakeEditor,
  type FakeEditor,
} from "@paged-media/plugin-sdk/gesture-kit";
import type {
  BundleHost,
  CommandContribution,
  ImporterContribution,
  PanelContribution,
  PickedFile,
  PluginManifest,
  SchemaPanelRenderer,
} from "@paged-media/plugin-api";
import { importActual } from "@paged-media/test-kit";

import { existsSync } from "node:fs";
import { join } from "node:path";

import { minimalIdml } from "../fixtures/minimal-idml";
import { ENGINE_ANCHOR } from "../real-core";
import {
  BIN,
  DATA_JS_WASM,
  bootRealDuckDB,
  bootRealEngine,
} from "../real-duckdb";

const DUCKDB_NODE = join(
  BIN,
  "..",
  "..",
  "..",
  "vendor",
  "duckdb-wasm",
  "dist",
  "duckdb-node-blocking.cjs",
);

/** What the suites need, and what is missing: the data-js wasm
 *  (scripts/build-wasm.sh), DuckDB-WASM (scripts/vendor-duckdb.sh) and, for
 *  the headless layer, the canvas engine. `required` is the CI lane's
 *  promise that they are there (REQUIRE_REAL_*): then a missing one fails. */
export function readiness(headless: boolean): {
  ready: boolean;
  missing: string;
  required: boolean;
} {
  const missing = [
    existsSync(DATA_JS_WASM)
      ? null
      : "the data-js wasm (bash scripts/build-wasm.sh)",
    existsSync(join(BIN, "duckdb-engine.wasm")) && existsSync(DUCKDB_NODE)
      ? null
      : "DuckDB-WASM (bash scripts/vendor-duckdb.sh)",
    !headless || ENGINE_ANCHOR ? null : "the canvas engine (canvas-wasm)",
  ].filter((m): m is string => m !== null);
  return {
    ready: missing.length === 0,
    missing: missing.join(", "),
    required:
      process.env.REQUIRE_REAL_DUCKDB === "1" ||
      process.env.REQUIRE_REAL_ENGINE === "1" ||
      process.env.REQUIRE_REAL_CORE === "1",
  };
}

export type DataModule = typeof import("../../src/index");
export type DataSession = NonNullable<ReturnType<DataModule["sessionFor"]>>;

let loaded: Promise<DataModule> | null = null;

/** The bundle, with its engine boots swapped for the Node boots. */
export function loadDataModule(): Promise<DataModule> {
  if (!loaded) {
    loaded = (async () => {
      const engine = await importActual(() => import("../../src/engine"));
      const duckdb = await importActual(() => import("../../src/query/duckdb"));
      mock.module("../../src/engine", () => ({
        ...engine,
        bootEngine: (today: number) => bootRealEngine(today),
      }));
      mock.module("../../src/query/duckdb", () => ({
        ...duckdb,
        bootDuckDB: async () => {
          const b = await bootRealDuckDB();
          if (!b.handle) throw new Error(b.error);
          return b.handle;
        },
      }));
      return import("../../src/index");
    })();
  }
  return loaded;
}

export interface Write {
  door: "mutate" | "objects.batch";
  op: string;
  applied: boolean;
}

export interface DataEnv {
  kind: "unit" | "headless";
  host: BundleHost;
  /** The bundle's own session (what its panels hold). */
  session: DataSession;
  objects: BundleHost["objects"];
  providers: DataProviderBackend;
  command(id: string): CommandContribution;
  importer(id: string): ImporterContribution;
  panel(id: string): PanelContribution;
  opened: string[];
  /** The next `shell.pickFile` answer. */
  pick(files: PickedFile[]): void;
  logs: string[];
  /** Every write the bundle made, in order. */
  writes: Write[];
  mark(): number;
  writesSince(mark: number): Write[];
  undo(): Promise<void>;
  settle(): Promise<void>;
  dispose(): void;
}

const consoleInto = (logs: string[]) => {
  const line =
    (level: string) =>
    (...args: unknown[]) =>
      logs.push(
        `${level} ${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}`,
      );
  return {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
};

const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

const settleOnce = () => new Promise((r) => setTimeout(r, 0));

/** The host as the editor hands it, with the panel door and the writes
 *  recorded. */
function recorded(
  host: BundleHost,
  opened: string[],
  writes: Write[],
  picks: PickedFile[][],
) {
  const shell = new Proxy(host.shell, {
    get(o, p, r) {
      if (p === "openPanel") return (id: string) => void opened.push(id);
      if (p === "pickFile") return async () => picks.shift() ?? [];
      return Reflect.get(o, p, r);
    },
  });
  const document = new Proxy(host.document, {
    get(o, p, r) {
      if (p === "mutate") {
        return async (m: Parameters<BundleHost["document"]["mutate"]>[0]) => {
          const outcome = await o.mutate(m);
          writes.push({
            door: "mutate",
            op: (m as { op: string }).op,
            applied: !!(outcome as { applied?: boolean }).applied,
          });
          return outcome;
        };
      }
      return Reflect.get(o, p, r);
    },
  });
  const objects = new Proxy(host.objects, {
    get(o, p, r) {
      if (p === "batch") {
        return async (ops: Parameters<BundleHost["objects"]["batch"]>[0]) => {
          const out = await o.batch(ops);
          for (const op of ops)
            writes.push({
              door: "objects.batch",
              op: (op as { op: string }).op,
              applied: !!out.applied,
            });
          return out;
        };
      }
      return Reflect.get(o, p, r);
    },
  });
  return new Proxy(host, {
    get(o, p, r) {
      if (p === "shell") return shell;
      if (p === "document") return document;
      if (p === "objects") return objects;
      if (p === "supports")
        return (f: string) =>
          f === "shell.openPanel@1" ||
          f === "shell.pickFile@1" ||
          o.supports(f);
      return Reflect.get(o, p, r);
    },
  });
}

/** The unit environment: the SDK adapter over the recording fake editor. */
export async function unitEnv(
  options: { schemaPanelRenderer?: SchemaPanelRenderer } = {},
): Promise<DataEnv & { fake: FakeEditor }> {
  const mod = await loadDataModule();
  const logs: string[] = [];
  const opened: string[] = [];
  const writes: Write[] = [];
  const fake = createFakeEditor();
  const providers = createDataProviderRegistry();
  const parts = new Map<string, Uint8Array>();
  Object.assign(fake.editor, {
    parts: {
      write: async (path: string, bytes: Uint8Array) =>
        void parts.set(path, bytes.slice()),
      read: async (path: string) => parts.get(path)?.slice() ?? null,
      delete: async (path: string) => parts.delete(path),
    },
  });
  const handle = createBundleHost(
    () => fake.editor,
    mod.dataBundle.manifest as PluginManifest,
    {
      console: consoleInto(logs),
      storage: mapBacking(),
      dataProviders: providers,
      ...(options.schemaPanelRenderer
        ? { schemaPanelRenderer: options.schemaPanelRenderer }
        : {}),
    },
  );
  const picks: PickedFile[][] = [];
  const host = recorded(handle.host, opened, writes, picks);
  const bundle = mod.dataBundle.activate(host);
  const session = mod.sessionFor(host)!;
  await session.whenRestored();
  const reg = <T extends { id?: string }>(
    name: Parameters<FakeEditor["registered"]>[0],
    id: string,
  ): T => {
    const found = fake.registered<T>(name).find((c) => c.id === id);
    if (!found) throw new Error(`${name}: "${id}" is not registered`);
    return found;
  };
  return {
    kind: "unit",
    fake,
    host,
    session,
    objects: host.objects,
    providers,
    command: (id) => reg<CommandContribution>("commands", id),
    importer: (id) => reg<ImporterContribution>("importers", id),
    panel: (id) => reg<PanelContribution>("panels", id),
    opened,
    pick: (files) => void picks.push(files),
    logs,
    writes,
    mark: () => writes.length,
    writesSince: (m) => writes.slice(m),
    undo: async () => {
      await host.document.undo();
    },
    settle: async () => {
      for (let i = 0; i < 4; i++) await settleOnce();
      await fake.settle();
    },
    dispose() {
      bundle.dispose();
      handle.dispose();
    },
  };
}

/** The headless environment: the harness over the real canvas engine with
 *  the minimal document loaded. */
export async function headlessEnv(): Promise<DataEnv & { h: HeadlessHost }> {
  const mod = await loadDataModule();
  const logs: string[] = [];
  const opened: string[] = [];
  const writes: Write[] = [];
  const picks: PickedFile[][] = [];
  const h = await createHeadlessHost({
    console: consoleInto(logs),
    storage: mapBacking(),
    resolveFrom: ENGINE_ANCHOR ?? undefined,
  });
  await h.load(minimalIdml());
  let captured: BundleHost | null = null;
  const bundle = h.loadBundle({
    ...mod.dataBundle,
    activate: (bh: BundleHost) => {
      captured = recorded(bh, opened, writes, picks);
      return mod.dataBundle.activate(captured);
    },
  } as typeof mod.dataBundle);
  if (!captured) throw new Error("the data bundle did not activate");
  const host: BundleHost = captured;
  const session = mod.sessionFor(host)!;
  await session.whenRestored();
  const of = <T>(kind: string, id: string): T => {
    const found = h.contributions.find((c) => c.kind === kind && c.id === id);
    if (!found) throw new Error(`${kind}: "${id}" is not registered`);
    return found.value as T;
  };
  return {
    kind: "headless",
    h,
    host,
    session,
    objects: host.objects,
    providers: h.dataProviders,
    command: (id) => of<CommandContribution>("command", id),
    importer: (id) => of<ImporterContribution>("importer", id),
    panel: (id) => of<PanelContribution>("panel", id),
    opened,
    pick: (files) => void picks.push(files),
    logs,
    writes,
    mark: () => writes.length,
    writesSince: (m) => writes.slice(m),
    undo: async () => {
      await host.document.undo();
      for (let i = 0; i < 4; i++) await settleOnce();
    },
    settle: async () => {
      for (let i = 0; i < 6; i++) await settleOnce();
    },
    dispose() {
      bundle.dispose();
      h.dispose();
    },
  };
}
