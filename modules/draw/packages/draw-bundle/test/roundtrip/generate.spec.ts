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

// The ROUND-TRIP lane's GENERATOR: author every case (`author.ts`) and
// write the IDML the engine exports to `test/fixtures/roundtrip/<case>.idml`
// — the file InDesign is then asked to read
// (`scripts/indesign/run-roundtrip.sh`). A maintainer action, gated on an
// environment variable so `pnpm test` never rewrites a committed fixture:
//
//   PAGED_ROUNDTRIP_WRITE=1 pnpm --filter @paged-media/draw exec \
//     vitest run test/roundtrip/generate.spec.ts
//   PAGED_ROUNDTRIP_WRITE=pen-open,join …   (only these cases)
//
// A re-generated IDML makes its recording STALE: `roundtrip.spec.ts`
// checks that the committed IDML is what the engine exports today and
// fails until the case is re-recorded.

import { mkdirSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ROUNDTRIP_CASES, authorCase } from "./author";
import { ROUNDTRIP_FIXTURES, idmlPath } from "./indesign";

const WRITE = process.env.PAGED_ROUNDTRIP_WRITE ?? "";
const wanted = (id: string): boolean =>
  WRITE === "1" || WRITE === "all" || WRITE.split(",").includes(id);

describe.skipIf(WRITE === "")("round trip — write the IDML InDesign is asked to read", () => {
  for (const c of ROUNDTRIP_CASES) {
    it.runIf(wanted(c.id))(`${c.id}: ${c.row}`, async () => {
      const authored = await authorCase(c);
      try {
        mkdirSync(ROUNDTRIP_FIXTURES, { recursive: true });
        writeFileSync(idmlPath(c.id), authored.idml);
        expect(authored.idml.length).toBeGreaterThan(0);
      } finally {
        authored.h.dispose();
      }
    }, 60_000);
  }
});
