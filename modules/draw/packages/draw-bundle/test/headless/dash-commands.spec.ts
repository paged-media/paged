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

// B-12 — stroke DASH editing. The preset COMMANDS (Solid / Dashed /
// Dotted / Dash-dot) are the host's, `paged.stroke.dash*` (PM-0017); what
// stays here is the builder the dash EDITOR writes through. This asserts
// (1) the exact wire shape `dashMutationFor` emits (an empty run clears to
// solid, the rest are alternating on/off pt runs), and (2) the engine
// accepts each run on a selected stroked element, with the editor's command
// still recorded.

import { describe, expect, it, beforeAll, afterAll } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle, dashMutationFor } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

// The fixture's closed rectangle leaf (a stroked frame).
const RECT = { kind: "rectangle", id: "urect" } as unknown as ElementId;

/** The four preset runs the host's commands write. */
const RUNS: Array<[string, number[]]> = [
  ["solid", []],
  ["dashed", [6, 3]],
  ["dotted", [1, 3]],
  ["dash-dot", [6, 3, 1, 3]],
];

describe("draw conformance — the dash editor's builder (B-12)", () => {
  describe("dashMutationFor — the exact wire shape", () => {
    for (const [name, lengths] of RUNS) {
      it(`${name} → setElementProperty{ frameStrokeDashArray, lengths:[${lengths.join(",")}] }`, () => {
        const m = dashMutationFor(RECT, lengths) as Extract<
          Mutation,
          { op: "setElementProperty" }
        >;
        expect(m.op).toBe("setElementProperty");
        expect(m.args.elementId).toBe(RECT);
        expect(m.args.path).toBe("frameStrokeDashArray");
        expect(m.args.value).toEqual({ type: "lengths", value: lengths });
      });
    }
  });

  describe("against the real engine", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("the bundle records the dash EDITOR's command and none of the presets", () => {
      const ids = h.contributions
        .filter((c) => c.kind === "command")
        .map((c) => c.id)
        .filter((id) => id.includes("strokeDash"));
      // The "…" command (Draw ▸ Stroke ▸ Dashes…) raises the Path Options
      // panel at its Stroke dashes section and writes nothing itself
      // (pinned in `panels/dash-editor.dom.test.tsx`).
      expect(ids).toEqual(["media.paged.draw.command.strokeDashOptions"]);
    });

    it("the engine accepts each run on a stroked element", async () => {
      for (const [name, lengths] of RUNS) {
        const outcome = await h.host.document.mutate(
          dashMutationFor(RECT, lengths),
        );
        expect(outcome.applied, name).toBe(true);
      }
    });
  });
});
