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

// Design constraints are validated intent (editor ADR 1233): each kind's
// evaluation is deterministic (the same facts, the same answer, whatever
// the order), says by how much a broken constraint misses, plans the moves
// that would make it hold, and never changes anything itself — the
// measurement pass reads the engine and publishes, it never writes.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import { createEditorScope, publicationIssuesOf } from "@paged-media/shell";

import {
  boxOfGeometry,
  evaluateConstraint,
  evaluateConstraints,
  marginSide,
  type DocumentFacts,
  type MemberFacts,
  type PageFacts,
} from "../../../src/constraints/evaluate";
import {
  CONSTRAINTS_LABEL,
  constraintsMutation,
  constraintsOfMeta,
  kindsFor,
  readConstraintsLabel,
  type Constraint,
} from "../../../src/constraints/model";
import { issueLabel, resultText } from "../../../src/constraints/describe";
import { runConstraintPass } from "../../../src/constraints/source";
import {
  ADD_CONSTRAINT_COMMAND,
  addConstraintDraftOf,
} from "../../../src/constraints/add-constraint";
import { constraintStateOf } from "../../../src/constraints/store";

const PAGE: PageFacts = {
  id: "p1",
  index: 0,
  size: [612, 792],
  margins: { top: 36, left: 36, bottom: 36, right: 36 },
  bindingEdge: "left",
};

const rect = (id: string) => ({ kind: "rectangle", id }) as const;
const text = (id: string) => ({ kind: "textFrame", id }) as const;

function facts(
  boxes: Record<string, Partial<MemberFacts> & { box: MemberFacts["box"] }>,
  pages: PageFacts[] = [PAGE],
): DocumentFacts {
  const members = new Map<string, MemberFacts>();
  for (const [key, f] of Object.entries(boxes))
    members.set(key, { pageId: "p1", ...f });
  return { members, pages: new Map(pages.map((p) => [p.id, p])) };
}

const pt = (n: number) => `${n} pt`;

describe("design constraints: evaluation", () => {
  test("align: holds within the tolerance, else says the worst offset and moves the others to the key object", () => {
    const c: Constraint = {
      id: "a",
      kind: "align",
      members: [rect("k"), rect("b"), rect("c")],
      params: { edge: "left" },
    };
    const holding = evaluateConstraint(
      c,
      facts({
        "rectangle:k": { box: [72, 100, 50, 50] },
        "rectangle:b": { box: [72.3, 200, 80, 20] },
        "rectangle:c": { box: [71.8, 300, 10, 10] },
      }),
    );
    expect(holding.status).toBe("holds");
    expect(holding.fix).toBeNull();

    const broken = evaluateConstraint(
      c,
      facts({
        "rectangle:k": { box: [72, 100, 50, 50] },
        "rectangle:b": { box: [76.5, 200, 80, 20] },
        "rectangle:c": { box: [72, 300, 10, 10] },
      }),
    );
    expect(broken.status).toBe("broken");
    expect(broken.measure).toEqual({
      kind: "align",
      edge: "left",
      offsets: [0, 4.5, 0],
      worst: 4.5,
    });
    // Only the one that is off moves, onto the key object's edge.
    expect(broken.fix).toEqual({
      kind: "move",
      moves: [{ member: rect("b"), dx: -4.5, dy: 0 }],
      ghosts: [{ pageId: "p1", box: [72, 200, 80, 20] }],
    });
    expect(resultText(broken, pt)).toBe("Off by up to 4.5 pt");
    expect(issueLabel(c, broken, pt)).toBe(
      "Left edges aligned (3 items): Off by up to 4.5 pt",
    );
  });

  test("align on first baselines reads each frame's first line, and only text frames", () => {
    const c: Constraint = {
      id: "b",
      kind: "align",
      members: [text("t1"), text("t2")],
      params: { edge: "baseline" },
    };
    const r = evaluateConstraint(
      c,
      facts({
        "textFrame:t1": { box: [0, 0, 100, 40], firstLineFoot: 20 },
        "textFrame:t2": { box: [200, 2, 100, 40], firstLineFoot: 23 },
      }),
    );
    expect(r.status).toBe("broken");
    expect(r.fix?.kind === "move" && r.fix.moves).toEqual([
      { member: text("t2"), dx: 0, dy: -3 },
    ]);
    const mixed = evaluateConstraint(
      { ...c, members: [text("t1"), rect("r")] },
      facts({
        "textFrame:t1": { box: [0, 0, 100, 40], firstLineFoot: 20 },
        "rectangle:r": { box: [0, 0, 10, 10] },
      }),
    );
    expect(mixed.status).toBe("unknown");
    expect(mixed.reason).toBe("not-text");
  });

  test("equal spacing: the even gap keeps the first and the last where they are", () => {
    const c: Constraint = {
      id: "s",
      kind: "equal-spacing",
      members: [rect("c"), rect("a"), rect("b")],
      params: { axis: "horizontal" },
    };
    const doc = facts({
      "rectangle:a": { box: [0, 0, 100, 50] },
      "rectangle:b": { box: [110, 0, 100, 50] },
      "rectangle:c": { box: [240, 0, 100, 50] },
    });
    const r = evaluateConstraint(c, doc);
    expect(r.status).toBe("broken");
    expect(r.measure).toEqual({
      kind: "equal-spacing",
      gaps: [10, 30],
      min: 10,
      max: 30,
      target: 20,
    });
    expect(r.fix).toEqual({
      kind: "move",
      moves: [{ member: rect("b"), dx: 10, dy: 0 }],
      ghosts: [{ pageId: "p1", box: [120, 0, 100, 50] }],
    });
    // The members' order in the record does not change the answer.
    const reordered = evaluateConstraint(
      { ...c, members: [rect("b"), rect("c"), rect("a")] },
      doc,
    );
    expect(reordered.measure).toEqual(r.measure);
    expect(reordered.fix?.kind === "move" && reordered.fix.moves).toEqual([
      { member: rect("b"), dx: 10, dy: 0 },
    ]);
  });

  test("minimum gap: measured along the axis that separates them; the fix moves the second away", () => {
    const c: Constraint = {
      id: "g",
      kind: "min-gap",
      members: [rect("a"), rect("b")],
      params: { gap: 14.17 },
    };
    const r = evaluateConstraint(
      c,
      facts({
        "rectangle:a": { box: [0, 0, 100, 100] },
        "rectangle:b": { box: [0, 108, 100, 40] },
      }),
    );
    expect(r.measure).toEqual({
      kind: "min-gap",
      gap: 8,
      required: 14.17,
      axis: "vertical",
    });
    expect(r.fix?.kind === "move" && r.fix.moves).toEqual([
      { member: rect("b"), dx: 0, dy: 6.17 },
    ]);
    const ok = evaluateConstraint(
      c,
      facts({
        "rectangle:a": { box: [0, 0, 100, 100] },
        "rectangle:b": { box: [130, 0, 100, 40] },
      }),
    );
    expect(ok.status).toBe("holds");
  });

  test("maximum lines and must fit read the text; only the frame's own fix is offered", () => {
    const lines: Constraint = {
      id: "l",
      kind: "max-lines",
      members: [text("h")],
      params: { lines: 3 },
    };
    const four = evaluateConstraint(
      lines,
      facts({
        "textFrame:h": { box: [0, 0, 200, 60], lines: 4, overset: false },
      }),
    );
    expect(four.status).toBe("broken");
    expect(resultText(four)).toBe("4 lines; at most 3");
    // Fewer lines take other words or type: no change is offered.
    expect(four.fix).toEqual({ kind: "edit-text", member: text("h") });
    const three = evaluateConstraint(
      lines,
      facts({
        "textFrame:h": { box: [0, 0, 200, 60], lines: 3, overset: false },
      }),
    );
    expect(three.status).toBe("holds");

    const fits: Constraint = {
      id: "f",
      kind: "fits",
      members: [text("n")],
      params: {},
    };
    const over = evaluateConstraint(
      fits,
      facts({ "textFrame:n": { box: [0, 0, 200, 60], overset: true } }),
    );
    expect(over.fix).toEqual({ kind: "expand-frame", member: text("n") });
    expect(resultText(over)).toBe("The text does not fit");
  });

  test("margin: outer is the side away from the spine, page by page", () => {
    expect(marginSide("outer", PAGE)).toBe("right");
    expect(marginSide("outer", { ...PAGE, bindingEdge: "right" })).toBe("left");
    expect(marginSide("inner", { ...PAGE, bindingEdge: "right" })).toBe(
      "right",
    );
    const c: Constraint = {
      id: "m",
      kind: "margin",
      members: [rect("logo")],
      params: { margin: "outer" },
    };
    const r = evaluateConstraint(
      c,
      facts({ "rectangle:logo": { box: [470, 40, 100, 30] } }),
    );
    // The outer (right) margin line is at 612 − 36 = 576; the right edge at 570.
    expect(r.measure).toEqual({
      kind: "margin",
      margin: "outer",
      side: "right",
      offsets: [-6],
      worst: 6,
    });
    expect(r.fix?.kind === "move" && r.fix.moves).toEqual([
      { member: rect("logo"), dx: 6, dy: 0 },
    ]);
  });

  test("a member that is gone leaves its constraint unknown, never silently dropped", () => {
    const c: Constraint = {
      id: "x",
      kind: "align",
      members: [rect("here"), rect("gone")],
      params: { edge: "top" },
    };
    const r = evaluateConstraint(
      c,
      facts({ "rectangle:here": { box: [0, 0, 1, 1] } }),
    );
    expect(r.status).toBe("unknown");
    expect(r.reason).toBe("missing-member");
    expect(r.fix).toBeNull();
  });

  test("deterministic: the same facts give the same answers, to the hundredth of a point", () => {
    const list: Constraint[] = [
      {
        id: "1",
        kind: "align",
        members: [rect("a"), rect("b")],
        params: { edge: "centerY" },
      },
      {
        id: "2",
        kind: "equal-spacing",
        members: [rect("a"), rect("b"), rect("c")],
        params: { axis: "vertical" },
      },
    ];
    const doc = facts({
      "rectangle:a": { box: [0, 0.333333, 10, 10.1] },
      "rectangle:b": { box: [0, 20.7777, 10, 10] },
      "rectangle:c": { box: [0, 41.123456, 10, 10] },
    });
    // What was measured and planned (the boxes are the facts as read).
    const answer = () =>
      JSON.stringify(
        evaluateConstraints(list, doc).map(({ boxes: _boxes, ...r }) => r),
      );
    const once = answer();
    for (let i = 0; i < 5; i++) expect(answer()).toBe(once);
    expect(once).not.toMatch(/\d\.\d{3,}/);
  });

  test("an item's box is its oriented frame's bounding box on the page", () => {
    expect(boxOfGeometry([10, 20, 30, 60], [1, 0, 0, 1, 100, 50])).toEqual([
      120, 60, 40, 20,
    ]);
    // A quarter turn about the origin, then moved.
    expect(boxOfGeometry([0, 0, 10, 20], [0, 1, -1, 0, 100, 100])).toEqual([
      90, 100, 10, 20,
    ]);
  });
});

describe("design constraints: the record", () => {
  test("the label round-trips; an unreadable record is left out, never repaired", () => {
    const list: Constraint[] = [
      {
        id: "c1",
        kind: "align",
        members: [rect("a"), rect("b")],
        params: { edge: "left" },
      },
      {
        id: "c2",
        kind: "max-lines",
        members: [text("t")],
        params: { lines: 2 },
        label: "Headline ≤ 2",
      },
    ];
    const m = constraintsMutation(list);
    expect(m.args.key).toBe(CONSTRAINTS_LABEL);
    // ASCII only: a label survives InDesign byte for byte.
    expect(m.args.value).toMatch(/^[\x20-\x7e]*$/);
    expect(readConstraintsLabel(m.args.value)).toEqual(list);
    expect(
      constraintsOfMeta({
        pluginMetadata: [{ key: CONSTRAINTS_LABEL, value: m.args.value! }],
      }),
    ).toEqual(list);
    const damaged = JSON.stringify({
      v: 1,
      data: {
        constraints: [
          list[0],
          {
            id: "bad",
            kind: "align",
            members: [rect("a")],
            params: { edge: "left" },
          },
          { id: "worse", kind: "solve-everything", members: [], params: {} },
          { ...list[0], id: "c1" },
        ],
      },
    });
    expect(readConstraintsLabel(damaged)).toEqual([list[0]!]);
    expect(constraintsMutation([]).args.value).toBeNull();
  });

  test("the kinds a selection can take", () => {
    expect(kindsFor([text("t")])).toEqual(["max-lines", "fits", "margin"]);
    expect(kindsFor([rect("r")])).toEqual(["margin"]);
    expect(kindsFor([rect("a"), rect("b")])).toEqual([
      "align",
      "min-gap",
      "margin",
    ]);
    expect(kindsFor([rect("a"), rect("b"), rect("c")])).toEqual([
      "equal-spacing",
      "align",
      "margin",
    ]);
  });
});

describe("design constraints: Object ▸ Add constraint…", () => {
  test("needs a selection, and opens its dialog for the selection, key object first", async () => {
    covers("command:paged.object.addConstraint");
    const scope = createEditorScope();
    const editor = (selection: unknown[]) => ({
      scope,
      document: { handle: { pageCount: 1 } },
      selection: { elementSelection: selection },
    });
    expect(ADD_CONSTRAINT_COMMAND.applicability?.(editor([]))).toEqual({
      state: "disabled",
      reason: "Select an object first.",
    });
    expect(ADD_CONSTRAINT_COMMAND.applicability?.(editor([rect("a")]))).toEqual(
      { state: "here" },
    );
    await ADD_CONSTRAINT_COMMAND.handler(
      editor([rect("k"), rect("b")]) as never,
    );
    expect(addConstraintDraftOf(scope)).toEqual([rect("k"), rect("b")]);
  });
});

describe("design constraints: never auto-move", () => {
  test("a pass over broken constraints reads, publishes issues and results, and writes nothing", async () => {
    covers("panel:paged.publication-health");
    const scope = createEditorScope();
    const writes: unknown[] = [];
    const client = {
      elementGeometry: async (ids: Array<{ kind: string; id: string }>) =>
        ids.map((id, i) => ({
          id,
          pageId: "p1",
          bounds: [100, 72 + i * 7, 150, 172 + i * 7],
          itemTransform: [1, 0, 0, 1, 0, 0],
        })),
      selectionGeometry: async () => [],
      mutate: async (m: unknown) => {
        writes.push(m);
        return { kind: "mutationApplied" };
      },
    };
    const list: Constraint[] = [
      {
        id: "c1",
        kind: "align",
        members: [rect("a"), rect("b")],
        params: { edge: "left" },
      },
    ];
    await runConstraintPass(
      scope,
      client as never,
      list,
      new Map([[PAGE.id, PAGE]]),
      [],
      null,
      () => true,
    );
    expect(writes).toEqual([]);
    const r = constraintStateOf(scope).results.get("c1");
    expect(r?.status).toBe("broken");
    expect(r?.fix?.kind).toBe("move");
    const issues = publicationIssuesOf(scope).issues;
    expect(issues.map((i) => [i.id, i.kind, i.severity, i.pageIndex])).toEqual([
      ["constraint:c1", "constraint", "warning", 0],
    ]);
    // Another gatherer's issues stay beside them.
    expect(issues[0]!.element).toEqual(rect("a"));
  });

  test("a pass that is no longer the newest publishes nothing", async () => {
    const scope = createEditorScope();
    const client = {
      elementGeometry: async () => [],
      selectionGeometry: async () => [],
    };
    await runConstraintPass(
      scope,
      client as never,
      [{ id: "c", kind: "fits", members: [text("t")], params: {} }],
      new Map(),
      [],
      null,
      () => false,
    );
    expect(publicationIssuesOf(scope).issues).toEqual([]);
  });
});
