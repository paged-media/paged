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

import { afterEach, describe, expect, it, mock, vi } from "bun:test";

import {
  advanceTimersByTimeAsync,
  importActual,
  stubGlobal,
  unstubAllGlobals,
  waitFor,
} from "../src/index.ts";
import * as fixture from "./fixture.ts";

describe("waitFor", () => {
  afterEach(() => vi.useRealTimers());

  it("retries until the callback stops throwing and returns its value", async () => {
    let calls = 0;
    const value = await waitFor(
      () => {
        calls += 1;
        if (calls < 3) throw new Error("not yet");
        return "done";
      },
      { interval: 1 },
    );
    expect(value).toBe("done");
    expect(calls).toBe(3);
  });

  it("retries a rejecting promise and resolves with the first fulfilled one", async () => {
    let calls = 0;
    const value = await waitFor(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error("not yet");
        return 42;
      },
      { interval: 1 },
    );
    expect(value).toBe(42);
  });

  it("rethrows the last error after the timeout", async () => {
    let calls = 0;
    await expect(
      waitFor(
        () => {
          calls += 1;
          throw new Error(`attempt ${calls}`);
        },
        { timeout: 30, interval: 5 },
      ),
    ).rejects.toThrow(/attempt \d+/);
    expect(calls).toBeGreaterThan(1);
  });

  it("takes a bare number as the timeout", async () => {
    await expect(
      waitFor(() => {
        throw new Error("never");
      }, 20),
    ).rejects.toThrow("never");
  });

  it("advances the fake clock per attempt when given one", async () => {
    vi.useFakeTimers();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 200);
    await waitFor(
      () => {
        if (!fired) throw new Error("not fired");
      },
      { clock: vi, timeout: 1000, interval: 50 },
    );
    expect(fired).toBe(true);
  });

  it("gives up under fake timers after timeout/interval attempts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    await expect(
      waitFor(
        () => {
          calls += 1;
          throw new Error("stuck");
        },
        { clock: vi, timeout: 100, interval: 50 },
      ),
    ).rejects.toThrow("stuck");
    expect(calls).toBe(3);
  });
});

describe("stubGlobal / unstubAllGlobals", () => {
  it("replaces a global and restores the original", () => {
    const original = globalThis.fetch;
    const fake = (() =>
      Promise.resolve(new Response("x"))) as unknown as typeof fetch;
    stubGlobal("fetch", fake);
    expect(globalThis.fetch).toBe(fake);
    stubGlobal("fetch", undefined);
    expect(globalThis.fetch).toBeUndefined();
    unstubAllGlobals();
    expect(globalThis.fetch).toBe(original);
  });

  it("deletes a global that did not exist before", () => {
    stubGlobal("__testKitProbe", 1);
    expect((globalThis as Record<string, unknown>).__testKitProbe).toBe(1);
    unstubAllGlobals();
    expect("__testKitProbe" in globalThis).toBe(false);
  });
});

describe("importActual", () => {
  it("keeps the real exports after the module is mocked", async () => {
    const actual = await importActual(() => import("./fixture.ts"));
    mock.module("./fixture.ts", () => ({ ...actual, answer: () => 0 }));
    expect(fixture.answer()).toBe(0);
    expect(actual.answer()).toBe(42);
    expect(actual.name).toBe("fixture");
  });
});

describe("advanceTimersByTimeAsync", () => {
  afterEach(() => vi.useRealTimers());

  it("fires timers that promise continuations schedule within the window", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    setTimeout(async () => {
      log.push("first");
      await Promise.resolve();
      setTimeout(() => log.push("second"), 100);
    }, 100);
    await advanceTimersByTimeAsync(vi, 199);
    expect(log).toEqual(["first"]);
    await advanceTimersByTimeAsync(vi, 1);
    expect(log).toEqual(["first", "second"]);
  });

  it("lets work queued before the call settle first", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    void Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => setTimeout(() => log.push("late"), 10));
    await advanceTimersByTimeAsync(vi, 10);
    expect(log).toEqual(["late"]);
  });

  it("runs a continuation at its own timer's time, after the test has awaited", async () => {
    vi.useFakeTimers();
    await Promise.resolve();
    const t0 = Date.now();
    const log: string[] = [];
    setTimeout(async () => {
      await Promise.resolve();
      log.push(`continuation@${Date.now() - t0}`);
      setTimeout(() => log.push(`next@${Date.now() - t0}`), 100);
    }, 100);
    setInterval(() => log.push(`tick@${Date.now() - t0}`), 150);
    await advanceTimersByTimeAsync(vi, 300);
    expect(log).toEqual([
      "continuation@100",
      "tick@150",
      "next@200",
      "tick@300",
    ]);
    expect(Date.now() - t0).toBe(300);
  });
});

// tooling/js/bun-test-setup.ts, which every package's `bun test` preloads.
describe("bun-test-setup: toMatchObject leaves the received value alone", () => {
  it("restores what bun's matcher overwrote, at any depth", () => {
    const row = {
      kind: "enum",
      members: ["A", "B", "C"],
      nested: { deep: [{ q: 1 }] },
    };
    expect(row).toMatchObject({
      kind: expect.stringMatching(/en/),
      members: expect.arrayContaining(["A"]),
      nested: { deep: [{ q: expect.any(Number) }] },
    });
    // Compared as JSON: bun's equality treats a matcher on the RECEIVED side
    // as a matcher too, so toEqual would accept the overwritten value.
    expect(JSON.stringify(row)).toBe(
      '{"kind":"enum","members":["A","B","C"],"nested":{"deep":[{"q":1}]}}',
    );
    expect(Array.isArray(row.members)).toBe(true);
  });

  it("still fails, and still negates", () => {
    const row = { kind: "enum" };
    expect(() => expect(row).toMatchObject({ kind: "other" })).toThrow(
      /toMatchObject/,
    );
    expect(row).not.toMatchObject({ kind: "other" });
    expect(() => expect(row).not.toMatchObject({ kind: "enum" })).toThrow();
  });
});
