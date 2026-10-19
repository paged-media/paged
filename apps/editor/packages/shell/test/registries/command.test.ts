/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The command registry: the one door every menu item, keybinding, palette
// row, toolbar button and plugin `runCommand` goes through. What it
// promises, and so what this file holds it to:
//
//   · ids are unique; a disposed or unregistered id is gone;
//   · `invoke` runs the handler against the editor the thunk returns AT
//     INVOKE TIME (the shell rebinds the editor without a new registry);
//   · `when` gates EVERY invocation (ADR 024): false, a throw or the inert
//     string form refuse silently — no handler, no observer event, no
//     error dialog;
//   · a declared `args` type (ADR 323) refuses a non-conforming payload
//     with `invalidValue: …` before anything runs;
//   · observers see `started` before the handler and `settled` after it,
//     paired by `seq`, and a throwing observer never breaks a command.

import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "../../src/registries/command";
import type { CommandInvocationEvent } from "../../src/registries/command";
import { isEnabled } from "../../src/registries/types";

const quiet = () => {
  const original = console.error;
  const seen: unknown[][] = [];
  console.error = (...args: unknown[]) => void seen.push(args);
  return {
    seen,
    restore: () => {
      console.error = original;
    },
  };
};

describe("registration", () => {
  test("register, get, list, dispose", () => {
    const r = createCommandRegistry(() => null);
    const handle = r.register({
      id: "t.one",
      title: "One",
      handler: () => {},
    });
    r.register({ id: "t.two", title: "Two", handler: () => {} });
    expect(r.get("t.one")?.title).toBe("One");
    expect(r.list().map((c) => c.id)).toEqual(["t.one", "t.two"]);
    handle.dispose();
    expect(r.get("t.one")).toBeUndefined();
    expect(r.list().map((c) => c.id)).toEqual(["t.two"]);
    // A second dispose is harmless.
    handle.dispose();
    expect(r.list()).toHaveLength(1);
  });

  test("a duplicate id is refused loudly", () => {
    const r = createCommandRegistry(() => null);
    r.register({ id: "t.dup", title: "A", handler: () => {} });
    expect(() =>
      r.register({ id: "t.dup", title: "B", handler: () => {} }),
    ).toThrow(/already registered/);
    // The first registration is untouched.
    expect(r.get("t.dup")?.title).toBe("A");
  });

  test("unregister frees the id for a new registration", () => {
    const r = createCommandRegistry(() => null);
    r.register({ id: "t.x", title: "A", handler: () => 1 });
    r.unregister("t.x");
    expect(r.get("t.x")).toBeUndefined();
    r.register({ id: "t.x", title: "B", handler: () => 2 });
    expect(r.get("t.x")?.title).toBe("B");
    // Unregistering an unknown id is a no-op.
    expect(() => r.unregister("t.never")).not.toThrow();
  });
});

describe("invoke", () => {
  test("an unknown id throws and nothing is observed", async () => {
    const r = createCommandRegistry(() => null);
    const events: CommandInvocationEvent[] = [];
    r.observe((e) => void events.push(e));
    await expect(r.invoke("t.missing")).rejects.toThrow(
      /unknown command "t.missing"/,
    );
    expect(events).toEqual([]);
  });

  test("the handler gets the editor of the moment and the payload as passed", async () => {
    let editor: unknown = { name: "first" };
    const r = createCommandRegistry(() => editor);
    const seen: Array<[unknown, unknown]> = [];
    r.register({
      id: "t.echo",
      title: "Echo",
      handler: (paged, payload) => {
        seen.push([paged, payload]);
        return "result";
      },
    });
    const payload = { a: 1 };
    expect(await r.invoke("t.echo", payload)).toBe("result");
    editor = { name: "second" };
    await r.invoke("t.echo");
    expect(seen[0][0]).toEqual({ name: "first" });
    // Not cloned: the very object the caller passed.
    expect(seen[0][1]).toBe(payload);
    expect(seen[1][0]).toEqual({ name: "second" });
    expect(seen[1][1]).toBeUndefined();
  });

  test("an async handler's result is awaited", async () => {
    const r = createCommandRegistry(() => null);
    r.register({
      id: "t.async",
      title: "Async",
      handler: async () => {
        await new Promise((res) => setTimeout(res, 1));
        return 42;
      },
    });
    expect(await r.invoke("t.async")).toBe(42);
  });

  test("a handler's rejection reaches the caller", async () => {
    const r = createCommandRegistry(() => null);
    r.register({
      id: "t.fail",
      title: "Fail",
      handler: () => {
        throw new Error("boom");
      },
    });
    await expect(r.invoke("t.fail")).rejects.toThrow("boom");
  });
});

describe("`when` gates every invocation (ADR 024)", () => {
  test("a false predicate refuses: undefined, no handler, no observer", async () => {
    let applies = false;
    const r = createCommandRegistry(() => ({ applies }));
    let runs = 0;
    const events: CommandInvocationEvent[] = [];
    r.observe((e) => void events.push(e));
    r.register({
      id: "t.gated",
      title: "Gated",
      when: (state) => (state as { applies: boolean }).applies,
      handler: () => ++runs,
    });
    expect(await r.invoke("t.gated")).toBeUndefined();
    expect(runs).toBe(0);
    expect(events).toEqual([]);
    applies = true;
    expect(await r.invoke("t.gated")).toBe(1);
    expect(events.map((e) => e.phase)).toEqual(["started", "settled"]);
  });

  test("the predicate is read with the editor the thunk returns", async () => {
    const states: unknown[] = [];
    const editor = { editContext: { type: "sheet" } };
    const r = createCommandRegistry(() => editor);
    r.register({
      id: "t.ctx",
      title: "Ctx",
      when: (state) => {
        states.push(state);
        return true;
      },
      handler: () => {},
    });
    await r.invoke("t.ctx");
    expect(states).toEqual([editor]);
  });

  test("a throwing predicate DISABLES the command", async () => {
    const r = createCommandRegistry(() => null);
    let runs = 0;
    r.register({
      id: "t.throws",
      title: "Throws",
      when: () => {
        throw new Error("cannot decide");
      },
      handler: () => ++runs,
    });
    expect(await r.invoke("t.throws")).toBeUndefined();
    expect(runs).toBe(0);
  });

  test("the string DSL form is inert (always disabled) until an evaluator lands", async () => {
    const r = createCommandRegistry(() => null);
    let runs = 0;
    r.register({
      id: "t.dsl",
      title: "DSL",
      when: "selection.hasType('TextFrame')",
      handler: () => ++runs,
    });
    expect(await r.invoke("t.dsl")).toBeUndefined();
    expect(runs).toBe(0);
  });

  test("isEnabled: absent ⇒ enabled, truthy coerced, no state thunk ⇒ undefined state", () => {
    expect(isEnabled(undefined, undefined)).toBe(true);
    expect(
      isEnabled(
        () => 1 as unknown as boolean,
        () => null,
      ),
    ).toBe(true);
    expect(
      isEnabled(
        () => 0 as unknown as boolean,
        () => null,
      ),
    ).toBe(false);
    let got: unknown = "unset";
    isEnabled((s) => {
      got = s;
      return true;
    }, undefined);
    expect(got).toBeUndefined();
    expect(isEnabled("anything", () => null)).toBe(false);
  });

  test("enablement follows the edit context and the workflow mode of the state", async () => {
    // The shape the built-in predicates read: `editContext.type` for
    // ADR 024 (object verbs refuse inside a plugin frame) and the mode a
    // mode-gated item checks. Asserted through the registry, so the
    // gate is the one every surface shares.
    let state: { editContext: { type: string } | null; mode: string } = {
      editContext: null,
      mode: "design",
    };
    const r = createCommandRegistry(() => state);
    const runs: string[] = [];
    r.register({
      id: "t.documentOnly",
      title: "Document only",
      when: (s) => (s as typeof state).editContext === null,
      handler: () => void runs.push("documentOnly"),
    });
    r.register({
      id: "t.sheetOnly",
      title: "Sheet only",
      when: (s) => (s as typeof state).editContext?.type === "sheet",
      handler: () => void runs.push("sheetOnly"),
    });
    r.register({
      id: "t.dataMode",
      title: "Data mode only",
      when: (s) => (s as typeof state).mode === "data",
      handler: () => void runs.push("dataMode"),
    });
    const all = async () => {
      for (const id of ["t.documentOnly", "t.sheetOnly", "t.dataMode"])
        await r.invoke(id);
    };
    await all();
    state = { editContext: { type: "sheet" }, mode: "design" };
    await all();
    state = { editContext: null, mode: "data" };
    await all();
    expect(runs).toEqual([
      "documentOnly",
      "sheetOnly",
      "documentOnly",
      "dataMode",
    ]);
  });
});

describe("args validation (ADR 323)", () => {
  test("a declared struct refuses a non-conforming payload before anything runs", async () => {
    const r = createCommandRegistry(() => null);
    let runs = 0;
    const events: CommandInvocationEvent[] = [];
    r.observe((e) => void events.push(e));
    r.register({
      id: "t.typed",
      title: "Typed",
      args: {
        kind: "struct",
        fields: {
          kind: { kind: "enum", members: ["left", "right"] },
          count: { kind: "number", integer: true },
        },
      },
      handler: () => ++runs,
    });
    await expect(r.invoke("t.typed")).rejects.toThrow(
      /^invalidValue: t\.typed: args must be a record/,
    );
    await expect(r.invoke("t.typed", { kind: "left" })).rejects.toThrow(
      /args\.count is missing/,
    );
    await expect(r.invoke("t.typed", { kind: "up", count: 1 })).rejects.toThrow(
      /invalidValue: t\.typed/,
    );
    await expect(
      r.invoke("t.typed", { kind: "left", count: 1, extra: true }),
    ).rejects.toThrow(/extra field "extra"/);
    expect(runs).toBe(0);
    expect(events).toEqual([]);
    expect(await r.invoke("t.typed", { kind: "left", count: 2 })).toBe(1);
  });

  test("a text command refuses a number", async () => {
    const r = createCommandRegistry(() => null);
    r.register({
      id: "t.text",
      title: "Text",
      args: { kind: "text" },
      handler: (_p, payload) => payload,
    });
    await expect(r.invoke("t.text", 3)).rejects.toThrow(/invalidValue/);
    expect(await r.invoke("t.text", "hello")).toBe("hello");
  });

  test("the editor's declared args apply to the bind-property ids, registered or not", async () => {
    const r = createCommandRegistry(() => null);
    for (const id of [
      "media.paged.data.bindProperty",
      "media.paged.data.command.bindProperty",
    ]) {
      // Declared before any plugin registers it.
      expect(r.argsOf(id)?.kind).toBe("struct");
      r.register({ id, title: "Bind", handler: () => "bound" });
      await expect(r.invoke(id, { selector: "x" })).rejects.toThrow(
        /invalidValue/,
      );
      expect(
        await r.invoke(id, { selector: "s", path: "p", schema: "{}" }),
      ).toBe("bound");
    }
  });

  test("a contribution's own args win over the editor's declaration", async () => {
    const r = createCommandRegistry(() => null);
    r.register({
      id: "media.paged.data.bindProperty",
      title: "Bind",
      args: { kind: "text" },
      handler: () => "ok",
    });
    expect(r.argsOf("media.paged.data.bindProperty")).toEqual({
      kind: "text",
    });
    expect(await r.invoke("media.paged.data.bindProperty", "free text")).toBe(
      "ok",
    );
  });

  test("an untyped command takes any payload", async () => {
    const r = createCommandRegistry(() => null);
    r.register({ id: "t.free", title: "Free", handler: (_p, x) => x });
    expect(r.argsOf("t.free")).toBeUndefined();
    expect(await r.invoke("t.free", [1, "two"])).toEqual([1, "two"]);
  });
});

describe("observers", () => {
  test("started precedes the handler, settled follows it, paired by seq", async () => {
    const r = createCommandRegistry(() => null);
    const log: string[] = [];
    r.observe((e) => void log.push(`${e.phase}:${e.invocation.seq}`));
    r.register({
      id: "t.a",
      title: "A",
      handler: () => void log.push("handler"),
    });
    await r.invoke("t.a", { x: 1 });
    await r.invoke("t.a");
    expect(log).toEqual([
      "started:1",
      "handler",
      "settled:1",
      "started:2",
      "handler",
      "settled:2",
    ]);
  });

  test("overlapping async commands are recorded in CALL order", async () => {
    const r = createCommandRegistry(() => null);
    const started: string[] = [];
    const settled: string[] = [];
    r.observe((e) => {
      (e.phase === "started" ? started : settled).push(e.invocation.id);
    });
    let releaseSlow!: () => void;
    r.register({
      id: "t.slow",
      title: "Slow",
      handler: () => new Promise<void>((res) => (releaseSlow = res)),
    });
    r.register({ id: "t.fast", title: "Fast", handler: () => {} });
    const slow = r.invoke("t.slow");
    await r.invoke("t.fast");
    releaseSlow();
    await slow;
    expect(started).toEqual(["t.slow", "t.fast"]);
    expect(settled).toEqual(["t.fast", "t.slow"]);
  });

  test("a failing handler settles with its error and still throws", async () => {
    const r = createCommandRegistry(() => null);
    const events: CommandInvocationEvent[] = [];
    r.observe((e) => void events.push(e));
    const boom = new Error("boom");
    r.register({
      id: "t.boom",
      title: "Boom",
      handler: () => {
        throw boom;
      },
    });
    await expect(r.invoke("t.boom")).rejects.toBe(boom);
    expect(events.map((e) => e.phase)).toEqual(["started", "settled"]);
    const settled = events[1] as Extract<
      CommandInvocationEvent,
      { phase: "settled" }
    >;
    expect(settled.error).toBe(boom);
    expect(settled.invocation.title).toBe("Boom");
  });

  test("a throwing observer is logged and never breaks the command", async () => {
    const r = createCommandRegistry(() => null);
    const log = quiet();
    try {
      r.observe(() => {
        throw new Error("bad watcher");
      });
      const after: string[] = [];
      r.observe((e) => void after.push(e.phase));
      r.register({ id: "t.ok", title: "OK", handler: () => "fine" });
      expect(await r.invoke("t.ok")).toBe("fine");
      expect(after).toEqual(["started", "settled"]);
      expect(log.seen.length).toBe(2);
    } finally {
      log.restore();
    }
  });

  test("a disposed observer hears nothing more", async () => {
    const r = createCommandRegistry(() => null);
    const events: string[] = [];
    const sub = r.observe((e) => void events.push(e.phase));
    r.register({ id: "t.n", title: "N", handler: () => {} });
    await r.invoke("t.n");
    sub.dispose();
    await r.invoke("t.n");
    expect(events).toEqual(["started", "settled"]);
  });
});
