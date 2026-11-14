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

// Editor ADR 1233 — what a recorded step meant (the selection as an intent,
// UXI-MUT-013), its parameters, the run plan's refusals and undo statement
// (UXI-MUT-014, UXI-MUT-004), the `actions@1` projection and the `paged.*`
// script. Pure: no editor, no engine.

import { describe, expect, test } from "bun:test";

import {
  ActionPlayer,
  SET_PROPERTY_COMMAND,
  applyParams,
  definitionOf,
  isObjectAddress,
  parameterLeaves,
  parseLibrary,
  planRun,
  projectAction,
  resolveSelection,
  stepFromInvocation,
  stepsFromObjectWrite,
  toPagedScript,
  tokenizeSelection,
  type ActionStep,
  type PagedAction,
  type PlayerDeps,
  type RunEnvironment,
} from "../../src/actions";

const SEL = {
  elements: ["rectangle:u1a", "rectangle:u2b"],
  text: null,
};

const action = (
  steps: ActionStep[],
  over: Partial<PagedAction> = {},
): PagedAction => ({
  id: "act_1",
  name: "Tidy captions",
  createdAt: 0,
  steps,
  uncaptured: { gestures: 0, directEdits: 0 },
  includeDocumentBound: false,
  ...over,
});

const env = (over: Partial<RunEnvironment> = {}): RunEnvironment => ({
  documentOpen: true,
  role: "editor",
  context: null,
  contextLabel: (t) => (t === null ? "the page" : `the ${t}`),
  selection: SEL,
  command: () => ({ registered: true, offered: true, ownsHistory: false }),
  checkArgs: () => null,
  isAddress: isObjectAddress,
  missing: new Set(),
  undoGroups: true,
  ownsUndo: () => false,
  ...over,
});

const align = stepFromInvocation(
  {
    seq: 1,
    id: "paged.align.objects",
    title: "Align centres",
    payload: {
      kind: "centerH",
      targets: ["rectangle:u2b", "rectangle:u1a"],
      spacing: 12,
    },
  },
  { selection: SEL, context: null },
);

describe("the selection as an intent (UXI-MUT-013) [editor-shell.panels.actions]", () => {
  test("a payload naming exactly the selection records a token, so the step is portable", () => {
    expect(align.payload).toEqual({
      kind: "centerH",
      targets: { $selection: "elements" },
      spacing: 12,
    });
    expect(align.verdict).toBe("portable");
    expect(align.context).toBeNull();
  });

  test("an id that was not the selection stays an object reference (document-bound)", () => {
    const s = stepFromInvocation(
      {
        seq: 2,
        id: "x",
        title: "x",
        payload: { targets: ["rectangle:u9z12"] },
      },
      { selection: SEL, context: "sheet" },
    );
    expect(s.payload).toEqual({ targets: ["rectangle:u9z12"] });
    expect(s.verdict).toBe("documentBound");
    expect(s.context).toBe("sheet");
  });

  test("one selected item and a text range tokenise as such; replay resolves them", () => {
    const one = { elements: ["textFrame:u5c"], text: "storyRange:u7d@0..4" };
    const p = tokenizeSelection(
      { a: "textFrame:u5c", b: "storyRange:u7d@0..4", c: ["textFrame:u5c"] },
      one,
    );
    expect(p).toEqual({
      a: { $selection: "element" },
      b: { $selection: "text" },
      c: { $selection: "elements" },
    });
    expect(
      resolveSelection(p, {
        elements: ["oval:u8e"],
        text: "storyRange:u3f@2..9",
      }),
    ).toEqual({ a: "oval:u8e", b: "storyRange:u3f@2..9", c: ["oval:u8e"] });
  });

  test("a field's commit over the selection records ONE property step on the selection", () => {
    const steps = stepsFromObjectWrite(
      [
        {
          address: "rectangle:u1a",
          path: "frameFillColor",
          value: "Color/Red",
        },
        {
          address: "rectangle:u2b",
          path: "frameFillColor",
          value: "Color/Red",
        },
      ],
      (path, value) => `Set ${path} to ${String(value)}`,
      { selection: SEL, context: null },
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.command).toBe(SET_PROPERTY_COMMAND);
    expect(steps[0]!.payload).toEqual({
      targets: { $selection: "elements" },
      path: "frameFillColor",
      value: "Color/Red",
    });
  });

  test("parameters: the scalar leaves are offered; a run applies the parameter's value", () => {
    const leaves = parameterLeaves(align.payload, isObjectAddress);
    expect(leaves.map((l) => l.path.join("."))).toEqual(["kind", "spacing"]);
    const params = [
      { id: "p1", label: "spacing", step: 0, path: ["spacing"], value: 24 },
    ];
    expect(applyParams(align.payload, 0, params)).toMatchObject({
      spacing: 24,
    });
    expect(applyParams(align.payload, 1, params)).toMatchObject({
      spacing: 12,
    });
  });

  test("a stored library keeps params and scope; malformed ones are dropped, not the action", () => {
    const lib = parseLibrary({
      schema: 1,
      actions: [
        {
          ...action([align]),
          params: [
            { id: "p", label: "x", step: 0, path: ["spacing"], value: 3 },
          ],
          scope: "document",
        },
        { ...action([align]), id: "b", params: "nope", scope: "elsewhere" },
      ],
    });
    expect(lib.actions[0]!.params).toHaveLength(1);
    expect(lib.actions[0]!.scope).toBe("document");
    expect(lib.actions[1]!.params).toBeUndefined();
    expect(lib.actions[1]!.scope).toBeUndefined();
  });
});

describe("the run plan (UXI-MUT-014, UXI-MUT-004) [editor-shell.panels.actions]", () => {
  test("a plan resolves the selection, lists the targets and says one undo step", () => {
    const plan = planRun(action([align]), env());
    expect(plan.refusals).toEqual([]);
    expect(plan.targets).toEqual(SEL.elements);
    expect(plan.steps[0]!.payload).toMatchObject({ targets: SEL.elements });
    expect(plan.undo).toEqual({ kind: "one" });
  });

  test("nothing selected: refused by step and reason, nothing retargeted", () => {
    const plan = planRun(
      action([align]),
      env({ selection: { elements: [], text: null } }),
    );
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]!.index).toBe(0);
    expect(plan.refusals[0]!.reason).toContain("Align centres");
    expect(plan.targets).toEqual([]);
  });

  test("a recorded object missing from this document is named", () => {
    const pinned = stepFromInvocation(
      {
        seq: 3,
        id: "x",
        title: "Pin",
        payload: { targets: ["rectangle:u9z12"] },
      },
      { selection: SEL, context: null },
    );
    const plan = planRun(
      action([pinned], { includeDocumentBound: true }),
      env({ missing: new Set(["rectangle:u9z12"]) }),
    );
    expect(plan.refusals.map((r) => r.reason).join()).toContain(
      "rectangle:u9z12",
    );
  });

  test("an absent command, another context, a filler role and no document are refused", () => {
    const inSheet = { ...align, context: "sheet" };
    const plan = planRun(
      action([inSheet]),
      env({
        command: () => ({
          registered: false,
          offered: true,
          ownsHistory: false,
        }),
        role: "filler",
        documentOpen: false,
      }),
    );
    const text = plan.refusals.map((r) => r.reason).join("\n");
    expect(text).toContain("the sheet");
    expect(text).toContain("paged.align.objects");
    expect(plan.refusals.length).toBe(4);
  });

  test("a step that makes its own undo step is named before the run; no group: each write", () => {
    const own = planRun(
      action([
        align,
        { ...align, command: "paged.script.run", title: "Run script" },
      ]),
      env({
        command: (id) => ({
          registered: true,
          offered: true,
          ownsHistory: id === "paged.script.run",
        }),
      }),
    );
    expect(own.undo.kind).toBe("several");
    expect(
      planRun(action([align, align]), env({ undoGroups: false })).undo,
    ).toEqual({
      kind: "each",
      steps: 2,
    });
  });

  test("a parameter the command's args refuse is a refusal", () => {
    const plan = planRun(
      action([align], {
        params: [
          {
            id: "p",
            label: "spacing",
            step: 0,
            path: ["spacing"],
            value: "wide",
          },
        ],
      }),
      env({
        checkArgs: (_id, p) =>
          typeof (p as { spacing: unknown }).spacing === "number"
            ? null
            : "spacing must be a number",
      }),
    );
    expect(plan.refusals[0]!.reason).toContain("spacing must be a number");
  });
});

describe("the player refuses at the step, and takes the run back [editor-shell.actions-batch]", () => {
  test("a step that no longer applies stops the run; its one undo step is rolled back", async () => {
    const invoked: string[] = [];
    let rolled: number | null = null;
    const deps: PlayerDeps = {
      async invoke(id) {
        invoked.push(id);
      },
      beginUndoGroup() {},
      endUndoGroup: async () => ({ steps: 1, writes: 1, lastSeq: 41 }),
      applicability: (id) =>
        id === "b"
          ? { state: "disabled", reason: "Needs two objects" }
          : { state: "here" },
      selection: () => SEL,
      context: () => null,
      rollback: async (seq) => {
        rolled = seq;
        return true;
      },
    };
    const step = (command: string): ActionStep => ({
      command,
      title: command,
      verdict: "contextual",
    });
    const s = await new ActionPlayer(
      action([step("a"), step("b"), step("c")]),
      deps,
    ).start();
    expect(s.status).toBe("refused");
    expect(s.refusal).toContain("Needs two objects");
    expect(invoked).toEqual(["a"]);
    expect(rolled).toBe(41);
    expect(s.rolledBack).toBe(true);
  });

  test("the selection token is resolved at the step, with the parameter applied", async () => {
    const sent: unknown[] = [];
    const deps: PlayerDeps = {
      async invoke(_id, payload) {
        sent.push(payload);
      },
      selection: () => ({ elements: ["oval:u3"], text: null }),
    };
    await new ActionPlayer(
      action([align], {
        params: [{ id: "p", label: "s", step: 0, path: ["spacing"], value: 6 }],
      }),
      deps,
    ).start();
    expect(sent).toEqual([
      { kind: "centerH", targets: ["oval:u3"], spacing: 6 },
    ]);
  });
});

describe("on the actions@1 door and as a paged.* script [editor-shell.panels.actions]", () => {
  test("the door's action is pure: what it would invoke over a selection snapshot", () => {
    const a = action([align], {
      params: [{ id: "p", label: "s", step: 0, path: ["spacing"], value: 6 }],
    });
    const def = definitionOf(a);
    expect(def.id).toBe("paged.actions/act_1");
    expect(def.input).toBe("selection");
    expect(def.output).toBe("value");
    expect(def.params?.["p"]).toBe(6);
    expect(typeof def.params?.["revision"]).toBe("string");
    const out = projectAction(a, ["oval:u3"], { p: 9 });
    expect(out.steps[0]!.payload).toEqual({
      kind: "centerH",
      targets: ["oval:u3"],
      spacing: 9,
    });
    expect(projectAction(a, []).needs).toEqual([
      { index: 0, selection: "elements" },
    ]);
    // A changed recording changes the revision (the door's cache key).
    expect(
      definitionOf({ ...a, steps: [align, align] }).params?.["revision"],
    ).not.toBe(def.params?.["revision"]);
  });

  test("property steps become paged.batch over the selection; editor commands say why not", () => {
    const [set] = stepsFromObjectWrite(
      SEL.elements.map((address) => ({
        address,
        path: "frameOpacity",
        value: 40,
      })),
      () => "Set opacity to 40",
      { selection: SEL, context: null },
    );
    const script = toPagedScript(
      action([set!, align]),
      (c) => `editor command ${c}`,
    );
    expect(script).toContain("const selection = JSON.parse(paged.selection())");
    expect(script).toContain(
      'paged.batch(selection.map((address) => ({ op: "set", address, path: "frameOpacity", value: 40 })));',
    );
    expect(script).toContain(
      "// 2. Align centres — editor command paged.align.objects",
    );
  });
});
