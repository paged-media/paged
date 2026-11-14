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

// Operation feedback (editor ADR "Operation feedback"; UXI-FBK-001/002,
// UXI-ASY-009/010/011): the outcome taxonomy, the worded error (action,
// reason, whether the document changed, remedy), one channel per kind and
// no toast storm for a repeated failure.

import { describe, expect, test } from "bun:test";

import {
  createOperationFeedback,
  MAX_TOASTS,
  OPERATION_OUTCOMES,
  routeOf,
  severityOf,
  wordFeedback,
  type OperationReport,
} from "../../src/state/operation-feedback";

const move: OperationReport = {
  action: "move 2 objects",
  outcome: "blocked",
  reason: "their layer is locked.",
  document: "unchanged",
  remedy: { label: "Unlock layer", command: "paged.layers.unlock" },
};

describe("the outcome taxonomy (UXI-ASY-009)", () => {
  test("eight outcomes, each with a severity", () => {
    expect(OPERATION_OUTCOMES).toEqual([
      "success",
      "canceled",
      "blocked",
      "unsupported",
      "invalid-input",
      "conflict",
      "recoverable-failure",
      "fatal-failure",
    ]);
    expect(OPERATION_OUTCOMES.map(severityOf)).toEqual([
      "info",
      "info",
      "warning",
      "warning",
      "warning",
      "warning",
      "error",
      "error",
    ]);
  });
});

describe("an error says what, why, whether anything changed, and what next (UXI-FBK-002)", () => {
  test("the specification's example", () => {
    expect(wordFeedback(move).sentence).toBe(
      "Could not move 2 objects: their layer is locked. Nothing changed. Unlock layer.",
    );
  });
  test("a changed document says so; an unknown one says nothing", () => {
    expect(
      wordFeedback({
        ...move,
        outcome: "recoverable-failure",
        document: "changed",
      }).change,
    ).toBe("The document changed.");
    expect(wordFeedback({ ...move, document: undefined }).change).toBe("");
  });
  test("every outcome has its own wording", () => {
    const words = OPERATION_OUTCOMES.map(
      (outcome) =>
        wordFeedback({ action: "paste", outcome, reason: "why" }).headline,
    );
    expect(words).toEqual([
      "Paste: done.",
      "Paste canceled.",
      "Could not paste: why.",
      "Cannot paste: why.",
      "Could not paste: why.",
      "Could not paste: why.",
      "Could not paste: why.",
      "Paste failed: why.",
    ]);
    expect(
      wordFeedback({ action: "paste", outcome: "conflict" }).headline,
    ).toBe("Could not paste: the document changed meanwhile.");
  });
  test("a title replaces the headline (a success that names its result)", () => {
    expect(
      wordFeedback({
        action: "export",
        outcome: "success",
        title: "Exported Annual.pdf · 12 pages",
      }).headline,
    ).toBe("Exported Annual.pdf · 12 pages");
  });
});

describe("one place per kind (UXI-FBK-001, UXI-ASY-010)", () => {
  test("routes", () => {
    expect(routeOf({ action: "a", outcome: "success" })).toEqual({
      toast: false,
      problem: false,
    });
    expect(
      routeOf({ action: "a", outcome: "success", prominent: true }),
    ).toEqual({ toast: true, problem: false });
    expect(routeOf(move)).toEqual({ toast: true, problem: false });
    expect(routeOf({ ...move, persistent: true })).toEqual({
      toast: true,
      problem: true,
    });
    expect(routeOf({ action: "a", outcome: "fatal-failure" })).toEqual({
      toast: true,
      problem: true,
    });
    expect(routeOf({ ...move, channel: "inline" })).toEqual({
      toast: false,
      problem: false,
    });
    expect(routeOf({ ...move, channel: "problem" })).toEqual({
      toast: false,
      problem: true,
    });
  });

  test("a repeated failure updates its toast instead of stacking another", () => {
    const fb = createOperationFeedback(() => 1000);
    for (let i = 0; i < 20; i++) fb.report(move);
    const { toasts } = fb.snapshot();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.count).toBe(20);
  });

  test("at most three toasts; the oldest leaves", () => {
    const fb = createOperationFeedback(() => 0);
    for (let i = 0; i < 5; i++)
      fb.report({ action: `step ${i}`, outcome: "blocked" });
    const { toasts } = fb.snapshot();
    expect(toasts).toHaveLength(MAX_TOASTS);
    expect(toasts.map((x) => x.report.action)).toEqual([
      "step 2",
      "step 3",
      "step 4",
    ]);
  });

  test("a fatal failure stays until closed; others expire", () => {
    const fb = createOperationFeedback(() => 100);
    fb.report({ action: "a", outcome: "fatal-failure" });
    fb.report({ action: "b", outcome: "blocked" });
    fb.report({ action: "c", outcome: "success", prominent: true });
    const [fatal, blocked, success] = fb.snapshot().toasts;
    expect(fatal!.expiresAt).toBeNull();
    expect(blocked!.expiresAt).toBe(8100);
    expect(success!.expiresAt).toBe(4100);
    fb.dismissToast(fatal!.id);
    expect(fb.snapshot().toasts).toHaveLength(2);
  });

  test("a problem stays until resolved; a success with its key resolves it", () => {
    const fb = createOperationFeedback();
    fb.report({ ...move, key: "k", persistent: true });
    expect(fb.snapshot().problems.map((p) => p.key)).toEqual(["k"]);
    fb.report({ ...move, key: "k", persistent: true });
    expect(fb.snapshot().problems).toHaveLength(1);
    fb.report({ action: "move 2 objects", outcome: "success", key: "k" });
    expect(fb.snapshot().problems).toEqual([]);
    fb.report({ ...move, key: "j", channel: "problem" });
    fb.resolve("j");
    expect(fb.snapshot().problems).toEqual([]);
  });

  test("a remedy runs its command through the editor", () => {
    const fb = createOperationFeedback();
    const ran: string[] = [];
    fb.setCommandRunner((id) => ran.push(id));
    fb.runAction(move.remedy!);
    expect(ran).toEqual(["paged.layers.unlock"]);
  });
});
