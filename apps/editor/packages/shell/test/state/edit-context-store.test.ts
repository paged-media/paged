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

// Editor ADR 1212 — the edit-context stack as a reducer and a post-commit
// effect queue, and the one exit resolver. Pure: no React, no engine.

import { describe, expect, test } from "bun:test";

import {
  createEditContextStore,
  reduceEditContexts,
  EMPTY_STATE,
} from "../../src/state/edit-context-store";
import {
  resolveContextExit,
  type ContextExitReason,
} from "../../src/state/context-exit";
import type { EditContextContribution } from "../../src/registries/edit-context";

const A = { kind: "rectangle", id: "a" } as never;
const B = { kind: "rectangle", id: "b" } as never;

function ctx(
  type: string,
  calls: string[],
  extra: Partial<EditContextContribution> = {},
): EditContextContribution {
  return {
    type,
    entry: "doubleClick",
    onEnter: (c) =>
      void calls.push(`enter ${type} ${String((c.id as { id: string }).id)}`),
    onCommit: () => void calls.push(`commit ${type}`),
    onCancel: () => void calls.push(`cancel ${type}`),
    onExit: (c) =>
      void calls.push(`exit ${type} ${String((c.id as { id: string }).id)}`),
    ...extra,
  };
}

describe("the exit resolver (D-04)", () => {
  const reasons: ContextExitReason[] = [
    "escape",
    "click-outside",
    "breadcrumb",
    "tool-pick",
    "selection-change",
    "document-switch",
    "profile-change",
  ];

  test("a clean context leaves at once for every reason, never asking", () => {
    for (const policy of [
      "commit-if-safe",
      "ask",
      "discard-allowed",
    ] as const) {
      for (const reason of reasons) {
        const r = resolveContextExit(reason, {
          dirty: false,
          exitPolicy: policy,
        });
        expect(r, `${reason} / ${policy}`).not.toBe("ask");
      }
    }
    expect(resolveContextExit("document-switch", { dirty: false })).toBe("pop");
    expect(
      resolveContextExit("escape", {
        dirty: false,
        exitPolicy: "commit-if-safe",
      }),
    ).toBe("commit");
    expect(resolveContextExit("escape", { dirty: false })).toBe("cancel");
    expect(resolveContextExit("breadcrumb", { dirty: false })).toBe("commit");
  });

  test("a dirty context is never discarded unless cancelled explicitly or the module allows it", () => {
    for (const policy of [
      "commit-if-safe",
      "ask",
      "discard-allowed",
    ] as const) {
      for (const reason of reasons) {
        const r = resolveContextExit(reason, {
          dirty: true,
          exitPolicy: policy,
        });
        if (r === "cancel") {
          expect(policy, `${reason} discards only when allowed`).toBe(
            "discard-allowed",
          );
          expect(["escape", "document-switch"]).toContain(reason);
        }
        expect(r).not.toBe("pop");
      }
    }
    expect(
      resolveContextExit("click-outside", {
        dirty: true,
        exitPolicy: "commit-if-safe",
      }),
    ).toBe("commit");
    expect(
      resolveContextExit("click-outside", { dirty: true, exitPolicy: "ask" }),
    ).toBe("ask");
    expect(
      resolveContextExit("escape", {
        dirty: true,
        exitPolicy: "commit-if-safe",
      }),
    ).toBe("ask");
    expect(
      resolveContextExit("document-switch", {
        dirty: true,
        exitPolicy: "commit-if-safe",
      }),
    ).toBe("ask");
    // Absent policy: what the host did before the field existed.
    expect(resolveContextExit("escape", { dirty: true })).toBe("cancel");
    expect(resolveContextExit("tool-pick", { dirty: true })).toBe("commit");
  });
});

describe("the reducer and the effect queue (CM1)", () => {
  test("UXI-T40 — entering the same context on the same root twice pushes one frame and runs onEnter once @feat:plugin-platform.edit-context @level:edge", () => {
    const calls: string[] = [];
    const store = createEditContextStore();
    const c = ctx("sheet", calls);
    const first = store.enter(c, A);
    const again = store.enter(c, A);
    expect(again).toBe(first);
    expect(store.getSnapshot().stack).toHaveLength(1);
    expect(calls).toEqual(["enter sheet a"]);
  });

  test("the reducer is pure: a no-op returns the same state and no effects", () => {
    const calls: string[] = [];
    const frame = {
      id: "f1",
      type: "t",
      scopeRoot: A,
      toolIds: null,
      panelIds: [],
      label: "T",
      exitPolicy: null,
    };
    const entered = reduceEditContexts(EMPTY_STATE, {
      kind: "enter",
      frame,
      contribution: ctx("t", calls),
      entered: { type: "t", id: A },
    });
    expect(entered.effects.map((e) => e.hook)).toEqual(["onEnter"]);
    const twice = reduceEditContexts(entered.state, {
      kind: "enter",
      frame: { ...frame, id: "f2" },
      contribution: ctx("t", calls),
      entered: { type: "t", id: A },
    });
    expect(twice.state).toBe(entered.state);
    expect(twice.effects).toEqual([]);
    // Nothing ran: the reducer only describes the hooks.
    expect(calls).toEqual([]);
  });

  test("hooks run after the state commit: onEnter sees itself on the stack", () => {
    const store = createEditContextStore();
    const seen: number[] = [];
    store.enter(
      {
        type: "t",
        entry: "doubleClick",
        onEnter: () => void seen.push(store.getSnapshot().stack.length),
        onExit: () => void seen.push(store.getSnapshot().stack.length),
      },
      A,
    );
    store.leave("escape");
    expect(seen).toEqual([1, 0]);
  });

  test("a hook that leaves its own context queues behind: every hook once, in action order", () => {
    const calls: string[] = [];
    const store = createEditContextStore();
    const selfExiting: EditContextContribution = {
      ...ctx("outer", calls),
      onEnter: () => {
        calls.push("enter outer");
        store.cancel();
        calls.push("after cancel");
      },
    };
    store.enter(selfExiting, A);
    expect(calls).toEqual([
      "enter outer",
      "after cancel",
      "cancel outer",
      "exit outer a",
    ]);
    expect(store.getSnapshot().stack).toHaveLength(0);
  });

  test("two stacked contexts of one type keep their own hooks (keyed by frame id)", () => {
    const calls: string[] = [];
    const store = createEditContextStore();
    store.enter(
      ctx("vectorGraphic", calls, {
        onExit: () => void calls.push("exit outer"),
      }),
      A,
    );
    store.enter(
      ctx("vectorGraphic", calls, {
        onExit: () => void calls.push("exit inner"),
      }),
      B,
    );
    expect(store.getSnapshot().stack.map((f) => f.id)).toHaveLength(2);
    store.pop();
    expect(store.getSnapshot().activeContribution).not.toBeNull();
    store.pop();
    expect(calls.filter((c) => c.startsWith("exit"))).toEqual([
      "exit inner",
      "exit outer",
    ]);
  });

  test("a throwing hook never wedges the stack (UXI-PLG-005)", () => {
    const store = createEditContextStore();
    store.enter(
      {
        type: "t",
        entry: "doubleClick",
        onEnter: () => {
          throw new Error("boom");
        },
        onExit: () => {
          throw new Error("boom");
        },
      },
      A,
    );
    expect(store.getSnapshot().stack).toHaveLength(1);
    store.pop();
    expect(store.getSnapshot().stack).toHaveLength(0);
  });

  test("null and [] tool lists stay distinct (UXI-CTX-004)", () => {
    const store = createEditContextStore();
    store.enter({ type: "free", entry: "doubleClick" }, A);
    store.enter({ type: "none", entry: "doubleClick", toolIds: [] }, B);
    const [free, none] = store.getSnapshot().stack;
    expect(free!.toolIds).toBeNull();
    expect(none!.toolIds).toEqual([]);
  });

  test("labels name the content: the module's label, else the type as words (UXI-CTX-005)", () => {
    const store = createEditContextStore();
    store.enter({ type: "webFrame", entry: "doubleClick" }, A);
    store.enter(
      { type: "sheet", entry: "doubleClick", label: "Spreadsheet" },
      B,
    );
    expect(store.getSnapshot().stack.map((f) => f.label)).toEqual([
      "Web frame",
      "Spreadsheet",
    ]);
  });
});

describe("leaving through the resolver", () => {
  test("a dirty context with policy ask asks; Cancel keeps it, Discard cancels it", async () => {
    const calls: string[] = [];
    const store = createEditContextStore();
    const answers: Array<"cancel" | "discard"> = ["cancel", "discard"];
    const asked: string[] = [];
    store.configure({
      ask: async (request) => {
        asked.push(`${request.reason} ${request.label}`);
        return answers.shift()!;
      },
    });
    store.enter(
      ctx("sheet", calls, {
        exitPolicy: "ask",
        label: "Spreadsheet",
        isDirty: () => true,
      }),
      A,
    );
    const kept = store.leave("click-outside");
    expect(kept.outcome).toBe("asking");
    expect(await kept.done).toBe(false);
    expect(store.getSnapshot().stack).toHaveLength(1);
    const discarded = store.leave("click-outside");
    expect(await discarded.done).toBe(true);
    expect(store.getSnapshot().stack).toHaveLength(0);
    expect(asked).toEqual([
      "click-outside Spreadsheet",
      "click-outside Spreadsheet",
    ]);
    expect(calls).toEqual(["enter sheet a", "cancel sheet", "exit sheet a"]);
  });

  test("two exits while one question is open ask once", async () => {
    const store = createEditContextStore();
    let asks = 0;
    let answer!: (a: "commit") => void;
    store.configure({
      ask: () => {
        asks += 1;
        return new Promise((r) => (answer = r));
      },
    });
    store.enter(
      {
        type: "t",
        entry: "doubleClick",
        exitPolicy: "ask",
        isDirty: () => true,
      },
      A,
    );
    const one = store.leave("click-outside");
    const two = store.leave("selection-change");
    answer("commit");
    expect(await one.done).toBe(true);
    expect(await two.done).toBe(true);
    expect(asks).toBe(1);
  });

  test("UXI-T44 — the write scope: the root, then what the engine's scope query says @feat:plugin-platform.edit-context @level:edge", async () => {
    const store = createEditContextStore();
    // Without the query only the root is in scope: root equality is not
    // presented as a subtree (UXI-CTX-011).
    store.enter({ type: "t", entry: "doubleClick" }, A);
    expect(store.isInScope(A)).toBe(true);
    expect(store.isInScope(B)).toBe(false);
    expect(await store.checkScope([A, B])).toEqual([true, false]);
    store.pop();
    expect(store.isInScope(B)).toBe(true); // no context, no restriction

    const member = { kind: "polygon", id: "m" } as never;
    store.configure({
      scopeQuery: async (_root, ids) =>
        ids.map((id) => (id as { id: string }).id === "m"),
    });
    store.enter({ type: "t", entry: "doubleClick" }, A);
    expect(store.isInScope(member)).toBe(false); // not asked yet
    expect(await store.checkScope([member, B])).toEqual([true, false]);
    expect(store.isInScope(member)).toBe(true);
    expect(store.isInScope(B)).toBe(false);
    store.pop();

    // The whole scope (client.editScope, engine ADR 1301): read on entry,
    // so `isInScope` knows the members before anything is checked.
    store.configure({
      editScope: async () => ({
        contains: (id) => (id as { id: string }).id === "m",
      }),
    });
    store.enter({ type: "t", entry: "doubleClick" }, A);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.isInScope(member)).toBe(true);
    expect(store.isInScope(B)).toBe(false);
    expect(await store.checkScope([A, member, B])).toEqual([true, true, false]);
  });

  test("a document switch asks only about unfinished work; a clean context stays until the document goes", async () => {
    const calls: string[] = [];
    const store = createEditContextStore();
    let dirty = true;
    store.configure({ ask: async () => "cancel" });
    store.enter(
      ctx("web", calls, { exitPolicy: "commit-if-safe", isDirty: () => dirty }),
      A,
    );
    expect(await store.resolveForDocumentSwitch()).toBe(false);
    expect(store.getSnapshot().stack).toHaveLength(1);
    dirty = false;
    expect(await store.resolveForDocumentSwitch()).toBe(true);
    expect(store.getSnapshot().stack).toHaveLength(1);
  });
});
