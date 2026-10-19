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

// The gesture fuzzer against the RUNNING editor's worker (the real
// message channel, the browser's wasm), with the same invariants as the
// headless run (platform/shared/test-kit/test/gesture-fuzz.test.ts) and
// the IDML round trip done by the editor itself: export, load the bytes
// back, compare geometry. The headless run is the volume (25 sequences a
// fixture in CI, 200 locally); this one proves the browser agrees, so it
// is small: PAGED_GESTURE_FUZZ_BROWSER_N sequences a fixture (default 3).

import { expect, test, type Page } from "@playwright/test";

import {
  geometryDigest,
  gestureFixture,
  GESTURE_FUZZ_KNOWN,
  runGestureFuzz,
  type FuzzReport,
  type GestureFixtureName,
} from "@paged-media/test-kit";

import { openCanvas } from "../fidelity/canvas-driver";
import { browserSend } from "./harness/gesture-kit";

const N = Number(process.env.PAGED_GESTURE_FUZZ_BROWSER_N ?? 3);

/** Load IDML bytes into the editor through its client (no viewport needed). */
async function loadBytes(page: Page, bytes: Uint8Array): Promise<void> {
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    await (
      globalThis as unknown as {
        __canvas: { client: { loadDocument(b: Uint8Array): Promise<unknown> } };
      }
    ).__canvas.client.loadDocument(out);
  }, Buffer.from(bytes).toString("base64"));
}

for (const name of ["targets", "paths", "dense"] as GestureFixtureName[]) {
  test(`gesture fuzzer in the browser on the ${name} fixture: ${N} seeded sequences, the headless invariants hold @level:gesture`, async ({
    page,
  }) => {
    test.setTimeout(4 * 60_000);
    await openCanvas(page);
    const send = browserSend(page);
    const findings: FuzzReport[] = [];
    let commits = 0;
    for (let seed = 1; seed <= N; seed++) {
      await loadBytes(page, gestureFixture(name));
      const report = await runGestureFuzz({
        send,
        seed,
        length: 6,
        known: GESTURE_FUZZ_KNOWN,
        roundTrip: async (idml) => {
          await loadBytes(page, idml);
          return geometryDigest(send);
        },
      });
      commits += report.stats.commits;
      if (report.failures.length) findings.push(report);
    }
    expect(commits).toBeGreaterThan(0);
    expect(
      findings.map((f) => ({
        seed: f.seed,
        failures: f.failures.map((x) => `${x.invariant}: ${x.message}`),
      })),
    ).toEqual([]);
  });
}
