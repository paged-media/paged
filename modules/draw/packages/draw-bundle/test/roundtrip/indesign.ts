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

// The ROUND-TRIP lane's InDesign half: what a recorded answer looks like
// and how to load one. A recording is Adobe InDesign's reading of one IDML
// file this lane exported, made once on a maintainer's Mac by
// `scripts/indesign/run-roundtrip.sh` and committed beside the IDML as
// `test/fixtures/roundtrip/<case>.indesign.json`. CI never drives InDesign.
//
// Everything is in POINTS, page-local, origin top-left, Y DOWN — the
// engine's frame (the reader sets the ruler origin to the page and the
// zero point to its corner). Enumerations are InDesign's own NAMES
// (`ROUND_END_JOIN`), swatches InDesign's internal names ("None", "Black").

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { OraclePath } from "../oracle/oracle";

export interface InDesignSwatch {
  name: string;
  /** `Swatch` (None / Registration), `Color`, `Tint`, `Gradient`… */
  type: string;
  model?: string;
  space?: string;
  value?: number[];
  tintValue?: number;
  base?: InDesignSwatch;
  gradientType?: string;
  stops?: { location: number; midpoint: number; color: InDesignSwatch }[];
}

export interface InDesignTransparency {
  opacity: number;
  blendMode: string;
}

export interface InDesignCorner {
  option: string;
  radius: number;
}

/** A value InDesign refused to read for this item ("not applicable in the
 *  current state") — recorded as such, never as a guess. */
export interface Unreadable {
  unreadable: string;
}

export interface InDesignTextPath {
  contents: string;
  storyContents: string;
  pathEffect: string;
  flipPathEffect: string;
  startBracket: number;
  endBracket: number;
  overflows: boolean;
}

export interface InDesignItem {
  kind: string;
  id: number;
  /** "spread", or `<Kind>#<id>` of the containing group / frame. */
  parent: string;
  /** Position in the parent's `pageItems` — 0 is the FRONT (measured: a
   *  two-item probe listed the later-inserted item first). */
  position: number;
  index: number;
  /** Stacking order among its siblings, 0 = BACK — read from InDesign's
   *  own IDML export of the opened document (the writer adds it). */
  z: number;
  name: string;
  label: string;
  labels: Record<string, string>;
  layer: string;
  visible: boolean;
  locked: boolean;
  geometricBounds: [number, number, number, number];
  visibleBounds: [number, number, number, number];
  paths?: (OraclePath & { pathType: string })[];
  fill?: InDesignSwatch;
  fillTint?: number;
  gradientFillAngle?: number;
  gradientFillLength?: number;
  gradientFillStart?: [number, number];
  stroke?: InDesignSwatch;
  strokeTint?: number;
  strokeWeight?: number;
  endCap?: string;
  endJoin?: string;
  miterLimit?: number;
  strokeAlignment?: string;
  strokeType?: { name: string; key: string | null };
  strokeDashAndGap?: number[] | Unreadable;
  gapColor?: InDesignSwatch;
  gapTint?: number;
  leftLineEnd?: string;
  rightLineEnd?: string;
  corners?: Record<"topLeft" | "topRight" | "bottomRight" | "bottomLeft", InDesignCorner>;
  transparency?: InDesignTransparency;
  fillTransparency?: InDesignTransparency;
  strokeTransparency?: InDesignTransparency;
  textPaths?: InDesignTextPath[] | null;
  contents?: string;
  overflows?: boolean;
}

export interface InDesignWarning {
  source: "font" | "link" | "overset";
  [detail: string]: unknown;
}

export interface InDesignRecording {
  fixture: string;
  produced_by: {
    app: string;
    version: string;
    locale: string;
    script: string;
    script_sha256: string;
    runner: string;
    recorded_at: string;
    host_os: string;
    pdf_preset: string | null;
  };
  idml: { path: string; sha256: string };
  units: "pt";
  coordinates: string;
  open: { converted: boolean; modified: boolean };
  spreads: number;
  pages: { name: string; bounds: [number, number, number, number] }[];
  layers: string[];
  warnings: InDesignWarning[];
  /** Every story InDesign holds, with the kinds of what holds it. */
  stories: { contents: string; textContainers: number; containerKinds: string[] }[];
  items: InDesignItem[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the lane's committed files live. */
export const ROUNDTRIP_FIXTURES = resolve(HERE, "../fixtures/roundtrip");

export const idmlPath = (id: string): string => resolve(ROUNDTRIP_FIXTURES, `${id}.idml`);
export const recordingPath = (id: string): string =>
  resolve(ROUNDTRIP_FIXTURES, `${id}.indesign.json`);
/** InDesign's OWN IDML export of the case (recorded for the re-import
 *  cases only, with `PAGED_RT_REEXPORT`). */
export const reexportPath = (id: string): string =>
  resolve(ROUNDTRIP_FIXTURES, `${id}.indesign.idml`);

/** Load a recording. A replay exists only for a case that HAS been
 *  recorded, so a missing or malformed file THROWS — a deleted recording
 *  must not turn its replay into nothing. */
export function loadRecording(id: string): InDesignRecording {
  const path = recordingPath(id);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing — record it with scripts/indesign/run-roundtrip.sh ` +
        `${idmlPath(id)} <that path> (see scripts/indesign/README.md)`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as InDesignRecording;
  if (parsed.fixture !== id) throw new Error(`${path}: fixture is "${parsed.fixture}"`);
  if (parsed.units !== "pt") throw new Error(`${path}: units are "${parsed.units}"`);
  for (const key of ["app", "version", "script", "script_sha256", "recorded_at"] as const) {
    if (typeof parsed.produced_by?.[key] !== "string") {
      throw new Error(`${path}: produced_by.${key} is missing`);
    }
  }
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error(`${path}: no items — an empty recording is not an answer`);
  }
  return parsed;
}

export const isUnreadable = (v: unknown): v is Unreadable =>
  typeof v === "object" && v !== null && "unreadable" in v;
