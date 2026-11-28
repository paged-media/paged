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

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { CAPABILITIES } from "../../../tests/e2e/harness/capabilities";

// ── AC-E2E-CAPS-COVER — the table must ENUMERATE the engine ─────────
//
// The probe (tests/e2e/capability-matrix.spec.ts) validates every op the table lists. It cannot notice
// an op the table has never heard of, because nothing iterates the
// engine's own op set — and that is precisely how this table drifted
// 21 protocol versions without a single red run.
//
// Found 2026-08-09: the header said "re-captured at protocol v40" while
// core was at 61. The table carried 94 ops; the engine declared 117.
// The 23 missing ones included `insertHyperlink` and
// `insertAnchoredFrame` — doors the plugin-doc campaign built and
// shipped — and `state`'s completeness gate derives ITS wire-op list
// from this very file, so it printed "completeness check OK" while
// structurally blind to all of them.
//
// The fix is to read the op set from the ENGINE rather than trust the
// table: `@paged-media/canvas-wasm` ships its `Mutation` union in its
// generated .d.ts, and that package is already a dependency here, so
// this needs no core checkout and no live probe. A new op now fails
// this test the moment the engine is repinned.
//
// Deliberately a SEPARATE test from the probe
// (tests/e2e/capability-matrix.spec.ts, in the browser): this one asserts the
// table is COMPLETE, the probe asserts it is CORRECT. Conflating them
// would mean an unclassified new op could not be reported without also
// failing the classification run.
test("AC-E2E-CAPS-COVER — every engine Mutation op appears in the table", () => {
  const require = createRequire(import.meta.url);
  const dts =
    require.resolve("@paged-media/canvas-wasm/paged_canvas_wasm.d.ts");
  const src = readFileSync(dts, "utf8");

  // The union is emitted on one line: `export type Mutation = { op: "a";
  // args: {...} } | { op: "b"; ... };`. Slice that statement first so a
  // stray `op: "…"` in some other type cannot leak in.
  const start = src.indexOf("export type Mutation =");
  expect(start, "engine .d.ts has no `export type Mutation`").toBeGreaterThan(
    -1,
  );
  const stmt = src.slice(start, src.indexOf(";\n", start));
  const engineOps = [...stmt.matchAll(/\bop: "([a-zA-Z]+)"/g)].map((m) => m[1]);
  expect(
    engineOps.length,
    "parsed no ops from the Mutation union",
  ).toBeGreaterThan(50);

  const listed = new Set(CAPABILITIES.map((c) => c.op));
  // `batch` is the envelope, not a capability — it carries other ops and
  // has no standalone support question.
  const missing = [...new Set(engineOps)]
    .filter((op) => op !== "batch" && !listed.has(op))
    .sort();

  // The gap as it stood when this gate was written (2026-08-09: 23 ops
  // — the pathfinder region verbs, both opacity-mask ops, text-on-a-
  // path, the plugin-doc doors, and friends). A RATCHET, not an
  // excuse: it must only ever shrink — and on 2026-08-26 it shrank to
  // EMPTY: every one of the 23 got a real-args probe (shapes sourced
  // from the generated .d.ts + core's wire tests, per the rule below)
  // and a row in harness/capabilities.ts.
  //
  // An op may only ever sit here UNCLASSIFIED, never mis-classified,
  // because classifying an op means probing it with real args, and a
  // probe built on GUESSED args reports "unsupported" when the guess is
  // wrong rather than when the engine lacks the op. That would put
  // false evidence into the one table `state`'s completeness gate
  // trusts — worse than the gap it would paper over. A new entry needs
  // its args from the engine's .d.ts and a real domain test alongside.
  const KNOWN_UNCLASSIFIED: string[] = [];

  // STALENESS, checked in the other direction too: an entry that has
  // since been classified must leave this list, or the ratchet quietly
  // stops ratcheting. Same shape as core's KNOWN_WRITE_ONLY audit.
  const stale = KNOWN_UNCLASSIFIED.filter((op) => listed.has(op)).sort();
  expect(
    stale,
    `These ops are now IN the table but still listed as unclassified — ` +
      `delete them from KNOWN_UNCLASSIFIED:\n  ${stale.join("\n  ")}`,
  ).toEqual([]);

  const unexpected = missing.filter((op) => !KNOWN_UNCLASSIFIED.includes(op));

  expect(
    unexpected,
    unexpected.length === 0
      ? ""
      : `The engine declares ${unexpected.length} NEW Mutation op(s) this table has never heard of:\n` +
          `  ${unexpected.join("\n  ")}\n\n` +
          `Add each to harness/capabilities.ts and give it a probe in tests/e2e/capability-matrix.spec.ts ` +
          `(E2E_CAPS=capture to classify), then add or upgrade the real domain test. ` +
          `Leaving them out does not just under-report here: paged-media/state's ` +
          `completeness-check.mjs reads its wire-op list from this file, so an op ` +
          `missing here is invisible to the capability registry too.`,
  ).toEqual([]);
});
