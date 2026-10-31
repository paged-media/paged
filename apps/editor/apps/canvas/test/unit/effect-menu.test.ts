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

// Editor ADR 309 — Object ▸ Effects ▸ <group> ▸ <effect>: rows from core's
// catalog; a row appends the effect to every selected object stack that
// takes it, in ONE batch (one undo step).

import { describe, expect, test } from "bun:test";
import { CORE_EFFECT_KINDS } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import {
  EFFECT_COMMAND_PREFIX,
  buildEffectMenuCommands,
  buildEffectMenuItems,
  planAddEffect,
} from "../../src/effect-menu";
import { withFutureKind } from "./support/future-effect-kind";

describe("Effect menu [editor-shell.panels.appearance-transparency]", () => {
  test("one row and one command per kind core describes, under its group", () => {
    // The family: one command per core effect kind (each checked below).
    covers("command:paged.effect.add.*");
    const items = buildEffectMenuItems();
    const commands = buildEffectMenuCommands();
    expect(items.length).toBe(CORE_EFFECT_KINDS.length);
    expect(commands.map((c) => c.id).sort()).toEqual(
      CORE_EFFECT_KINDS.map((k) => `${EFFECT_COMMAND_PREFIX}${k.kind}`).sort(),
    );
    const paths = items.map((i) => i.path);
    expect(paths).toContain("Object/Effects/Stylize/Drop shadow");
    expect(paths).toContain("Object/Effects/Blur/Gaussian blur");
    expect(paths).toContain("Object/Effects/Noise/Add noise");
    expect(paths).toContain("Object/Effects/Color/Color adjustment");
    for (const item of items) {
      expect(item.path.startsWith("Object/Effects/")).toBe(true);
      expect(item.group).toBe("effect-kinds");
    }
  });

  test("a kind core adds later gets its row (plan C16)", () => {
    withFutureKind(() => {
      expect(buildEffectMenuItems().map((i) => i.path)).toContain(
        "Object/Effects/Distort & Transform/Crystallize",
      );
    });
  });

  test("the rows apply wherever something is selected, in any edit context", () => {
    const cmd = buildEffectMenuCommands()[0]!;
    const when = cmd.when as (s: unknown) => boolean;
    expect(when({ selection: { elementSelection: [] } })).toBe(false);
    expect(
      when({
        selection: { elementSelection: [{ kind: "rectangle", id: "r" }] },
        editContext: { type: "wordDocument" },
      }),
    ).toBe(true);
  });

  test("the plan appends to every stack that takes the kind, as one batch", () => {
    covers("command:paged.effect.add.gaussianBlur");
    const plan = planAddEffect(
      [
        { address: "rectangle:a", entries: [] },
        { address: "oval:b", entries: [{ kind: "noise", enabled: true }] },
      ],
      "gaussianBlur",
    );
    expect(plan).toEqual({
      op: "batch",
      args: {
        ops: [
          {
            op: "set",
            args: {
              address: "rectangle:a",
              path: "frameEffectStack",
              value: {
                type: "effectStack",
                value: { entries: [{ kind: "gaussianBlur", enabled: true }] },
              },
            },
          },
          {
            op: "set",
            args: {
              address: "oval:b",
              path: "frameEffectStack",
              value: {
                type: "effectStack",
                value: {
                  entries: [
                    { kind: "noise", enabled: true },
                    { kind: "gaussianBlur", enabled: true },
                  ],
                },
              },
            },
          },
        ],
      },
    });
  });

  test("an InDesign effect a stack already holds is not added twice", () => {
    expect(
      planAddEffect(
        [
          {
            address: "rectangle:a",
            entries: [{ kind: "satin", enabled: true }],
          },
        ],
        "satin",
      ),
    ).toBeNull();
  });
});
