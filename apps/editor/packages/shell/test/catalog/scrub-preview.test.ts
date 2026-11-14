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

// A numeric field's scrub preview as ONE undo step (catalog/scrub-preview.ts,
// editor ADR 1216): every write carries the scrub's coalesce key (engine ADR
// 1304), the release ends the run, a cancel ends it and undoes its one
// step, and writes land in order.

import { describe, expect, test } from "bun:test";

import { createPreviewCommitter } from "../../src/catalog/scrub-preview";

function fakeClient() {
  const log: string[] = [];
  /** The run's step, as the engine would answer `endCoalesce`. */
  const runs = new Set<string>();
  return {
    log,
    client: {
      async endCoalesce(key?: string) {
        log.push(`end ${key}`);
        const had = key !== undefined && runs.delete(key);
        return had ? 7 : null;
      },
      async undo() {
        log.push("undo");
        return {} as never;
      },
    },
    write: (v: number) => (key: string | null) => {
      if (key !== null) runs.add(key);
      log.push(`write ${v}${key ? ` @${key}` : ""}`);
    },
  };
}

const frame = () => new Promise((r) => setTimeout(r, 30));

describe("UXI-PNL-005 — a scrub is one undo step", () => {
  test("previews and the release carry one key; the last value of a frame wins; the release ends the run", async () => {
    const f = fakeClient();
    const c = createPreviewCommitter(f.client as never);
    c.preview("k1", f.write(1));
    c.preview("k1", f.write(2));
    await frame();
    c.preview("k1", f.write(3));
    c.commit("k1", f.write(4));
    await frame();
    expect(f.log).toEqual(["write 2 @k1", "write 4 @k1", "end k1"]);
  });

  test("a cancel ends the run and undoes its one step", async () => {
    const f = fakeClient();
    const c = createPreviewCommitter(f.client as never);
    c.preview("k", f.write(1));
    await frame();
    c.cancel("k");
    await frame();
    expect(f.log).toEqual(["write 1 @k", "end k", "undo"]);
  });

  test("a cancel before any write undoes nothing", async () => {
    const f = fakeClient();
    const c = createPreviewCommitter(f.client as never);
    c.preview("k", f.write(1));
    c.cancel("k");
    await frame();
    expect(f.log).toEqual(["end k"]);
  });

  test("a typed commit (no key) just writes, with no run to end", async () => {
    const f = fakeClient();
    const c = createPreviewCommitter(f.client as never);
    c.commit(null, f.write(7));
    await frame();
    expect(f.log).toEqual(["write 7"]);
  });

  test("writes run in order: a slow preview never lands after the release", async () => {
    const f = fakeClient();
    const c = createPreviewCommitter(f.client as never);
    const slow = (v: number) => (key: string | null) =>
      new Promise<void>((r) =>
        setTimeout(() => {
          f.write(v)(key);
          r();
        }, 20),
      );
    c.preview("k", slow(1));
    await frame();
    c.commit("k", f.write(2));
    await new Promise((r) => setTimeout(r, 80));
    expect(f.log).toEqual(["write 1 @k", "write 2 @k", "end k"]);
  });
});
