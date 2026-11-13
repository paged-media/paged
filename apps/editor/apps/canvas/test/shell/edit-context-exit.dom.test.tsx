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

// One way out of an edit context (editor ADR 1212), on a mounted PagedShell
// over the real engine: every exit — a press outside the frame, Escape, the
// breadcrumb, another tool, another selection, another document — goes
// through the one resolver; a dirty context whose module asks to be asked
// puts up the resolve prompt; the replace question waits for it; selecting
// inside the context's scope keeps it. Hooks run once, after the stack
// changed, also under StrictMode.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { StrictMode, useEffect } from "react";

import { CanvasClient, type ElementId } from "@paged-media/client";
import {
  PagedShell,
  confirmReplace,
  createEditorScope,
  useEditContextStack,
  useRegistries,
  useSelection,
  type EditContextContribution,
  type EditContextStackValue,
  type EditorScope,
  type ModeContribution,
  type ShellRegistries,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";

import { EngineWorker, headlessEngine } from "../panels/engine-worker";

const MODES: ModeContribution[] = [
  {
    id: "design",
    title: "Design",
    icon: "mode-design",
    order: 0,
    slots: { left: "test.left" },
  },
];

afterEach(() => cleanup());

interface Probe {
  registries: ShellRegistries;
  stack: EditContextStackValue;
  selection: ReturnType<typeof useSelection>;
}

let probe: Probe | null = null;
function Capture() {
  const registries = useRegistries();
  const stack = useEditContextStack();
  const selection = useSelection();
  useEffect(() => {
    probe = { registries, stack, selection };
  });
  return null;
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountShell(
  opts: {
    strict?: boolean;
    /** Stands in for the engine's scope (EN5, `editScope` and
     *  `scopeContains`): which ids lie inside a root's subtree. */
    scopeMembers?: (ids: readonly ElementId[]) => boolean[];
  } = {},
) {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  const blank = await client.newBlankDocument(612, 792);
  const frame = async (x: number): Promise<ElementId> => {
    const r = (await client.mutate({
      op: "insertFrame",
      args: { pageId: blank.pageIds[0], bounds: [40, x, 140, x + 100] },
    })) as { kind: string; payload?: { createdId?: ElementId } };
    expect(r.kind).toBe("mutationApplied");
    return r.payload!.createdId!;
  };
  const a = await frame(40);
  const b = await frame(300);
  const c = await frame(420);
  if (opts.scopeMembers) {
    const members = opts.scopeMembers;
    const fake = client as unknown as {
      scopeContains: unknown;
      editScope: unknown;
    };
    fake.scopeContains = async (_root: ElementId, ids: readonly ElementId[]) =>
      members(ids);
    fake.editScope = async (root: ElementId) => ({
      root,
      contains: (id: ElementId) => members([id])[0] === true,
    });
  }
  const scope: EditorScope = createEditorScope();
  probe = null;
  const shell = (
    <PagedShell
      client={client}
      scope={scope}
      panels={[{ id: "test.left", title: "Left", component: () => null }]}
      tools={BUILT_IN_TOOLS}
      modes={MODES}
      initialMode="design"
      canvasComponent={() => <div data-test-canvas />}
    >
      <Capture />
    </PagedShell>
  );
  await act(async () => {
    render(opts.strict ? <StrictMode>{shell}</StrictMode> : shell);
  });
  await settle();
  if (!probe) throw new Error("PagedShell did not mount");
  const p = () => probe!;
  return {
    client,
    scope,
    a,
    b,
    c,
    p,
    async enter(c: EditContextContribution, on: ElementId) {
      await act(async () => {
        const ids = await client.setElementSelection([on], "replace");
        p().selection.setElementSelection(ids);
      });
      await act(async () => {
        p().stack.enter(c, on);
      });
      await settle();
    },
    async select(id: ElementId) {
      await act(async () => {
        const ids = await client.setElementSelection([id], "replace");
        p().selection.setElementSelection(ids);
      });
      await settle();
    },
    dialog: () =>
      document.querySelector<HTMLElement>(
        '[data-testid="context-exit-dialog"]',
      ),
    async answer(id: "commit" | "discard" | "cancel") {
      const b = document.querySelector<HTMLButtonElement>(
        `[data-testid="context-exit-${id}"]`,
      );
      if (!b) throw new Error(`no ${id} button`);
      await act(async () => {
        fireEvent.click(b);
      });
      await settle();
    },
    async escape() {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        document.body.dispatchEvent(event);
      });
      await settle();
    },
    undoLen: async () => (await client.undoLog(0)).undoLen,
  };
}

function contribution(
  calls: string[],
  extra: Partial<EditContextContribution> = {},
): EditContextContribution {
  return {
    type: "test.module",
    entry: "doubleClick",
    label: "Test content",
    onEnter: () => void calls.push("enter"),
    onCommit: () => void calls.push("commit"),
    onCancel: () => void calls.push("cancel"),
    onExit: () => void calls.push("exit"),
    ...extra,
  };
}

describe("one way out of a context (ADR 1212)", () => {
  test("UXI-T40 — entering the same context twice under StrictMode: one frame, one onEnter @feat:plugin-platform.edit-context @level:edge", async () => {
    const s = await mountShell({ strict: true });
    const calls: string[] = [];
    const c = contribution(calls);
    await s.enter(c, s.a);
    await s.enter(c, s.a);
    expect(s.p().stack.stack).toHaveLength(1);
    expect(calls).toEqual(["enter"]);
    // The breadcrumb names the content as the module does (F-45).
    const crumb = document.querySelector(
      '[data-edit-context-crumb="test.module"]',
    );
    expect(crumb?.textContent).toBe("Test content");
  });

  test("UXI-T41 — a press outside a clean context leaves it at once and keeps its work; the click goes on @feat:plugin-platform.edit-context @level:edge", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await s.enter(contribution(calls, { exitPolicy: "commit-if-safe" }), s.a);
    const undo = await s.undoLen();
    let outcome = "";
    await act(async () => {
      outcome = s.p().stack.leave("click-outside").outcome;
    });
    // The canvas calls this where it committed; "left" lets its click act
    // on what it landed on.
    expect(outcome).toBe("left");
    expect(s.p().stack.active).toBeNull();
    expect(calls).toEqual(["enter", "commit", "exit"]);
    expect(s.dialog()).toBeNull();
    expect(await s.undoLen()).toBe(undo);
  });

  test("UXI-T44 — selecting inside the context's scope keeps it; selecting outside leaves it, and nothing outside changes @feat:plugin-platform.edit-context @level:edge", async () => {
    // The scope query says `b` lies inside `a`'s scope, `c` does not.
    let insideId = "";
    const s = await mountShell({
      scopeMembers: (ids) =>
        ids.map((id) => (id as { id: string }).id === insideId),
    });
    insideId = (s.b as { id: string }).id;
    const calls: string[] = [];
    await s.enter(contribution(calls, { exitPolicy: "commit-if-safe" }), s.a);
    const undo = await s.undoLen();
    const outsideBefore = await s.client.elementGeometry([s.c]);
    await s.select(s.b);
    expect(s.p().stack.active?.type).toBe("test.module");
    expect(s.p().stack.isInScope(s.b)).toBe(true);
    expect(s.p().stack.isInScope(s.c)).toBe(false);
    await s.select(s.c);
    expect(s.p().stack.active).toBeNull();
    expect(calls).toEqual(["enter", "commit", "exit"]);
    // No out-of-scope mutation: the outside frame and the history are as
    // they were.
    expect(await s.client.elementGeometry([s.c])).toEqual(outsideBefore);
    expect(await s.undoLen()).toBe(undo);
  });

  test("UXI-T41 — selecting another frame, outside the context's scope, leaves through the same resolver @feat:plugin-platform.edit-context @level:edge", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await s.enter(contribution(calls, { exitPolicy: "commit-if-safe" }), s.a);
    await s.select(s.b);
    expect(s.p().stack.active).toBeNull();
    expect(calls).toEqual(["enter", "commit", "exit"]);
  });

  test("UXI-T42 — Escape in a dirty context resolves its pending edit: the module's sub-edit first, the context stays, nothing is lost silently @feat:plugin-platform.edit-context @level:edge", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    let editing = true;
    await s.enter(
      contribution(calls, {
        exitPolicy: "ask",
        isDirty: () => editing,
        onContentKey: (e) => {
          if (e.key === "Escape") {
            calls.push("sub-edit cancelled");
            editing = false;
          }
        },
      }),
      s.a,
    );
    const undo = await s.undoLen();
    await s.escape();
    expect(calls).toEqual(["enter", "sub-edit cancelled"]);
    expect(s.p().stack.active?.type).toBe("test.module");
    await s.escape();
    expect(s.p().stack.active).toBeNull();
    expect(calls).toEqual(["enter", "sub-edit cancelled", "cancel", "exit"]);
    expect(await s.undoLen()).toBe(undo);
  });

  test("UXI-T42 — a dirty context that asks: the prompt keeps the work unless the user discards it @feat:plugin-platform.edit-context @level:edge", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await s.enter(
      contribution(calls, { exitPolicy: "ask", isDirty: () => true }),
      s.a,
    );
    let leaving: ReturnType<EditContextStackValue["leave"]> | null = null;
    await act(async () => {
      leaving = s.p().stack.leave("click-outside");
    });
    await settle();
    expect(leaving!.outcome).toBe("asking");
    expect(s.dialog()?.getAttribute("data-context-exit-reason")).toBe(
      "click-outside",
    );
    expect(s.dialog()?.textContent).toContain("Test content");
    await s.answer("cancel");
    expect(await leaving!.done).toBe(false);
    expect(s.p().stack.active?.type).toBe("test.module");
    expect(calls).toEqual(["enter"]);

    await act(async () => {
      leaving = s.p().stack.leave("tool-pick");
    });
    await settle();
    await s.answer("commit");
    expect(await leaving!.done).toBe(true);
    expect(s.p().stack.active).toBeNull();
    expect(calls).toEqual(["enter", "commit", "exit"]);
  });

  test("UXI-T43 — switching documents inside a dirty context asks first; Cancel keeps the document and the context @feat:plugin-platform.edit-context @level:edge", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await s.enter(
      contribution(calls, {
        exitPolicy: "commit-if-safe",
        isDirty: () => true,
      }),
      s.a,
    );
    const docBefore = (await s.client.documentMeta()).dirty;
    let proceed: boolean | null = null;
    await act(async () => {
      void confirmReplace(s.scope, s.client, {
        action: "Opening other.idml",
      }).then((ok) => (proceed = ok));
    });
    await settle();
    expect(s.dialog()?.getAttribute("data-context-exit-reason")).toBe(
      "document-switch",
    );
    await s.answer("cancel");
    expect(proceed).toBe(false);
    expect(s.p().stack.active?.type).toBe("test.module");
    expect(calls).toEqual(["enter"]);
    expect((await s.client.documentMeta()).dirty).toBe(docBefore);
  });

  test("UXI-T43 — Discard in the document-switch question cancels the context's work, then the replace question decides @feat:plugin-platform.edit-context @level:edge", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await s.enter(
      contribution(calls, { exitPolicy: "ask", isDirty: () => true }),
      s.a,
    );
    let proceed: boolean | null = null;
    await act(async () => {
      void confirmReplace(s.scope, s.client, {
        action: "Opening other.idml",
      }).then((ok) => (proceed = ok));
    });
    await settle();
    await s.answer("discard");
    expect(calls).toEqual(["enter", "cancel", "exit"]);
    expect(s.p().stack.active).toBeNull();
    // The document itself had edits (the two frames), so the replace
    // question follows.
    const replace = document.querySelector(
      '[data-testid="replace-document-dialog"]',
    );
    if (replace) {
      const keep = document.querySelector<HTMLButtonElement>(
        '[data-testid="replace-document-keep"]',
      )!;
      await act(async () => {
        fireEvent.click(keep);
      });
      await settle();
      expect(proceed).toBe(false);
    } else {
      expect(proceed).toBe(true);
    }
  });

  test("the breadcrumb leaves through the resolver: an ancestor stays, the last crumb leaves", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await s.enter(
      contribution(calls, {
        type: "test.outer",
        label: "Outer",
        onCommit: () => void calls.push("commit outer"),
        onExit: () => void calls.push("exit outer"),
      }),
      s.a,
    );
    await act(async () => {
      s.p().stack.enter(
        contribution(calls, {
          type: "test.inner",
          label: "Inner",
          onCommit: () => void calls.push("commit inner"),
          onExit: () => void calls.push("exit inner"),
        }),
        s.a,
      );
    });
    await settle();
    const outer = document.querySelector<HTMLButtonElement>(
      '[data-edit-context-crumb="test.outer"]',
    )!;
    await act(async () => {
      fireEvent.click(outer);
    });
    await settle();
    expect(s.p().stack.stack.map((f) => f.type)).toEqual(["test.outer"]);
    const last = document.querySelector<HTMLButtonElement>(
      '[data-edit-context-crumb="test.outer"]',
    )!;
    await act(async () => {
      fireEvent.click(last);
    });
    await settle();
    expect(s.p().stack.active).toBeNull();
    expect(calls.filter((c) => c !== "enter")).toEqual([
      "commit inner",
      "exit inner",
      "commit outer",
      "exit outer",
    ]);
  });

  test("an entered group is a level of the breadcrumb", async () => {
    const s = await mountShell();
    await act(async () => {
      s.p().selection.setActiveGroup("g2", ["g1", "g2", "g3"]);
    });
    await settle();
    expect(s.p().selection.activeGroupPath).toEqual(["g1", "g2"]);
    const crumbs = document.querySelectorAll("[data-group-crumb]");
    expect(crumbs.length).toBe(2);
    await act(async () => {
      s.p().selection.setActiveGroup(null);
    });
    await settle();
    expect(document.querySelectorAll("[data-group-crumb]").length).toBe(0);
  });
});
