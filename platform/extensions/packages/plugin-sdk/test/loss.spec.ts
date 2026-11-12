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

// Capability register C18, engine ADR 1097 — the one translation of loss
// entries onto the host's diagnostics channel.

import { describe, expect, it } from "bun:test";

import type { LossEntry } from "@paged-media/plugin-api";

import {
  lossDiagnosticSeverity,
  lossDiagnostics,
  lossRank,
} from "../src/loss.js";

describe("lossDiagnostics", () => {
  const entries: LossEntry[] = [
    { code: "filter", count: 2, severity: "dropped", message: "a filter" },
    { code: "docx.tier3", count: 1, severity: "info", message: "a note" },
    { code: "shading.sampled", count: 1 },
  ];

  it("words each entry, prefixed and counted, info staying info", () => {
    expect(
      lossDiagnostics(entries, {
        prefix: "x: ",
        source: "f.svg",
        word: (e) => `worded ${e.code}`,
      }),
    ).toEqual([
      { severity: "warning", message: "x: a filter (2×)", source: "f.svg" },
      { severity: "info", message: "x: a note", source: "f.svg" },
      {
        severity: "warning",
        message: "x: worded shading.sampled",
        source: "f.svg",
      },
    ]);
  });

  it("falls back to the code and leaves the source off when absent", () => {
    expect(lossDiagnostics([entries[2]!])).toEqual([
      { severity: "warning", message: "shading.sampled" },
    ]);
  });

  it("ranks left out before drawn differently before worth knowing", () => {
    expect([lossRank("dropped"), lossRank(undefined)]).toEqual([0, 0]);
    expect(lossRank("approximated")).toBe(1);
    expect(lossRank("info")).toBe(2);
    expect(lossDiagnosticSeverity("approximated")).toBe("warning");
  });
});
