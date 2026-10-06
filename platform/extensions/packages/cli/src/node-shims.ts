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

// The three browser facilities plugin bundles reach for that Node lacks,
// installed by the CLI before a bundle needs them. Each one is NARROW: it
// serves exactly the bundle-local files a browser host would serve, and
// refuses everything else (no network, no arbitrary file reads).
//
//  1. `fetch(file:…)` — wasm-bindgen `--target web` glue (data-js, sheets,
//     …) fetches its `_bg.wasm` next to its own module URL. Node's fetch
//     has no `file:` scheme; this serves `.wasm` files only.
//  2. `Worker` — paged.data boots DuckDB-WASM as
//     `new AsyncDuckDB(logger, new Worker(bin/duckdb-browser-eh.worker.js))`.
//     Under the CLI that "worker" runs IN-PROCESS: DuckDB's own
//     `AsyncDuckDBDispatcher` (exported by the bundle's shipped
//     `duckdb-browser.mjs`) over DuckDB's Node BLOCKING bindings
//     (`@duckdb/duckdb-wasm`, an optional peer of the CLI) driving the
//     bundle's SHIPPED engine wasm — the same pairing plugin-data's Node
//     lanes use (test/duckdb-node-boot.ts). Any other worker URL throws.
//  3. `XMLHttpRequest` — DuckDB's Node runtime loads its json/parquet
//     extensions synchronously from the repository the bundle points at
//     (`bin/duckdb-ext`, a `file:` URL); served from that directory only.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let installed = false;

/** Where `@duckdb/duckdb-wasm` resolves from: the cwd first (a user's own
 *  install), then this package. Null when it is not installed. */
export function resolveDuckDBNode(cwd = process.cwd()): string | null {
  for (const anchor of [join(cwd, "package.json"), fileURLToPath(import.meta.url)]) {
    try {
      return createRequire(anchor).resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
    } catch {
      /* next anchor */
    }
  }
  return null;
}

export const DUCKDB_MISSING =
  "DuckDB's Node build is not installed — `npm i @duckdb/duckdb-wasm@1.29.0` beside @paged-media/cli (paged.data's queries run on it)";

type Listener = (event: { data: unknown }) => void;

/** The in-process DuckDB "worker". */
class InProcessDuckDBWorker {
  private listeners = new Map<string, Set<Listener>>();
  private queue: unknown[] = [];
  private dispatcher: { onMessage(req: unknown): Promise<void> } | null = null;
  private terminated = false;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;

  constructor(workerUrl: string) {
    const binDir = dirname(fileURLToPath(workerUrl));
    void this.boot(binDir).catch((err) => this.emit("error", { data: err }));
  }

  private async boot(binDir: string): Promise<void> {
    const api = (await import(pathToFileURL(join(binDir, "duckdb-browser.mjs")).href)) as {
      AsyncDuckDBDispatcher: new () => { onMessage(req: unknown): Promise<void> };
    };
    const lib = resolveDuckDBNode();
    const self = this;
    class NodeDispatcher extends (api.AsyncDuckDBDispatcher as unknown as new () => object) {
      protected async instantiate(mainModule: string): Promise<unknown> {
        if (!lib) throw new Error(DUCKDB_MISSING);
        const duckdb = createRequire(import.meta.url)(lib) as {
          createDuckDB(bundles: unknown, logger: unknown, runtime: unknown): Promise<{ instantiate(): Promise<unknown> }>;
          VoidLogger: new () => unknown;
          NODE_RUNTIME: unknown;
        };
        installExtensionXhr(join(binDir, "duckdb-ext"));
        const wasm = mainModule.startsWith("file:") ? fileURLToPath(mainModule) : resolve(mainModule);
        const db = await duckdb.createDuckDB(
          {
            mvp: { mainModule: join(binDir, "duckdb-mvp.NOT-SHIPPED.wasm"), mainWorker: "" },
            eh: { mainModule: wasm, mainWorker: "" },
          },
          new duckdb.VoidLogger(),
          duckdb.NODE_RUNTIME,
        );
        await db.instantiate();
        return db;
      }
      protected postMessage(response: unknown): void {
        queueMicrotask(() => self.emit("message", { data: response }));
      }
    }
    this.dispatcher = new NodeDispatcher() as unknown as { onMessage(req: unknown): Promise<void> };
    for (const req of this.queue.splice(0)) void this.dispatcher.onMessage(req);
  }

  private emit(type: string, event: { data: unknown }): void {
    if (this.terminated) return;
    if (type === "message") this.onmessage?.(event);
    if (type === "error") this.onerror?.(event);
    for (const l of this.listeners.get(type) ?? []) l(event);
  }

  postMessage(request: unknown): void {
    if (this.terminated) return;
    if (this.dispatcher) void this.dispatcher.onMessage(request);
    else this.queue.push(request);
  }
  addEventListener(type: string, l: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(l);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, l: Listener): void {
    this.listeners.get(type)?.delete(l);
  }
  terminate(): void {
    this.terminated = true;
    this.listeners.clear();
  }
}

function installExtensionXhr(extDir: string): void {
  const g = globalThis as unknown as { XMLHttpRequest?: unknown };
  if (g.XMLHttpRequest) return;
  const root = pathToFileURL(extDir).href;
  g.XMLHttpRequest = class LocalOnlyXhr {
    status = 0;
    response: ArrayBuffer | null = null;
    responseType = "";
    private url = "";
    open(_method: string, url: string, async?: boolean): void {
      if (async !== false) throw new Error(`paged CLI: only synchronous extension loads are served (asked for ${url})`);
      this.url = url;
    }
    setRequestHeader(): void {}
    send(): void {
      if (this.url.startsWith(`${root}/`)) {
        const file = fileURLToPath(this.url);
        if (existsSync(file)) {
          const b = readFileSync(file);
          this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
          this.status = 200;
          return;
        }
      }
      this.status = 404;
    }
  };
}

/** Install the shims (idempotent). */
export function installNodeShims(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as {
    fetch: typeof fetch;
    Worker?: unknown;
  };
  const realFetch = g.fetch.bind(globalThis);
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof URL ? input.href : typeof input === "string" ? input : (input as Request).url;
    if (href.startsWith("file:")) {
      const file = fileURLToPath(href);
      if (!file.endsWith(".wasm")) throw new TypeError(`paged CLI: fetch(${href}) — only bundle .wasm files are served from disk`);
      return new Response(readFileSync(file), { headers: { "content-type": "application/wasm" } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  if (g.Worker === undefined) {
    g.Worker = class NodeWorkerShim {
      constructor(url: string | URL) {
        const href = String(url);
        if (/duckdb-browser-eh\.worker\.js$/.test(href)) {
          return new InProcessDuckDBWorker(href) as unknown as NodeWorkerShim;
        }
        throw new Error(`paged CLI: Web Workers are not available headlessly (${href})`);
      }
    };
  }
}
