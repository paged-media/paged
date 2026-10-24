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

// WP4.11 — the action player: a replay is ONE undo unit (the client's
// undo group around each uninterrupted run), breakpoints pause before
// their step, an inserted stop halts with its message, Step runs one
// step at a time, Cancel ends where it stands. A fake registry and a
// fake group record what the player asked for.

import { describe, expect, test } from "bun:test";

import {
  ActionPlayer,
  stopStep,
  type ActionStep,
  type PagedAction,
  type PlayerDeps,
} from "../../src/actions";

const step = (command: string, over: Partial<ActionStep> = {}): ActionStep => ({
  command,
  title: command,
  verdict: "contextual",
  ...over,
});

const action = (steps: ActionStep[]): PagedAction => ({
  id: "a1",
  name: "Test",
  createdAt: 0,
  steps,
  uncaptured: { gestures: 0, directEdits: 0 },
  includeDocumentBound: false,
});

/** A registry + undo group: every invoked command "writes" once; the
 *  group joins writes while nothing intervened. */
function rig(failing: string[] = []) {
  const invoked: string[] = [];
  const groups: Array<{ continueSeq: number | null; writes: number }> = [];
  let open: { continueSeq: number | null; writes: number } | null = null;
  let seq = 100;
  let top: number | null = null;
  const deps: PlayerDeps = {
    async invoke(id) {
      invoked.push(id);
      if (failing.includes(id)) throw new Error(`${id} refused`);
      if (open) open.writes += 1;
    },
    beginUndoGroup({ continueSeq }) {
      open = { continueSeq: continueSeq ?? null, writes: 0 };
    },
    async endUndoGroup() {
      const g = open!;
      open = null;
      groups.push(g);
      if (g.writes === 0)
        return { steps: 0, writes: 0, lastSeq: g.continueSeq };
      // Joined when it continues the step still on top.
      const joins = g.continueSeq !== null && g.continueSeq === top;
      if (!joins) top = ++seq;
      return { steps: joins ? 0 : 1, writes: g.writes, lastSeq: top };
    },
  };
  return {
    deps,
    invoked,
    groups,
    /** The user edits the document while the player waits. */
    userEdits() {
      top = ++seq;
    },
  };
}

describe("ActionPlayer [editor-shell.actions-batch]", () => {
  test("a replay runs every step inside ONE undo group and reports one undo step", async () => {
    const r = rig();
    const p = new ActionPlayer(
      action([step("a"), step("b"), step("c")]),
      r.deps,
    );
    const s = await p.start();
    expect(s.status).toBe("done");
    expect(r.invoked).toEqual(["a", "b", "c"]);
    expect(r.groups).toHaveLength(1);
    expect(s.undoSteps).toBe(1);
    expect(s.writes).toBe(3);
  });

  test("without an undo group the step count is unknown (-1), not invented", async () => {
    const r = rig();
    const p = new ActionPlayer(action([step("a")]), { invoke: r.deps.invoke });
    expect((await p.start()).undoSteps).toBe(-1);
  });

  test("a failing step is reported and the replay goes on", async () => {
    const r = rig(["b"]);
    const s = await new ActionPlayer(
      action([step("a"), step("b"), step("c")]),
      r.deps,
    ).start();
    expect(s.ran.map((x) => x.error)).toEqual([null, "b refused", null]);
    expect(s.status).toBe("done");
  });

  test("a breakpoint pauses BEFORE its step; Continue runs it and joins the same undo step", async () => {
    const r = rig();
    const p = new ActionPlayer(
      action([step("a"), step("b", { pause: true }), step("c")]),
      r.deps,
    );
    let s = await p.start();
    expect(s.status).toBe("paused");
    expect(s.pausedAt).toBe(1);
    expect(r.invoked).toEqual(["a"]);
    s = await p.resume();
    expect(s.status).toBe("done");
    expect(r.invoked).toEqual(["a", "b", "c"]);
    // Two groups (the pause closed the first), the second continued the
    // first's step: still one undo step.
    expect(r.groups).toHaveLength(2);
    expect(r.groups[1].continueSeq).not.toBeNull();
    expect(s.undoSteps).toBe(1);
  });

  test("an edit made during a pause stays the user's own step: the rest becomes a second step", async () => {
    const r = rig();
    const p = new ActionPlayer(
      action([step("a"), step("b", { pause: true })]),
      r.deps,
    );
    await p.start();
    r.userEdits();
    const s = await p.resume();
    expect(s.undoSteps).toBe(2);
  });

  test("an inserted stop halts with its message and invokes nothing; Continue goes on after it", async () => {
    const r = rig();
    const p = new ActionPlayer(
      action([step("a"), stopStep("Check the crop"), step("b")]),
      r.deps,
    );
    let s = await p.start();
    expect(s.status).toBe("stopped");
    expect(s.message).toBe("Check the crop");
    expect(s.pausedAt).toBe(2);
    expect(r.invoked).toEqual(["a"]);
    s = await p.resume();
    expect(s.status).toBe("done");
    expect(r.invoked).toEqual(["a", "b"]);
  });

  test("step-by-step runs one step per Step", async () => {
    const r = rig();
    const p = new ActionPlayer(
      action([step("a"), step("b"), step("c")]),
      r.deps,
      {
        stepByStep: true,
      },
    );
    let s = await p.start();
    expect(s.status).toBe("paused");
    expect(r.invoked).toEqual(["a"]);
    s = await p.step();
    expect(r.invoked).toEqual(["a", "b"]);
    expect(s.pausedAt).toBe(2);
    s = await p.step();
    expect(s.status).toBe("done");
    expect(r.invoked).toEqual(["a", "b", "c"]);
    expect(s.undoSteps).toBe(1);
  });

  test("Cancel at a pause ends playback where it stands", async () => {
    const r = rig();
    const p = new ActionPlayer(
      action([step("a"), step("b", { pause: true })]),
      r.deps,
    );
    await p.start();
    const s = p.cancel();
    expect(s.status).toBe("cancelled");
    expect(r.invoked).toEqual(["a"]);
    expect((await p.resume()).status).toBe("cancelled");
  });

  test("a batch passes stops and breakpoints by and logs the stops", async () => {
    const r = rig();
    const p = new ActionPlayer(
      action([step("a", { pause: true }), stopStep("Look"), step("b")]),
      r.deps,
      { ignoreStops: true, ignorePauses: true },
    );
    const s = await p.start();
    expect(s.status).toBe("done");
    expect(r.invoked).toEqual(["a", "b"]);
    expect(s.ran.filter((x) => x.passedStop).map((x) => x.title)).toEqual([
      "Look",
    ]);
  });

  test("disabled and document-bound steps are skipped, as the plan says", async () => {
    const r = rig();
    const s = await new ActionPlayer(
      action([
        step("a", { disabled: true }),
        step("b", { verdict: "documentBound", payload: { id: "u1a2b" } }),
        step("c"),
      ]),
      r.deps,
    ).start();
    expect(r.invoked).toEqual(["c"]);
    expect(s.skipped.map((x) => x.reason)).toEqual([
      "disabled",
      "documentBound",
    ]);
  });
});
