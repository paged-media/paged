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

// The manifest's `contributes.objectModel` IS the source rows (ADR 323
// rule 4): plugin-cli validates the manifest, the editor and cockpit's
// object matrix read it, and the runtime refuses a registration whose
// paths disagree with it. So it is GENERATED from src/object-model and
// this spec fails when the two drift. `UPDATE_OBJECT_MODEL=1 pnpm vitest
// run test/object-model-manifest.spec.ts` rewrites it.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateValue } from "@paged-media/plugin-sdk";

import {
  DRAW_OBJECT_KINDS,
  TWINS,
  drawObjectModelManifest,
  payloadFor,
} from "../src/object-model";
import { validSubpathStarts } from "../src/object-model/path-kind";

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), "../manifest.json");

describe("paged.draw object model — the manifest block", () => {
  it("contributes.objectModel is generated from src/object-model", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const want = drawObjectModelManifest();
    if (process.env.UPDATE_OBJECT_MODEL === "1") {
      manifest.contributes.objectModel = want;
      writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    expect(manifest.contributes.objectModel).toEqual(want);
  });

  it("every typed twin names an untyped command the manifest declares", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const untyped = new Set<string>(manifest.contributes.commands);
    for (const t of TWINS) expect(untyped.has(t.id), t.id).toBe(true);
    // The ten Path Options "…" commands raise a panel and mutate nothing:
    // the ONLY untyped remainder.
    const rest = [...untyped].filter((id) => !TWINS.some((t) => t.id === id));
    expect(rest.sort()).toEqual(
      [
        "insertArcOptions",
        "insertPolarGridOptions",
        "insertRectGridOptions",
        "insertSpiralOptions",
        "offsetPathOptions",
        "outlineStrokeOptions",
        "reflectOptions",
        "selectSameStrokeWeightOptions",
        "simplifyPathOptions",
        "strokeDashOptions",
      ].map((n) => `media.paged.draw.command.${n}`),
    );
  });

  it("ten kinds; every row's default (when given) is valid for its own type", () => {
    expect(DRAW_OBJECT_KINDS).toHaveLength(10);
    for (const k of DRAW_OBJECT_KINDS) {
      for (const row of k.schema) {
        if (row.default === undefined) continue;
        expect(validateValue(row.type, row.default, row), `${k.kind}.${row.path}`).toBeNull();
      }
    }
  });
});

describe("typed twins lower to the untyped payload", () => {
  const twin = (name: string) => TWINS.find((t) => t.id === `media.paged.draw.command.${name}`)!;

  it("targets never reach the payload; an empty recipe id means 'from the selection'", () => {
    expect(payloadFor(twin("updateRepeat"), { repeat: "" })).toBeUndefined();
    expect(payloadFor(twin("updateRepeat"), { repeat: "plugin:media.paged.draw/repeat/rep-2" })).toEqual({
      repeatId: "rep-2",
    });
    expect(payloadFor(twin("selectSameStrokeWeight"), { targets: ["polygon:u1"], tolerance: 0.5 })).toEqual({
      tolerance: 0.5,
    });
    expect(payloadFor(twin("strokeDashDashed"), { targets: [] })).toBeUndefined();
    expect(
      payloadFor(twin("applyGraphicStyle"), { targets: [], style: "gs-3" }),
    ).toEqual({ styleId: "gs-3" });
  });
});

describe("path contours", () => {
  it("validSubpathStarts — ascending, in range", () => {
    expect(validSubpathStarts([], 3)).toBe(true);
    expect(validSubpathStarts([0, 3], 5)).toBe(true);
    expect(validSubpathStarts([3, 3], 5)).toBe(false);
    expect(validSubpathStarts([5], 5)).toBe(false);
  });
});
