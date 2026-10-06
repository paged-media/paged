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

// The recipe store's READ over a fake host whose parts and document label
// are plain maps — so the cases a real engine cannot stage cheaply are
// exact: an InDesign save (every part gone, the label kept), an undone
// first write, a command write after an object-model write.

import { describe, expect, it } from "vitest";

import type { PluginMetadataEnvelope } from "@paged-media/plugin-api";

import {
  INLINE_BUDGET,
  planRecipeWrite,
  readRecipeBytes,
  recipeEntriesOf,
  withRecipeEntry,
  writeRecipeBytes,
  type RecipeHost,
} from "../src/recipe-store";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

function fakeHost() {
  const parts = new Map<string, Uint8Array>();
  let label: PluginMetadataEnvelope | null = null;
  const history: (PluginMetadataEnvelope | null)[] = [];
  let labelReads = 0;
  const host: RecipeHost = {
    supports: () => true,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
    parts: {
      read: async (p: string) => parts.get(p) ?? null,
      write: async (p: string, b: Uint8Array) => void parts.set(p, b),
      list: async () => [...parts.keys()],
      delete: async (p: string) => void parts.delete(p),
    } as never,
    document: {
      getDocumentMetadata: async () => {
        labelReads++;
        return label;
      },
      setDocumentMetadata: async (env: PluginMetadataEnvelope | null) => {
        history.push(label);
        label = env;
        return { applied: true } as never;
      },
    },
  };
  /** Commit a planned label mutation as the registry would. */
  const commit = (m: { args: { value?: string | null } }) => {
    history.push(label);
    label = m.args.value ? (JSON.parse(m.args.value) as PluginMetadataEnvelope) : null;
  };
  const undo = () => {
    label = history.pop() ?? null;
  };
  return { host, parts, commit, undo, reads: () => labelReads, label: () => label };
}

const LEGACY = "repeat.json";

describe("recipe store — one read over two write lanes", () => {
  it("a document only commands wrote reads its part and never asks the label", async () => {
    const f = fakeHost();
    await writeRecipeBytes(f.host, LEGACY, enc('{"v":1,"repeats":[]}'));
    expect(dec(await readRecipeBytes(f.host, LEGACY))).toBe('{"v":1,"repeats":[]}');
    expect(f.reads()).toBe(0);
  });

  it("an object-model write is undone by its label, the first one back to the origin", async () => {
    const f = fakeHost();
    await writeRecipeBytes(f.host, LEGACY, enc('{"v":1,"repeats":["A"]}'));
    const p1 = await planRecipeWrite(f.host, LEGACY, enc('{"v":1,"repeats":["B"]}'));
    if (typeof p1 === "string") throw new Error(p1);
    f.commit(p1.mutation as never);
    expect(JSON.parse(dec(await readRecipeBytes(f.host, LEGACY))!)).toEqual({ v: 1, repeats: ["B"] });
    await new Promise((r) => setTimeout(r, 0)); // the next batch
    const p2 = await planRecipeWrite(f.host, LEGACY, enc('{"v":1,"repeats":["C"]}'));
    if (typeof p2 === "string") throw new Error(p2);
    f.commit(p2.mutation as never);
    f.undo();
    expect(JSON.parse(dec(await readRecipeBytes(f.host, LEGACY))!)).toEqual({ v: 1, repeats: ["B"] });
    f.undo();
    expect(JSON.parse(dec(await readRecipeBytes(f.host, LEGACY))!)).toEqual({ v: 1, repeats: ["A"] });
  });

  it("a command write after an object-model write stays current", async () => {
    const f = fakeHost();
    const p = await planRecipeWrite(f.host, LEGACY, enc('{"v":1,"repeats":["B"]}'));
    if (typeof p === "string") throw new Error(p);
    f.commit(p.mutation as never);
    await readRecipeBytes(f.host, LEGACY);
    await writeRecipeBytes(f.host, LEGACY, enc('{"v":1,"repeats":["D"]}'));
    expect(JSON.parse(dec(await readRecipeBytes(f.host, LEGACY))!)).toEqual({ v: 1, repeats: ["D"] });
  });

  it("ADR 559 — with every part dropped (an InDesign save) the library reads from the label", async () => {
    const f = fakeHost();
    const p = await planRecipeWrite(f.host, LEGACY, enc('{"v":1,"repeats":["Ü"]}'));
    if (typeof p === "string") throw new Error(p);
    // The label value is ASCII (non-ASCII escaped), as InDesign keeps it.
    expect((p.mutation as { args: { value: string } }).args.value).toMatch(/^[\x20-\x7e]*$/);
    f.commit(p.mutation as never);
    f.parts.clear();
    expect(JSON.parse(dec(await readRecipeBytes(f.host, LEGACY))!)).toEqual({ v: 1, repeats: ["Ü"] });
  });

  it("an over-budget library is hash-only in the label (survives a paged save, not an InDesign one)", () => {
    const big = enc(JSON.stringify({ v: 1, repeats: ["x".repeat(INLINE_BUDGET)] }));
    const { envelope } = withRecipeEntry(null, "repeat", big);
    expect(recipeEntriesOf(envelope).repeat!.inline).toBeUndefined();
    const small = withRecipeEntry(envelope, "blend", enc('{"v":1,"blends":[]}'));
    expect(recipeEntriesOf(small.envelope).blend!.inline).toBe('{"v":1,"blends":[]}');
    expect(recipeEntriesOf(small.envelope).repeat!.h).toBe(recipeEntriesOf(envelope).repeat!.h);
  });

  it("two libraries planned in one batch are refused", async () => {
    const f = fakeHost();
    const a = await planRecipeWrite(f.host, "repeat.json", enc("{}"));
    const b = await planRecipeWrite(f.host, "blend.json", enc("{}"));
    expect(typeof a).toBe("object");
    expect(b).toMatch(/share the document label/);
  });
});
