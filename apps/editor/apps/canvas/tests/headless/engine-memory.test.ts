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

// The engine's memory over a session that opens documents again and
// again: the headless parity suite (some 1,500 loads in one wasm instance)
// ran the engine out of its 4 GB address space and trapped. Measured on
// the editor's own load path and isolated to the font bytes each load
// hands the engine. Both are FINDINGS, expected failures until fixed.
//
// Each test runs on its own wasm instance (`rebootHeadlessEngine`), warms
// up, then reads the linear memory before and after forty loads of a tiny
// document. Memory is allocated in pages and an allocator keeps what it
// freed, so the bound is generous; the leaks below are 4x to 15x over it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildFixtureIdml, rect } from "@paged-media/test-kit";
import { rebootHeadlessEngine } from "@paged-media/test-kit/headless";

import { createHeadlessEditor } from "./harness";

const LOADS = 40;
const BOUND = 8 * 1024 * 1024;
const MB = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

const doc = () =>
  buildFixtureIdml({
    name: "memory",
    pages: [{ id: "mp1", items: [rect("mframe", [72, 72, 144, 216])] }],
  });
const font = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../public/fonts/${name}`, import.meta.url)),
  );

describe("engine memory across document loads", () => {
  test.failing(
    "PAR-1: a load with a fallback font keeps none of the previous load's font (each load retains ~0.9 MB)",
    async () => {
      const engine = await rebootHeadlessEngine();
      const w = engine.create();
      const inter = font("Inter.ttf");
      for (let i = 0; i < 5; i++) w.loadDocumentDirect(i, doc(), inter);
      const before = engine.memoryBytes();
      for (let i = 0; i < LOADS; i++)
        w.loadDocumentDirect(100 + i, doc(), inter);
      const grown = engine.memoryBytes() - before;
      w.free();
      expect(MB(grown)).toBe(MB(Math.min(grown, BOUND)));
    },
  );

  test("a load without a font grows nothing (the control)", async () => {
    const engine = await rebootHeadlessEngine();
    const w = engine.create();
    for (let i = 0; i < 5; i++) w.loadDocumentDirect(i, doc());
    const before = engine.memoryBytes();
    for (let i = 0; i < LOADS; i++) w.loadDocumentDirect(100 + i, doc());
    const grown = engine.memoryBytes() - before;
    w.free();
    expect(grown).toBeLessThanOrEqual(BOUND);
  });

  // PAR-2 (fixed, ADR 248): the client registered the default faces again
  // after every load, and the engine keeps every registered face for later
  // loads, so each open added a copy (~4 MB). A face the client already
  // registered byte for byte is not posted again.
  test("PAR-2: a load does not register the default faces again", async () => {
    await rebootHeadlessEngine();
    const ed = await createHeadlessEditor({ idml: doc() });
    try {
      await ed.load(doc());
      const worker = ed.worker as unknown as {
        postMessage(m: unknown, t?: unknown): void;
      };
      const post = worker.postMessage.bind(worker);
      let registered = 0;
      worker.postMessage = (m: unknown, t?: unknown) => {
        if ((m as { msg?: { kind?: string } })?.msg?.kind === "registerFont")
          registered++;
        post(m, t as never);
      };
      for (let i = 0; i < 10; i++) await ed.load(doc());
      expect(registered).toBe(0);
    } finally {
      await ed.dispose();
    }
  });

  // What is left of the editor's growth per open is PAR-1's (~0.85 MB, the
  // load's fallback font kept by the engine): flat once PAR-1 is fixed.
  test.failing(
    "PAR-1 in the editor: opening documents keeps its memory flat (each open keeps the fallback font, PAR-1)",
    async () => {
      await rebootHeadlessEngine();
      const ed = await createHeadlessEditor({ idml: doc() });
      try {
        for (let i = 0; i < 5; i++) await ed.load(doc());
        const before = ed.engine.memoryBytes();
        for (let i = 0; i < LOADS; i++) await ed.load(doc());
        const grown = ed.engine.memoryBytes() - before;
        expect(MB(grown)).toBe(MB(Math.min(grown, BOUND)));
      } finally {
        await ed.dispose();
      }
    },
  );
});
