// The module door (plugin-sdk ADR 326) and bootEngine's use of it: a host
// without a module backend answers null (load bin/), as does a refusing door
// (the boot catches it); a host's copy that fails to load falls back to the
// glue's own; DuckDB's pre-fetch names why a host copy is unusable.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { hostWasm } from "../bin-url";
import { initEngineGlue } from "../engine";
import { preflightHostedWasm } from "../query/duckdb";

const SRI = "sha384-" + "A".repeat(64);

function host(supports: boolean, modules?: unknown) {
  return {
    supports: (f: string) => supports && f === "modules@1",
    modules,
  } as never;
}

describe("hostWasm", () => {
  it("answers the host's URL + integrity when the door is wired", async () => {
    const resolve = vi.fn(async (name: string) => ({
      url: `https://modules.example/${name}.wasm`,
      integrity: SRI,
    }));
    expect(await hostWasm(host(true, { resolve }))("duckdb-engine")).toEqual({
      url: "https://modules.example/duckdb-engine.wasm",
      integrity: SRI,
    });
    expect(resolve).toHaveBeenCalledWith("duckdb-engine");
  });

  it("is null on a host without a module backend, and the door is not called", async () => {
    const resolve = vi.fn();
    expect(
      await hostWasm(host(false, { resolve }))("duckdb-engine"),
    ).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("initEngineGlue (bootEngine through the door)", () => {
  async function run(
    init: (arg?: unknown) => Promise<void>,
    resolveWasm?: () => Promise<unknown>,
  ) {
    const fallbacks: string[] = [];
    const fetchMock = vi.fn(async () => new Response("wasm"));
    stubGlobal("fetch", fetchMock);
    try {
      await initEngineGlue(init as never, {
        resolveWasm: resolveWasm as never,
        onFallback: (r) => fallbacks.push(r),
      });
    } finally {
      unstubAllGlobals();
    }
    return { fallbacks, fetchMock };
  }

  it("hands the glue the host's copy, fetched with its integrity", async () => {
    const init = vi.fn(async () => {});
    const { fallbacks, fetchMock } = await run(init, async () => ({
      url: "https://m.example/e.wasm",
      integrity: SRI,
    }));
    expect(fallbacks).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("https://m.example/e.wasm", {
      integrity: SRI,
    });
    expect(init).toHaveBeenCalledTimes(1);
    expect((init.mock.calls[0] as unknown[])[0]).toHaveProperty(
      "module_or_path",
    );
  });

  it("passes the URL alone when nobody vouched for the bytes", async () => {
    const init = vi.fn(async () => {});
    await run(init, async () => ({
      url: "https://m.example/e.wasm",
      integrity: null,
    }));
    expect(init).toHaveBeenCalledWith({
      module_or_path: "https://m.example/e.wasm",
    });
  });

  it("falls back to the glue's own copy when the host's fails", async () => {
    const init = vi.fn(async (arg?: unknown) => {
      if (arg) throw new TypeError("Failed to fetch (integrity)");
    });
    const { fallbacks } = await run(init, async () => ({
      url: "https://m.example/e.wasm",
      integrity: SRI,
    }));
    expect(init).toHaveBeenCalledTimes(2);
    expect(init.mock.calls[1]).toEqual([]);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatch(/using the bundle's own/);
  });

  it("loads the glue's own copy without a door, or when the door answers null or refuses", async () => {
    const init = vi.fn(async () => {});
    await run(init);
    await run(init, async () => null);
    await run(init, async () => Promise.reject(new Error("undeclared")));
    expect(init.mock.calls).toEqual([[], [], []]);
  });
});

describe("preflightHostedWasm (DuckDB's pre-fetch)", () => {
  afterEach(() => unstubAllGlobals());

  it("passes a module that is there, fetched with its integrity", async () => {
    const fetchMock = vi.fn(async () => new Response("wasm"));
    stubGlobal("fetch", fetchMock);
    expect(
      await preflightHostedWasm("https://m.example/d.wasm", SRI),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("https://m.example/d.wasm", {
      integrity: SRI,
    });
    expect(
      await preflightHostedWasm("https://m.example/d.wasm", null),
    ).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith("https://m.example/d.wasm");
  });

  it("names why a module is not usable: a status, or a refused fetch", async () => {
    stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    expect(await preflightHostedWasm("https://m.example/d.wasm", null)).toBe(
      "answered HTTP 404",
    );
    stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("integrity mismatch"))),
    );
    expect(await preflightHostedWasm("https://m.example/d.wasm", SRI)).toMatch(
      /with its integrity \(integrity mismatch\)/,
    );
  });
});
