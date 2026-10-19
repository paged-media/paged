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

// The gesture matrix's registry gate: the committed table
// (apps/canvas/tests/e2e/gesture-matrix.json) lists EVERY registered
// tool — the built-ins and every tool the bundles the app loads declare
// in their manifests — and nothing that is no longer registered. A new
// tool therefore lands with a row: specified cells, or `unspecified`
// with a reason, so the matrix's coverage stays visible. The browser
// spec (gesture-matrix.spec.ts) runs the specified cells.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  matrixCoverage,
  validateMatrix,
  type GestureMatrix,
} from "@paged-media/test-kit";

import { BUILT_IN_TOOLS } from "../src/built-in-tools";

const CANVAS = join(import.meta.dir, "../../../apps/canvas");
const TABLE = join(CANVAS, "tests/e2e/gesture-matrix.json");
/** The bundles the app loads (scripts/surface-coverage.mjs's list). */
const BUNDLES = [
  "draw",
  "web",
  "sheet",
  "data",
  "image",
  "doc",
  "pdf",
  "publish",
  "slide",
];

function bundleTools(): string[] {
  const out: string[] = [];
  for (const pkg of BUNDLES) {
    let manifest: { contributes?: { tools?: Array<string | { id: string }> } };
    try {
      manifest = JSON.parse(
        readFileSync(
          join(CANVAS, "node_modules/@paged-media", pkg, "manifest.json"),
          "utf8",
        ),
      );
    } catch {
      continue; // not a dependency of the app: contributes nothing
    }
    for (const t of manifest.contributes?.tools ?? [])
      out.push(typeof t === "string" ? t : t.id);
  }
  return out;
}

describe("the gesture matrix", () => {
  const matrix = validateMatrix(
    JSON.parse(readFileSync(TABLE, "utf8")) as GestureMatrix,
  );
  const registered = [
    ...BUILT_IN_TOOLS.filter((t) => t.status !== "planned").map((t) => t.id),
    ...bundleTools(),
  ];

  it("lists every registered tool and no unregistered one", () => {
    const c = matrixCoverage(matrix, registered);
    expect(registered.length).toBeGreaterThan(40);
    expect({ missing: c.missingTools, stale: c.staleTools }).toEqual({
      missing: [],
      stale: [],
    });
  });

  it("reports its coverage: cells specified / unspecified / expected to fail", () => {
    const c = matrixCoverage(matrix, registered);
    console.info(
      `gesture matrix: ${c.tools} tools × 5 modifier sets × 3 zooms × 6 targets = ${c.cells} cells; ` +
        `${c.specified} specified (${c.knownFailing} expected to fail on a finding), ${c.unspecified} unspecified; ` +
        `specified tools: ${c.perTool
          .filter((t) => t.specified > 0)
          .map((t) => `${t.tool} ${t.specified}`)
          .join(", ")}`,
    );
    expect(c.specified).toBeGreaterThan(0);
    // The starter set is specified.
    for (const tool of [
      "paged.tool.select",
      "paged.tool.directSelect",
      "paged.tool.rectangle",
      "paged.tool.ellipse",
      "paged.tool.line",
      "paged.tool.rotate",
      "paged.tool.scale",
      "paged.tool.pen",
      "paged.tool.type",
    ]) {
      expect(
        c.perTool.find((t) => t.tool === tool)?.specified,
        tool,
      ).toBeGreaterThan(0);
    }
  });
});
