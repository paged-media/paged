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

// The interaction coordinator at the unit layer (the interaction
// specification's §23.2: owner precedence, state transitions): one owner
// per pointer sequence, legal edges only, a session ends exactly once,
// terminal events end everything, and a late answer is recognised.

import { describe, expect, test } from "bun:test";

import {
  createInteractionCoordinator,
  STALE,
} from "../../src/interaction/coordinator";
import {
  INTERACTION_OWNERS,
  ownerOfTool,
  ownerRank,
} from "../../src/interaction/owners";

const coordinator = () => createInteractionCoordinator({ trace: true });

describe("sessions", () => {
  test("one owner holds the pointer; a second claim of the same rank is refused (UXI-INV-001)", () => {
    const c = coordinator();
    const a = c.begin({ owner: "canvas-select", pointerId: 1 });
    expect(a).not.toBeNull();
    expect(c.begin({ owner: "canvas-camera", pointerId: 2 })).toBeNull();
    expect(c.current()).toBe(a);
    expect(c.trace.entries().some((e) => e.event === "refused")).toBe(true);
  });

  test("a higher-ranked owner (§3.4) takes the pointer and the holder is rolled back", () => {
    const c = coordinator();
    const rolled: string[] = [];
    const a = c.begin({
      owner: "canvas-select",
      onAbort: (why) => rolled.push(why),
    })!;
    const m = c.begin({ owner: "modal" });
    expect(m).not.toBeNull();
    expect(a.ended).toBe(true);
    expect(a.result).toBe("abort");
    expect(rolled).toEqual(["preempted by modal"]);
  });

  test("a pinch preempts an uncommitted press explicitly (UXI-CAM-012)", () => {
    const c = coordinator();
    const press = c.begin({ owner: "canvas-select", phase: "pending-hit" })!;
    const pinch = c.begin({ owner: "canvas-camera", preempt: true });
    expect(pinch).not.toBeNull();
    expect(press.signal.aborted).toBe(true);
  });

  test("only the legal edges of §3.3 move a session (UXI-STATE-002)", () => {
    const c = coordinator();
    const s = c.begin({ owner: "canvas-transform", mutating: true })!;
    expect(c.transition(s, "committing")).toBe(false);
    expect(c.transition(s, "previewing")).toBe(true);
    expect(c.transition(s, "committing")).toBe(true);
    expect(c.transition(s, "pressed")).toBe(false);
    expect(
      c.trace.entries().filter((e) => e.event === "illegal-transition"),
    ).toHaveLength(2);
  });

  test("a session ends exactly once (UXI-INV-002, UXI-GST-007)", () => {
    const c = coordinator();
    let aborted = 0;
    const s = c.begin({ owner: "canvas-draw", onAbort: () => aborted++ })!;
    expect(c.end(s, "commit")).toBe(true);
    expect(c.end(s, "cancel")).toBe(false);
    expect(c.cancel(s, "blur")).toBe(false);
    expect(aborted).toBe(0);
    expect(s.result).toBe("commit");
    expect(c.isIdle()).toBe(true);
  });

  test("a committing session lets the pointer go: the next press begins beside it", () => {
    const c = coordinator();
    const s = c.begin({ owner: "canvas-transform", mutating: true })!;
    c.transition(s, "previewing");
    c.transition(s, "committing");
    expect(c.current()).toBeNull();
    const next = c.begin({ owner: "canvas-select" });
    expect(next).not.toBeNull();
    expect(c.sessions()).toHaveLength(2);
  });

  test("abortAll rolls every open session back once, the committing ones too", () => {
    const c = coordinator();
    const why: string[] = [];
    const a = c.begin({
      owner: "canvas-transform",
      onAbort: (r) => why.push(`a:${r}`),
    })!;
    c.transition(a, "previewing");
    c.transition(a, "committing");
    c.begin({ owner: "canvas-select", onAbort: (r) => why.push(`b:${r}`) });
    expect(c.abortAll("blur")).toBe(2);
    expect(why).toEqual(["a:blur", "b:blur"]);
    expect(c.abortAll("blur")).toBe(0);
    expect(c.isIdle()).toBe(true);
  });

  test("whenIdle waits for the last session", async () => {
    const c = coordinator();
    const s = c.begin({ owner: "canvas-draw", mutating: true })!;
    expect(c.mutatingActive()).toBe(true);
    let idle = false;
    const done = c.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    c.end(s, "commit");
    await done;
    expect(idle).toBe(true);
  });
});

describe("epochs and guards", () => {
  test("a new press makes an earlier press's answer stale (UXI-OWN-008, T57)", async () => {
    const c = coordinator();
    const a = c.begin({ owner: "canvas-select" })!;
    c.end(a, "commit");
    const tokenA = c.token("hit-test");
    const b = c.begin({ owner: "canvas-select" })!;
    c.end(b, "commit");
    const tokenB = c.token("hit-test");
    expect(await c.guard(tokenA, Promise.resolve("A"))).toBe(STALE);
    expect(await c.guard(tokenB, Promise.resolve("B"))).toBe("B");
    expect(
      c.trace
        .entries()
        .some((e) => e.event === "stale" && e.reason?.includes("hit-test")),
    ).toBe(true);
  });

  test("a document switch aborts first and voids every older answer (UXI-INV-015, T59)", async () => {
    const c = coordinator();
    let rolled = "";
    c.begin({ owner: "canvas-transform", onAbort: (r) => (rolled = r) });
    const token = c.token("begin-gesture");
    c.documentChanged("document-open");
    expect(rolled).toBe("document-open");
    expect(c.isCurrent(token)).toBe(false);
    expect(await c.guard(token, Promise.resolve(1))).toBe(STALE);
  });

  test("a token tied to a session goes stale when the session is aborted", () => {
    const c = coordinator();
    const s = c.begin({ owner: "canvas-select", phase: "pending-hit" })!;
    const t = c.token("press-hit", s);
    expect(c.isCurrent(t)).toBe(true);
    c.cancel(s, "escape", "cancel");
    expect(s.result).toBe("cancel");
    expect(c.isCurrent(t)).toBe(false);
  });

  test("the camera moving voids nothing by itself", () => {
    const c = coordinator();
    const t = c.token("context-menu");
    c.cameraChanged();
    expect(c.isCurrent(t)).toBe(true);
    c.contextChanged("enter");
    expect(c.isCurrent(t)).toBe(false);
  });

  test("the snapshot is immutable and replaced on change", () => {
    const c = coordinator();
    const idle = c.snapshot();
    expect(idle.active).toBeNull();
    expect(c.snapshot()).toBe(idle);
    const s = c.begin({ owner: "canvas-draw", toolId: "paged.tool.pen" })!;
    const busy = c.snapshot();
    expect(busy).not.toBe(idle);
    expect(busy.active?.owner).toBe("canvas-draw");
    c.end(s, "commit");
    expect(c.snapshot().active).toBeNull();
  });
});

describe("the trace", () => {
  test("records ids, owners and phases and no free text field", () => {
    const c = coordinator();
    const s = c.begin({
      owner: "canvas-draw",
      toolId: "paged.tool.rectangle",
      pointerType: "mouse",
    })!;
    c.transition(s, "previewing");
    c.end(s, "cancel", "escape");
    const keys = new Set(c.trace.entries().flatMap((e) => Object.keys(e)));
    for (const k of keys)
      expect([
        "t",
        "event",
        "id",
        "owner",
        "tool",
        "phase",
        "pointerType",
        "result",
        "reason",
        "doc",
        "latencyMs",
      ]).toContain(k);
    const end = c.trace.entries().at(-1)!;
    expect(end).toMatchObject({
      event: "end",
      result: "cancel",
      reason: "escape",
    });
  });

  test("a production coordinator records nothing", () => {
    const c = createInteractionCoordinator({ trace: false });
    c.end(c.begin({ owner: "canvas-select" })!, "commit");
    expect(c.trace.entries()).toHaveLength(0);
  });
});

describe("owners", () => {
  test("the spec's twelve owners, ranked by §3.4", () => {
    expect(INTERACTION_OWNERS).toHaveLength(12);
    expect(ownerRank("modal")).toBeLessThan(ownerRank("canvas-transform"));
    expect(ownerRank("canvas-transform")).toBeLessThan(
      ownerRank("frame-content"),
    );
    expect(ownerRank("frame-content")).toBeLessThan(ownerRank("canvas-draw"));
    expect(ownerRank("canvas-draw")).toBeLessThan(ownerRank("canvas-select"));
  });

  test("a tool's gesture has the inventory's owner", () => {
    expect(ownerOfTool("paged.tool.rectangle")).toBe("canvas-draw");
    expect(ownerOfTool("paged.tool.rotate")).toBe("canvas-transform");
    expect(ownerOfTool("paged.tool.scissors")).toBe("canvas-path");
  });
});
