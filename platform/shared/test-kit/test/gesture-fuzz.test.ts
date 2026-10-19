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

// The gesture fuzzer against the real engine (headless): N seeded
// sequences per fixture, every invariant checked after every step, and
// the document saved as IDML and loaded again at the end of each.
//
// N is bounded for CI (fixed seeds 1…N). `PAGED_GESTURE_FUZZ_N=200` is
// the local gate; a nightly lane can raise it. `PAGED_GESTURE_FUZZ_SEED`
// replays one sequence. A finding prints its seed and trace.

import { afterAll, describe, expect, it } from "bun:test";

import type { MainToWorkerKind, WorkerToMain } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import {
  fuzzSequenceCount,
  geometryDigest,
  gestureFixture,
  runGestureFuzz,
  type FuzzReport,
  type GestureFixtureName,
  GESTURE_FUZZ_KNOWN,
} from "../src/index.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const env = process.env;
const N = fuzzSequenceCount(env);
const ONE = env.PAGED_GESTURE_FUZZ_SEED
  ? Number(env.PAGED_GESTURE_FUZZ_SEED)
  : null;
const FIXTURES: GestureFixtureName[] = ["targets", "paths", "dense"];

/** The findings on record (see GESTURE_FUZZ_KNOWN in the kit): counted
 *  and printed, not failed, while a regression test owns each. */
const KNOWN = GESTURE_FUZZ_KNOWN;

type Send = (m: MainToWorkerKind) => Promise<WorkerToMain>;
const sendOf = (h: HeadlessHost): Send => {
  const client = (h.host.editor as unknown as { client: { send: Send } })
    .client;
  return client.send.bind(client);
};

const hosts: HeadlessHost[] = [];
afterAll(() => {
  for (const h of hosts) h.dispose();
});

describe.each(FIXTURES)("gesture fuzzer on the %s fixture", (name) => {
  it(`${ONE !== null ? `seed ${ONE}` : `${N} seeded sequences`}: no panic, no error, finite bounds, exact undo/redo, cancel commits nothing, IDML round trip @level:gesture`, async () => {
    const bytes = gestureFixture(name);
    const h = await createHeadlessHost({ console: silent });
    const reload = await createHeadlessHost({ console: silent });
    hosts.push(h, reload);
    const seeds =
      ONE !== null ? [ONE] : Array.from({ length: N }, (_, i) => i + 1);
    const findings: FuzzReport[] = [];
    let gestures = 0;
    let commits = 0;
    const known = new Map<string, number>();
    for (const seed of seeds) {
      await h.load(bytes);
      const report = await runGestureFuzz({
        send: sendOf(h),
        seed,
        known: KNOWN,
        roundTrip: async (idml) => {
          await reload.load(idml);
          return geometryDigest(sendOf(reload));
        },
      });
      gestures += report.stats.gestures;
      commits += report.stats.commits;
      for (const k of report.known)
        known.set(k.known!, (known.get(k.known!) ?? 0) + 1);
      if (report.failures.length) findings.push(report);
    }
    if (known.size) {
      console.info(
        `${name}: ${seeds.length} sequences, ${gestures} gestures, ${commits} commits; known findings hit: ` +
          [...known].map(([id, n]) => `${id} ×${n}`).join(", "),
      );
    }
    if (findings.length && ONE !== null) {
      console.error(JSON.stringify(findings[0].trace));
    }
    if (findings.length) {
      // The seed reproduces the sequence; the trace is the readable form.
      console.error(
        `${name}: ${findings.length} of ${seeds.length} sequence(s) broke an invariant:\n` +
          findings
            .map(
              (f) =>
                `  seed ${f.seed}: ${f.failures.map((x) => `[${x.invariant}] step ${x.step}: ${x.message}\n      at ${JSON.stringify(f.trace[x.step] ?? "(round trip)")}`).join("\n    ")}`,
            )
            .join("\n"),
      );
    }
    expect(gestures).toBeGreaterThan(0);
    expect(commits).toBeGreaterThan(0);
    expect(
      findings.map((f) => ({
        seed: f.seed,
        failures: f.failures.map((x) => x.invariant),
      })),
    ).toEqual([]);
  }, 600_000);
});
