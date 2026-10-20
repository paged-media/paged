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

// The coverage manifest — what makes "shows all the functionality" a
// checkable claim instead of a slogan.
//
// The project's own enumeration of what exists is the capability record:
// the feature registry's export (`exports/public.json`, schema
// `cockpit.export.v1`), every feature with its lifecycle, a status per
// component claim and the health its CI evidence gives it. It is the same
// record docs.paged.media and paged.media build their capability statements
// from. Every showcase page module declares the features it demonstrates;
// this resolves those ids against the record and refuses two things:
//
//   · a claimed feature that does not exist — a typo, or a feature that was
//     renamed out from under the page;
//   · a claimed feature that no component claim marks `shipped` — the
//     document must not advertise something the project itself records as
//     planned.
//
// Health (`broken` evidence) is reported, not gated: the showcase proves
// its own pages; a red test elsewhere is the record's to report.
//
// The result is written next to the artifacts so a reader can ask the
// document what it proves and get an answer that was checked.
//
// The record lives in a PRIVATE repository, so the whole gate degrades to
// a warning when it is not available. Absent evidence is reported as
// absent, never as a pass.

import { existsSync, readFileSync } from "node:fs";

/** The capability record's schema this reader understands. */
export const RECORD_SCHEMA = "cockpit.export.v1";

export interface RegistryRow {
  id: string;
  title?: string;
  /** True when ANY component claim records `shipped`. */
  shipped: boolean;
  /** The record's health state for the feature (`healthy`, `broken`, …). */
  health?: string;
}

export interface CoverageClaim {
  /** Module id, e.g. `06-vector`. */
  module: string;
  title: string;
  pages: number[];
  covers: string[];
  notes?: string[];
}

export interface CoverageReport {
  /** Which record the report was checked against, or `unavailable`. */
  generatedFrom: string;
  /** When the record was exported (its `generated_at`), if it was read. */
  recordExportedAt: string | null;
  registryFound: boolean;
  registryRows: number;
  claimedRows: number;
  claims: CoverageClaim[];
  /** Claimed ids absent from the record — always a failure. */
  unknown: string[];
  /** Claimed ids no component claim marks shipped. */
  notShipped: string[];
  /** Claimed ids whose evidence the record reports `broken` (not gated). */
  broken: string[];
  /** Families the showcase touches, with how many rows in each. */
  families: Record<string, number>;
}

interface RecordFeature {
  id?: unknown;
  title?: unknown;
  claims?: { status?: unknown }[];
  health?: { state?: unknown };
}

export interface CapabilityRecord {
  exportedAt: string | null;
  rows: Map<string, RegistryRow>;
}

/**
 * Read the capability record at `recordPath`. Empty (`rows.size === 0`)
 * when there is no record (`null` or a missing file). A file that is not a
 * `cockpit.export.v1` record throws: a wrong path is a configuration error,
 * not an absent axis.
 */
export function loadRecord(recordPath: string | null): CapabilityRecord {
  const rows = new Map<string, RegistryRow>();
  if (recordPath === null || !existsSync(recordPath)) {
    return { exportedAt: null, rows };
  }
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
    schema?: unknown;
    generated_at?: unknown;
    features?: RecordFeature[];
  };
  if (record.schema !== RECORD_SCHEMA || !Array.isArray(record.features)) {
    throw new Error(
      `${recordPath} is not a ${RECORD_SCHEMA} capability record ` +
        `(schema ${JSON.stringify(record.schema)})`,
    );
  }
  for (const f of record.features) {
    if (typeof f.id !== "string" || f.id === "") continue;
    rows.set(f.id, {
      id: f.id,
      title: typeof f.title === "string" ? f.title : undefined,
      shipped: (f.claims ?? []).some((c) => c.status === "shipped"),
      health: typeof f.health?.state === "string" ? f.health.state : undefined,
    });
  }
  return {
    exportedAt:
      typeof record.generated_at === "string" ? record.generated_at : null,
    rows,
  };
}

/** Every feature of the record, keyed by id (see `loadRecord`). */
export function loadRegistry(
  recordPath: string | null,
): Map<string, RegistryRow> {
  return loadRecord(recordPath).rows;
}

export function buildCoverage(
  recordPath: string | null,
  claims: CoverageClaim[],
): CoverageReport {
  const { exportedAt, rows: registry } = loadRecord(recordPath);
  const unknown: string[] = [];
  const notShipped: string[] = [];
  const broken: string[] = [];
  const families: Record<string, number> = {};
  const seen = new Set<string>();

  for (const claim of claims) {
    for (const id of claim.covers) {
      seen.add(id);
      const family = id.split(".")[0];
      families[family] = (families[family] ?? 0) + 1;
      if (registry.size === 0) continue;
      const row = registry.get(id);
      if (!row) {
        unknown.push(`${claim.module} → ${id}`);
        continue;
      }
      if (!row.shipped) notShipped.push(`${claim.module} → ${id}`);
      if (row.health === "broken") broken.push(`${claim.module} → ${id}`);
    }
  }

  return {
    // A label, never the path: the report is committed with the artifacts.
    generatedFrom:
      registry.size > 0
        ? `${RECORD_SCHEMA} capability record${exportedAt ? ` exported ${exportedAt}` : ""}`
        : "unavailable",
    recordExportedAt: exportedAt,
    registryFound: registry.size > 0,
    registryRows: registry.size,
    claimedRows: seen.size,
    claims,
    unknown,
    notShipped,
    broken,
    families,
  };
}
