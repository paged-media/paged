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

// THE PATH, STROKE AND FILL COMMANDS against the real engine (the kit's
// contract, `command-kit.ts`): each one changes the model as ONE undo step
// that undoes and redoes exactly, and leaves the model alone where it
// does not apply. The domain assertions (which anchors, which property
// values) live beside each command's own spec in this directory; this
// file is the uniform contract every command is held to.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { F1_MULTI_SHAPE, F3_CURVED_OPEN, F4_OVERLAP } from "../fixtures/corpus";
import {
  brokenInvariant,
  commandRig,
  el,
  expectApplies,
  expectRefuses,
  undoStepsOf,
  type CommandRig,
} from "./command-kit";

const C = "media.paged.draw.command";
const RECT = el("rectangle", "urect");
const POLY = el("polygon", "upoly");
const LINE = el("graphicLine", "uline");
const CURVE = el("polygon", "ucurve");
const QUAD_A = el("polygon", "ua");
const QUAD_B = el("polygon", "ub");
const F1 = () => F1_MULTI_SHAPE.bytes();

describe("paged.draw commands — path, stroke and fill (real engine)", () => {
  let rig: CommandRig;
  beforeAll(async () => {
    rig = await commandRig();
  }, 60_000);
  afterAll(() => rig?.dispose());

  describe("stroke dashes", () => {
    it("Stroke: Solid clears the dash array; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.strokeDashSolid");
      await rig.open(F1(), [RECT]);
      await rig.run(`${C}.strokeDashDashed`);
      await expectApplies(rig, `${C}.strokeDashSolid`);
      await expectRefuses(rig, F1(), [], `${C}.strokeDashSolid`);
    });

    it("Stroke: Dashed sets a 6/3 dash; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.strokeDashDashed");
      await rig.open(F1(), [RECT]);
      const { after } = await expectApplies(rig, `${C}.strokeDashDashed`);
      expect(after).toContain('"frameStrokeDashArray"');
      await expectRefuses(rig, F1(), [], `${C}.strokeDashDashed`);
    });

    it("Stroke: Dotted sets a 1/3 dash; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.strokeDashDotted");
      await rig.open(F1(), [RECT]);
      await expectApplies(rig, `${C}.strokeDashDotted`);
      await expectRefuses(rig, F1(), [], `${C}.strokeDashDotted`);
    });

    it("Stroke: Dash-dot sets a 6/3/1/3 dash; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.strokeDashDashDot");
      await rig.open(F1(), [RECT]);
      await expectApplies(rig, `${C}.strokeDashDashDot`);
      await expectRefuses(rig, F1(), [], `${C}.strokeDashDashDot`);
    });
  });

  describe("gradient fills", () => {
    it("Fill: Linear gradient refuses an empty selection", async () => {
      covers("command:media.paged.draw.command.fillGradientLinear");
      await expectRefuses(rig, F1(), [], `${C}.fillGradientLinear`);
    });

    it.failing(
      "DRW-1 — Fill: Linear gradient is ONE undo step (it is four: swatches, gradient, fill)",
      async () => {
        covers("command:media.paged.draw.command.fillGradientLinear");
        await rig.open(F1(), [RECT]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.fillGradientLinear`),
        );
      },
    );

    it("Fill: Radial gradient refuses an empty selection", async () => {
      covers("command:media.paged.draw.command.fillGradientRadial");
      await expectRefuses(rig, F1(), [], `${C}.fillGradientRadial`);
    });

    it.failing(
      "DRW-1 — Fill: Radial gradient is ONE undo step (it is four)",
      async () => {
        covers("command:media.paged.draw.command.fillGradientRadial");
        await rig.open(F1(), [RECT]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.fillGradientRadial`),
        );
      },
    );

    it("DRW-1, measured: a gradient preset takes four undo steps to take back", async () => {
      covers("command:media.paged.draw.command.fillGradientLinear");
      await rig.open(F1(), [RECT]);
      expect(
        await undoStepsOf(rig, () => rig.run(`${C}.fillGradientLinear`)),
      ).toBe(4);
    });
  });

  describe("path operations", () => {
    it("Outline stroke turns the selected path's stroke into a filled outline; an empty selection is a no-op", async () => {
      covers("command:media.paged.draw.command.outlineStroke");
      await rig.open(F1(), [POLY]);
      await expectApplies(rig, `${C}.outlineStroke`);
      await expectRefuses(rig, F1(), [], `${C}.outlineStroke`);
    });

    it("Offset path offsets the selected closed path; an empty selection is a no-op", async () => {
      covers("command:media.paged.draw.command.offsetPath");
      await rig.open(F4_OVERLAP.bytes(), [QUAD_A]);
      await expectApplies(rig, `${C}.offsetPath`, { delta: 6 });
      await expectRefuses(rig, F1(), [], `${C}.offsetPath`);
    });

    it("Simplify path simplifies the selected curve; an empty selection is a no-op", async () => {
      covers("command:media.paged.draw.command.simplifyPath");
      // F1's open polygon bows 200 pt off its chord; a 250 pt tolerance
      // drops the middle anchor.
      await rig.open(F1(), [POLY]);
      await expectApplies(rig, `${C}.simplifyPath`, { tolerance: 250 });
      await expectRefuses(rig, F1(), [], `${C}.simplifyPath`);
    });

    it("Join endpoints welds two open paths into one; a closed rectangle is refused", async () => {
      covers("command:media.paged.draw.command.joinEndpoints");
      await rig.open(F1(), [POLY, LINE]);
      await expectApplies(rig, `${C}.joinEndpoints`);
      await expectRefuses(rig, F1(), [RECT], `${C}.joinEndpoints`);
    });

    it("Close path closes the selected open path; a closed rectangle is refused", async () => {
      covers("command:media.paged.draw.command.closePath");
      await rig.open(F1(), [POLY]);
      await expectApplies(rig, `${C}.closePath`);
      await expectRefuses(rig, F1(), [RECT], `${C}.closePath`);
    });

    it("Average endpoints moves the open path's two ends to their midpoint; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.averageEndpoints");
      await rig.open(F1(), [POLY]);
      await expectApplies(rig, `${C}.averageEndpoints`);
      await expectRefuses(rig, F1(), [], `${C}.averageEndpoints`);
    });

    it("Reverse path direction reverses the anchor order; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.reversePathDirection");
      await rig.open(F3_CURVED_OPEN.bytes(), [CURVE]);
      await expectApplies(rig, `${C}.reversePathDirection`);
      await expectRefuses(rig, F1(), [], `${C}.reversePathDirection`);
    });
  });

  describe("live corners", () => {
    // DRW-2: a corner preset is two undo steps — the corner geometry
    // batch, then the live-corner marker in the plugin metadata — so one
    // undo leaves the corners rounded and the marker gone.
    it("Corners: Rounded refuses a graphic line (no corners to round)", async () => {
      covers("command:media.paged.draw.command.cornersRounded");
      await expectRefuses(rig, F1(), [LINE], `${C}.cornersRounded`);
    });

    it.failing(
      "DRW-2 — Corners: Rounded is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.cornersRounded");
        await rig.open(F1(), [RECT]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.cornersRounded`),
        );
      },
    );

    it("Corners: Inverse rounded refuses a graphic line", async () => {
      covers("command:media.paged.draw.command.cornersInverseRounded");
      await expectRefuses(rig, F1(), [LINE], `${C}.cornersInverseRounded`);
    });

    it.failing(
      "DRW-2 — Corners: Inverse rounded is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.cornersInverseRounded");
        await rig.open(F1(), [RECT]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.cornersInverseRounded`),
        );
      },
    );

    it("Corners: Bevel refuses a graphic line", async () => {
      covers("command:media.paged.draw.command.cornersBevel");
      await expectRefuses(rig, F1(), [LINE], `${C}.cornersBevel`);
    });

    it.failing(
      "DRW-2 — Corners: Bevel is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.cornersBevel");
        await rig.open(F1(), [RECT]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.cornersBevel`),
        );
      },
    );

    it("Corners: Fancy refuses a graphic line", async () => {
      covers("command:media.paged.draw.command.cornersFancy");
      await expectRefuses(rig, F1(), [LINE], `${C}.cornersFancy`);
    });

    it.failing(
      "DRW-2 — Corners: Fancy is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.cornersFancy");
        await rig.open(F1(), [RECT]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.cornersFancy`),
        );
      },
    );

    it("Corners: None refuses a graphic line", async () => {
      covers("command:media.paged.draw.command.cornersNone");
      await expectRefuses(rig, F1(), [LINE], `${C}.cornersNone`);
    });

    it.failing(
      "DRW-2 — Corners: None is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.cornersNone");
        await rig.open(F1(), [RECT]);
        await rig.run(`${C}.cornersRounded`);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.cornersNone`),
        );
      },
    );

    it("DRW-2, measured: a corner preset takes two undo steps to take back", async () => {
      covers("command:media.paged.draw.command.cornersRounded");
      await rig.open(F1(), [RECT]);
      expect(await undoStepsOf(rig, () => rig.run(`${C}.cornersRounded`))).toBe(
        2,
      );
    });
  });

  describe("one undo step for the whole selection", () => {
    // DRW-3: these commands commit once PER SELECTED ELEMENT, so with two
    // elements selected one undo takes back only the second.
    const TWO = [RECT, POLY];

    it.failing(
      "DRW-3 — Stroke: Dashed on two elements is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.strokeDashDashed");
        await rig.open(F1(), TWO);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.strokeDashDashed`),
        );
      },
    );

    it.failing(
      "DRW-3 — Outline stroke on two paths is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.outlineStroke");
        await rig.open(F1(), TWO);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.outlineStroke`),
        );
      },
    );

    it.failing(
      "DRW-3 — Offset path on two paths is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.offsetPath");
        await rig.open(F4_OVERLAP.bytes(), [QUAD_A, QUAD_B]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.offsetPath`, { delta: 6 }),
        );
      },
    );

    it.failing(
      "DRW-3 — Simplify path on two paths is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.simplifyPath");
        await rig.open(F1(), TWO);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.simplifyPath`, { tolerance: 250 }),
        );
      },
    );

    it.failing(
      "DRW-3 — Close path on two open paths is ONE undo step (it is two)",
      async () => {
        covers("command:media.paged.draw.command.closePath");
        await rig.open(F1(), [POLY, LINE]);
        await brokenInvariant("INV-4", () =>
          expectApplies(rig, `${C}.closePath`),
        );
      },
    );

    it("Reflect, Reverse path and Average endpoints ARE one step for two elements", async () => {
      covers(
        "command:media.paged.draw.command.reflectHorizontal",
        "command:media.paged.draw.command.reversePathDirection",
        "command:media.paged.draw.command.averageEndpoints",
      );
      await rig.open(F1(), TWO);
      await expectApplies(rig, `${C}.reflectHorizontal`);
      await rig.open(F1(), TWO);
      await expectApplies(rig, `${C}.reversePathDirection`);
      await rig.open(F1(), [POLY, LINE]);
      await expectApplies(rig, `${C}.averageEndpoints`);
    });
  });

  describe("transforms", () => {
    it("Reflect horizontally mirrors the selection about its centre; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.reflectHorizontal");
      await rig.open(F1(), [POLY]);
      await expectApplies(rig, `${C}.reflectHorizontal`);
      await expectRefuses(rig, F1(), [], `${C}.reflectHorizontal`);
    });

    it("Reflect vertically mirrors the selection about its centre; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.reflectVertical");
      await rig.open(F1(), [POLY]);
      await expectApplies(rig, `${C}.reflectVertical`);
      await expectRefuses(rig, F1(), [], `${C}.reflectVertical`);
    });

    it("Transform again repeats the last reflection on the new selection; nothing selected is a no-op", async () => {
      covers("command:media.paged.draw.command.transformAgain");
      await rig.open(F1(), [POLY]);
      await rig.run(`${C}.reflectVertical`);
      await rig.h.host.selection.set([RECT]);
      await expectApplies(rig, `${C}.transformAgain`);
      await expectRefuses(rig, F1(), [], `${C}.transformAgain`);
    });
  });
});
