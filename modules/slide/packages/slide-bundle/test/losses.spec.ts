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

// paged.slide's losses (engine ADR 1097): an import report kept by an older
// version holds sentences, a new one loss entries; both read, and both reach
// the diagnostics channel through the SDK's one translation.

import { describe, expect, it } from "bun:test";

import { reportDiagnostics } from "../src/activate";
import { readImportReport } from "../src/engine";
import { LEGACY_LOSS, lossLines, readLosses } from "../src/losses";

const base = {
  width: 720,
  height: 540,
  slides: [],
  fonts: [],
  embeddedFonts: [],
};

describe("slide losses", () => {
  it("reads an older report's sentences as legacy entries", () => {
    const old = readImportReport({
      ...base,
      diagnostics: [
        "ppt/slides/slide1.xml: shape p:foo is not modelled (×3)",
        "ppt/slides/slide2.xml: effect a:glow is not carried",
      ],
    });
    expect(old.diagnostics).toEqual([
      {
        code: LEGACY_LOSS,
        count: 3,
        severity: "dropped",
        message: "ppt/slides/slide1.xml: shape p:foo is not modelled",
      },
      {
        code: LEGACY_LOSS,
        count: 1,
        severity: "dropped",
        message: "ppt/slides/slide2.xml: effect a:glow is not carried",
      },
    ]);
    // Worded as before: the count back as a suffix, a warning.
    expect(reportDiagnostics(old).map((d) => d.message)).toEqual([
      "ppt/slides/slide1.xml: shape p:foo is not modelled (3×)",
      "ppt/slides/slide2.xml: effect a:glow is not carried",
    ]);
    expect(reportDiagnostics(old).every((d) => d.severity === "warning")).toBe(
      true,
    );
  });

  it("reads entries as they are, beside sentences", () => {
    const losses = readLosses([
      {
        code: "pptx.table.styleUnknown",
        count: 1,
        severity: "approximated",
        message: "ppt/slides/slide1.xml: table style {X} is unknown",
      },
      { code: "pptx.font.embedded", count: 2, severity: "info" },
      "an older line",
      42,
    ]);
    expect(losses.map((l) => l.code)).toEqual([
      "pptx.table.styleUnknown",
      "pptx.font.embedded",
      LEGACY_LOSS,
    ]);
    expect(lossLines(losses)).toEqual([
      "ppt/slides/slide1.xml: table style {X} is unknown",
      "pptx.font.embedded (2×)",
      "an older line",
    ]);
  });

  it("an info entry stays info on the channel", () => {
    const r = readImportReport({
      ...base,
      diagnostics: [{ code: "x", count: 1, severity: "info", message: "m" }],
    });
    expect(reportDiagnostics(r)[0]?.severity).toBe("info");
  });
});
