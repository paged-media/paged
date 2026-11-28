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

// Actions — the recording model (`actions/model.ts`): the classifier
// that decides whether a replay is honest, the replay plan, and the
// projections and persistence. The command tap is proven in the browser
// by the canvas app's `tests/actions.spec.ts`.

import { describe, expect, test } from "bun:test";

import {
  classifyPayload,
  looksLikeDocumentId,
  planReplay,
  toDemoScript,
  parseLibrary,
  ACTIONS_SCHEMA_VERSION,
  type ActionStep,
  type PagedAction,
} from "../../src/actions/model";

const step = (over: Partial<ActionStep> = {}): ActionStep => ({
  command: "paged.object.group",
  title: "Group",
  verdict: "contextual",
  ...over,
});

const action = (
  steps: ActionStep[],
  over: Partial<PagedAction> = {},
): PagedAction => ({
  id: "a1",
  name: "Test",
  createdAt: 0,
  steps,
  uncaptured: { gestures: 0, directEdits: 0 },
  includeDocumentBound: false,
  ...over,
});

describe("Actions — payload classification (pure)", () => {
  test("AC-ACT-1 — no payload is contextual: it replays against the replay-time selection @feat:editor-shell.panels.actions @level:happy", () => {
    expect(classifyPayload(undefined)).toEqual({ verdict: "contextual" });
  });

  test("AC-ACT-2 — a plain payload is portable and is CLONED off the caller @feat:editor-shell.panels.actions @level:happy", () => {
    const payload = { amount: 12, unit: "pt" };
    const out = classifyPayload(payload);
    expect(out.verdict).toBe("portable");
    // The recorder must not hold the caller's object: a panel that
    // reuses one payload object across invocations would otherwise
    // rewrite history.
    expect(out.payload).not.toBe(payload);
    expect(out.payload).toEqual(payload);
  });

  test("AC-ACT-3 — an ElementId anywhere in the payload makes the step document-bound @feat:editor-shell.panels.actions @level:edge", () => {
    expect(classifyPayload({ kind: "rectangle", id: "ua365e1" }).verdict).toBe(
      "documentBound",
    );
    // Nested, and behind an array — the walk has to find it.
    expect(
      classifyPayload({ targets: [{ kind: "group", id: "u1" }] }).verdict,
    ).toBe("documentBound");
  });

  test("AC-ACT-4 — engine self-id STRINGS are document-bound; ordinary words are not @feat:editor-shell.panels.actions @level:edge", () => {
    // The three shapes that actually appear on the wire.
    expect(looksLikeDocumentId("u0f396d")).toBe(true); // PageId
    expect(looksLikeDocumentId("textFrame:ua365e1")).toBe(true);
    expect(looksLikeDocumentId("Color/uPagedSheetChart3366CC")).toBe(true);
    // Named library entries travel between documents — not ids.
    expect(looksLikeDocumentId("Color/Black")).toBe(false);
    expect(looksLikeDocumentId("Swatch/None")).toBe(false);
    // The heuristic's digit requirement is what keeps vocabulary out.
    // Without it, every one of these would be flagged.
    expect(looksLikeDocumentId("underline")).toBe(false);
    expect(looksLikeDocumentId("uppercase")).toBe(false);
    expect(looksLikeDocumentId("paged.properties")).toBe(false);
    expect(looksLikeDocumentId(42)).toBe(false);
  });

  test("AC-ACT-5 — an unserializable payload is recorded as unreplayable, not dropped @feat:editor-shell.panels.actions @level:edge", () => {
    expect(classifyPayload(() => {}).verdict).toBe("unserializable");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(classifyPayload(cycle).verdict).toBe("unserializable");
  });
});

describe("Actions — replay plan (pure)", () => {
  test("AC-ACT-6 — document-bound steps are skipped by default and named @feat:editor-shell.panels.actions @level:happy", () => {
    const plan = planReplay(
      action([
        step(),
        step({
          verdict: "documentBound",
          payload: { kind: "group", id: "u1" },
        }),
      ]),
    );
    expect(plan.run.map((p) => p.index)).toEqual([0]);
    expect(plan.skip).toHaveLength(1);
    expect(plan.skip[0].reason).toBe("documentBound");
  });

  test("AC-ACT-7 — the opt-in runs them @feat:editor-shell.panels.actions @level:edge", () => {
    const plan = planReplay(
      action(
        [
          step({
            verdict: "documentBound",
            payload: { kind: "group", id: "u1" },
          }),
        ],
        { includeDocumentBound: true },
      ),
    );
    expect(plan.run).toHaveLength(1);
    expect(plan.skip).toHaveLength(0);
  });

  test("AC-ACT-8 — disabled, failed and unserializable steps never replay @feat:editor-shell.panels.actions @level:edge", () => {
    const plan = planReplay(
      action([
        step({ disabled: true }),
        step({ failed: true }),
        step({ verdict: "unserializable" }),
      ]),
    );
    expect(plan.run).toHaveLength(0);
    expect(plan.skip.map((s) => s.reason)).toEqual([
      "disabled",
      "failedWhileRecording",
      "unserializable",
    ]);
  });
});

describe("Actions — projections + persistence (pure)", () => {
  test("AC-ACT-9 — an action projects onto the shipped automation surface @feat:editor-shell.panels.actions @level:happy", () => {
    // `editor.runCommand` is the demo/automation layer's real entry
    // point (packages/shell/src/demo/automation.ts), so the emitted
    // script is executable, not illustrative.
    const src = toDemoScript(
      action([
        step(),
        step({ command: "paged.view.zoomFit", title: "Fit document" }),
      ]),
    );
    expect(src).toContain('await editor.runCommand("paged.object.group");');
    expect(src).toContain('await editor.runCommand("paged.view.zoomFit");');
  });

  test("AC-ACT-10 — the script states what the recording could not capture @feat:editor-shell.panels.actions @level:edge", () => {
    const src = toDemoScript(
      action([step()], { uncaptured: { gestures: 3, directEdits: 5 } }),
    );
    expect(src).toContain("3 canvas gesture(s)");
    expect(src).toContain("5 direct edit(s)");
  });

  test("AC-ACT-11 — a malformed stored library is DROPPED, never repaired @feat:editor-shell.panels.actions @level:edge", () => {
    expect(parseLibrary({ schema: 999, actions: [] }).actions).toEqual([]);
    expect(parseLibrary(null).actions).toEqual([]);
    expect(
      parseLibrary({
        schema: ACTIONS_SCHEMA_VERSION,
        // A half-understood action would replay something nobody
        // recorded, so an unknown verdict disqualifies the whole entry.
        actions: [{ ...action([step({ verdict: "bogus" as never })]) }],
      }).actions,
    ).toEqual([]);
    expect(
      parseLibrary({
        schema: ACTIONS_SCHEMA_VERSION,
        actions: [action([step()])],
      }).actions,
    ).toHaveLength(1);
  });
});
