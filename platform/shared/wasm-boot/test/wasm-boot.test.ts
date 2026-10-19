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

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  instantiateWasmBindgen,
  isNodeRealm,
  singleFlight,
  wasmBindgenModule,
  wasmBytes,
  type WasmBindgenSpec,
} from "../src/index.ts";

/** A glue with wasm-bindgen's `--target web` init semantics: ONE
 *  module-level instance, and `default()` checks it BEFORE its await (the
 *  fetch and compile), so two calls in flight both instantiate and the
 *  second replaces the first. `initSync` checks and instantiates without
 *  awaiting. Each instance is numbered, so a test can see which one an
 *  engine object was built on. */
function fakeGlue() {
  let wasm: { id: number } | undefined;
  let instantiations = 0;
  const inits: unknown[] = [];
  /** The instance each instantiation produced, in order. */
  const produced: number[] = [];
  const instantiate = () => {
    instantiations += 1;
    wasm = { id: instantiations };
    produced.push(wasm.id);
    return wasm;
  };
  return {
    async default(init?: { module_or_path: unknown }) {
      if (wasm !== undefined) return wasm;
      inits.push(init?.module_or_path);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return instantiate();
    },
    initSync(init: { module: BufferSource | WebAssembly.Module }) {
      if (wasm !== undefined) return wasm;
      inits.push(init.module);
      return instantiate();
    },
    /** What an engine object created now would point at. */
    current: () => wasm?.id,
    instantiations: () => instantiations,
    inits,
    produced,
  };
}

type FakeGlue = ReturnType<typeof fakeGlue>;

function browserSpec(
  glue: FakeGlue,
  extra: Partial<WasmBindgenSpec<FakeGlue>> = {},
): WasmBindgenSpec<FakeGlue> {
  return {
    glue: async () => glue,
    wasmUrl: async () => ({ default: "/assets/x_bg.wasm" }),
    wasmFile: () => {
      throw new Error("a browser boot never reads a file");
    },
    notBuilt: "x engine wasm not built",
    isNode: () => false,
    ...extra,
  };
}

describe("the double-boot race", () => {
  it("exists without the guard: two boots in flight instantiate twice", async () => {
    const glue = fakeGlue();
    const spec = browserSpec(glue);
    // Two boot paths at once (activation and `documentLoaded`).
    await Promise.all([
      instantiateWasmBindgen(spec),
      instantiateWasmBindgen(spec),
    ]);
    expect(glue.instantiations()).toBe(2);
    // An engine built when the first boot finished sits on instance 1; the
    // glue's memory is instance 2's now.
    expect(glue.produced).toEqual([1, 2]);
    expect(glue.current()).toBe(2);
  });

  it("is gone with wasmBindgenModule: every concurrent boot shares one instance", async () => {
    const glue = fakeGlue();
    const boot = wasmBindgenModule(browserSpec(glue));
    const booted = await Promise.all(
      Array.from({ length: 8 }, () => boot().then((g) => g.current())),
    );
    expect(glue.instantiations()).toBe(1);
    expect(glue.produced).toEqual([1]);
    expect(booted).toEqual(Array(8).fill(1));
    // A later boot reuses it too.
    expect((await boot()).current()).toBe(1);
    expect(glue.instantiations()).toBe(1);
    expect(glue.inits).toEqual(["/assets/x_bg.wasm"]);
  });

  it("runs `ready` once, inside the flight", async () => {
    const glue = fakeGlue();
    let readies = 0;
    const boot = wasmBindgenModule(
      browserSpec(glue, {
        ready: async (g) => {
          expect(g.current()).toBe(1);
          readies += 1;
        },
      }),
    );
    await Promise.all([boot(), boot(), boot()]);
    expect(readies).toBe(1);
  });
});

describe("wasmBindgenModule", () => {
  it("rejects with notBuilt (the import error as cause) and retries later", async () => {
    const glue = fakeGlue();
    let built = false;
    const boot = wasmBindgenModule(
      browserSpec(glue, {
        glue: async () => {
          if (!built) throw new Error("Cannot find module ../bin/x.js");
          return glue;
        },
      }),
    );
    const err = (await boot().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("x engine wasm not built");
    expect((err.cause as Error).message).toContain("Cannot find module");
    built = true;
    expect((await boot()).current()).toBe(1);
  });

  it("NODE: reads the wasm file and initSyncs with its bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wasm-boot-"));
    const file = join(dir, "x_bg.wasm");
    writeFileSync(file, new Uint8Array([0, 0x61, 0x73, 0x6d]));
    for (const wasmFile of [
      () => file,
      () => new URL(pathToFileURL(file).href),
      () => pathToFileURL(file).href,
    ]) {
      const glue = fakeGlue();
      const boot = wasmBindgenModule<FakeGlue>({
        glue: async () => glue,
        wasmUrl: async () => {
          throw new Error("a Node boot never imports the asset URL");
        },
        wasmFile,
        notBuilt: "x engine wasm not built",
        isNode: () => true,
      });
      await Promise.all([boot(), boot()]);
      expect(glue.instantiations()).toBe(1);
      const bytes = glue.inits[0] as Uint8Array;
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect([...bytes]).toEqual([0, 0x61, 0x73, 0x6d]);
    }
  });

  it("NODE: falls back to default() with the bytes for a glue typed without initSync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wasm-boot-"));
    const file = join(dir, "y_bg.wasm");
    writeFileSync(file, new Uint8Array([1, 2, 3]));
    const seen: unknown[] = [];
    const glue = {
      async default(init?: { module_or_path: unknown }) {
        seen.push(init?.module_or_path);
      },
    };
    await instantiateWasmBindgen({
      glue: async () => glue,
      wasmUrl: async () => ({ default: "unused" }),
      wasmFile: () => file,
      notBuilt: "y",
      isNode: () => true,
    });
    expect([...(seen[0] as Uint8Array)]).toEqual([1, 2, 3]);
  });
});

describe("singleFlight", () => {
  it("shares one promise and passes the first caller's arguments", async () => {
    const calls: number[] = [];
    const load = singleFlight(async (n: number) => {
      calls.push(n);
      return n * 2;
    });
    expect(await Promise.all([load(1), load(2), load(3)])).toEqual([2, 2, 2]);
    expect(calls).toEqual([1]);
  });

  it("turns a synchronous throw into a rejection it forgets", async () => {
    let fail = true;
    const load = singleFlight((): Promise<string> => {
      if (fail) throw new Error("boom");
      return Promise.resolve("ok");
    });
    await expect(load()).rejects.toThrow("boom");
    fail = false;
    expect(await load()).toBe("ok");
  });

  it("reset() forgets a result, and a stale failure never clobbers the newer flight", async () => {
    let n = 0;
    let rejectFirst: (e: Error) => void = () => {};
    const load = singleFlight(() => {
      n += 1;
      if (n === 1) {
        return new Promise<number>((_, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve(n);
    });
    const first = load();
    await Promise.resolve();
    load.reset();
    const second = load();
    rejectFirst(new Error("old"));
    await expect(first).rejects.toThrow("old");
    expect(await second).toBe(2);
    // The second flight is still the remembered one.
    expect(await load()).toBe(2);
    expect(n).toBe(2);
  });
});

describe("wasmBytes", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("BROWSER: fetches the bundler's asset URL", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return new Response(new Uint8Array([9, 8, 7]));
    }) as unknown as typeof fetch;
    const bytes = await wasmBytes({
      wasmUrl: async () => ({ default: "/assets/pdfium.wasm" }),
      wasmFile: () => "unused",
      isNode: () => false,
    });
    expect(asked).toEqual(["/assets/pdfium.wasm"]);
    expect([...bytes]).toEqual([9, 8, 7]);
  });

  it("NODE: reads the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wasm-boot-"));
    const file = join(dir, "z.wasm");
    writeFileSync(file, new Uint8Array([4, 5]));
    const bytes = await wasmBytes({
      wasmUrl: async () => ({ default: "unused" }),
      wasmFile: () => new URL(pathToFileURL(file).href),
    });
    expect([...bytes]).toEqual([4, 5]);
  });
});

describe("isNodeRealm", () => {
  it("is true under bun test", () => {
    expect(isNodeRealm()).toBe(true);
  });
});
