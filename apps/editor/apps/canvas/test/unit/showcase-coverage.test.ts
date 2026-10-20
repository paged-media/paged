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

// The showcase's registry axis reads the capability record
// (cockpit.export.v1). A fixture record in the export's shape pins what
// counts as shipped, unknown and broken, and that an absent record is
// reported as unavailable rather than as a pass.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCoverage,
  loadRecord,
  type CoverageClaim,
} from "../../tests/showcase/coverage";

function writeRecord(record: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "showcase-coverage-"));
  const path = join(dir, "public.json");
  writeFileSync(path, JSON.stringify(record));
  return path;
}

const RECORD = {
  schema: "cockpit.export.v1",
  generated_at: "2026-10-20T08:56:35.015Z",
  features: [
    {
      id: "text.drop-caps",
      title: "Drop caps",
      status: "stable",
      claims: [
        { component: "core.parser", status: "shipped" },
        { component: "core.renderer", status: "partial" },
      ],
      health: { state: "healthy" },
    },
    {
      id: "text.ruby",
      title: "Ruby",
      status: "experimental",
      claims: [{ component: "core.renderer", status: "planned" }],
      health: { state: "unknown" },
    },
    {
      id: "image.blur",
      title: "Blur",
      status: "stable",
      claims: [{ component: "image.kernels", status: "shipped" }],
      health: { state: "broken" },
    },
  ],
};

const claim = (covers: string[]): CoverageClaim => ({
  module: "06-text",
  title: "Text",
  pages: [6],
  covers,
});

describe("showcase coverage against the capability record", () => {
  test("a feature is shipped when any component claim is shipped", () => {
    const { rows, exportedAt } = loadRecord(writeRecord(RECORD));
    expect(rows.size).toBe(3);
    expect(rows.get("text.drop-caps")).toEqual({
      id: "text.drop-caps",
      title: "Drop caps",
      shipped: true,
      health: "healthy",
    });
    expect(rows.get("text.ruby")?.shipped).toBe(false);
    expect(exportedAt).toBe("2026-10-20T08:56:35.015Z");
  });

  test("unknown and unshipped claims fail; broken ones are reported", () => {
    const report = buildCoverage(writeRecord(RECORD), [
      claim(["text.drop-caps", "text.ruby", "text.missing", "image.blur"]),
    ]);
    expect(report.registryFound).toBe(true);
    expect(report.registryRows).toBe(3);
    expect(report.claimedRows).toBe(4);
    expect(report.unknown).toEqual(["06-text → text.missing"]);
    expect(report.notShipped).toEqual(["06-text → text.ruby"]);
    expect(report.broken).toEqual(["06-text → image.blur"]);
    expect(report.families).toEqual({ text: 3, image: 1 });
    // A label, never a filesystem path: the report is committed.
    expect(report.generatedFrom).toBe(
      "cockpit.export.v1 capability record exported 2026-10-20T08:56:35.015Z",
    );
  });

  test("no record is unavailable, never a pass", () => {
    for (const path of [null, join(tmpdir(), "no-such-record.json")]) {
      const report = buildCoverage(path, [claim(["text.missing"])]);
      expect(report.registryFound).toBe(false);
      expect(report.generatedFrom).toBe("unavailable");
      expect(report.unknown).toEqual([]);
      expect(report.claimedRows).toBe(1);
    }
  });

  test("a file that is not a capability record is a configuration error", () => {
    const path = writeRecord({ schema: "state.registry.v0", features: [] });
    expect(() => loadRecord(path)).toThrow(/not a cockpit\.export\.v1/);
  });
});
