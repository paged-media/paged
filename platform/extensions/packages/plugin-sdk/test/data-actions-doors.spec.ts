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

// Extensions ADRs 343 and 344 — the DATA door (`host.data`, data@1) and the
// ACTIONS door (`host.actions`, actions@1).
//
// Coverage:
//   1. data: one bundle serves, a different bundle (sharing the injected
//      backend) reads tables and records, writes rows, binds, and hears the
//      change; a second service is refused; disposing stops serving;
//   2. the data gate: each role is refused without its capability, and
//      without a backend every call rejects and supports("data@1") is false;
//   3. actions: one bundle registers, another runs one action and a chain;
//      the second run of the same input and chain is answered from the cache
//      under the same key; a parameter change misses it; kinds that do not
//      chain are refused; the gate and the absent registry.

import { describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import {
  actionKey,
  createActionRegistry,
  createBundleHost,
  createDataRegistry,
  fakeDataService,
  PluginCapabilityError,
  type ActionBackend,
  type DataBackend,
} from "../src";
import { makeFakeEditor } from "./fake-editor";

import { silentConsole as silent } from "../src/testing";

const manifest = (
  id: string,
  capabilities: PluginManifest["capabilities"],
): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

const SERVER = manifest("media.paged.data", { data: { serve: true } });
const SHEET = manifest("media.paged.sheet", {
  data: { read: true, write: true, bind: true },
});
const READER = manifest("com.example.reader", { data: { read: true } });

function host(m: PluginManifest, data?: DataBackend, actions?: ActionBackend) {
  return createBundleHost(() => makeFakeEditor().editor, m, {
    console: silent,
    data,
    actions,
    capabilityMode: "enforce",
  }).host;
}

const products = () =>
  fakeDataService({
    products: {
      fields: [
        { name: "sku", ty: "text" },
        { name: "price", ty: "float" },
      ],
      rows: [
        { sku: "A-1", price: 9.5 },
        { sku: "B-2", price: 12 },
      ],
    },
  });

describe("host.data — the data door (extensions ADR 343) [extensions.data-door]", () => {
  it("a served table is read, written and bound by another bundle, which hears the change", async () => {
    const backend = createDataRegistry();
    const server = host(SERVER, backend);
    const sheet = host(SHEET, backend);
    expect(sheet.supports("data@1")).toBe(true);
    expect(sheet.data.available()).toBe(false);
    await expect(sheet.data.tables()).rejects.toThrow(/no data service/);

    const fake = products();
    const handle = server.data.serve(fake);
    expect(sheet.data.available()).toBe(true);
    const [t] = await sheet.data.tables();
    expect(t).toMatchObject({
      name: "products",
      kind: "source",
      rowCount: 2,
      writable: true,
    });
    const rs = await sheet.data.records("products", { offset: 1 });
    expect(rs.columns).toEqual([["B-2"], [12]]);

    const changes: string[] = [];
    sheet.data.onDidChange((c) => changes.push(`${c.table}@${c.revision}`));
    const w = await sheet.data.write("products", [
      { op: "set", row: 0, field: "price", value: 10 },
    ]);
    handle.changed({ table: "products", revision: w.revision });
    expect(fake.rows("products")[0]).toEqual({ sku: "A-1", price: 10 });
    expect(changes).toEqual(["products@2"]);

    const b = await sheet.data.bind({
      target: "rectangle:u1",
      path: "frameOpacity",
      query: "q",
      expr: "price",
    });
    expect((await sheet.data.bindings()).map((x) => x.id)).toEqual([b.id]);

    expect(() =>
      host(
        manifest("media.paged.other", { data: { serve: true } }),
        backend,
      ).data.serve(products()),
    ).toThrow(/serves the document's data already/);
    handle.dispose();
    expect(sheet.data.available()).toBe(false);
  });

  it("each role needs its capability; without a backend every call rejects", async () => {
    const backend = createDataRegistry();
    host(SERVER, backend).data.serve(products());
    const reader = host(READER, backend);
    expect((await reader.data.records("products")).rowCount).toBe(2);
    await expect(reader.data.write("products", [])).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
    await expect(
      reader.data.bind({ target: "doc", path: "x", query: "q", expr: "1" }),
    ).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(() => reader.data.serve(products())).toThrow(PluginCapabilityError);

    const lone = host(SHEET);
    expect(lone.supports("data@1")).toBe(false);
    await expect(lone.data.tables()).rejects.toThrow(
      /supports\('data@1'\) is false/,
    );
  });

  it("a service that leaves a member out refuses it with the reason", async () => {
    const backend = createDataRegistry();
    const { write: _w, ...readOnly } = products();
    host(SERVER, backend).data.serve(readOnly);
    await expect(
      host(SHEET, backend).data.write("products", []),
    ).rejects.toThrow(/does not offer write/);
  });
});

const PAINTER = manifest("media.paged.image", { actions: { register: true } });
const RUNNER = manifest("media.paged.data", { actions: { run: true } });

describe("host.actions — the actions door (extensions ADR 344) [extensions.actions-door]", () => {
  it("one bundle registers, another runs; a second run is cached under the same key", async () => {
    const registry = createActionRegistry();
    const painter = host(PAINTER, undefined, registry);
    const runner = host(RUNNER, undefined, registry);
    let calls = 0;
    painter.actions.register({
      id: "media.paged.image/invert",
      title: "Invert",
      input: "asset",
      output: "asset",
      params: { strength: 1 },
      run(input, params) {
        calls++;
        const a = input as { bytes: Uint8Array; mediaType: string };
        return {
          bytes: a.bytes.map((b) => (255 - b) * (params.strength as number)),
          mediaType: a.mediaType,
        };
      },
    });
    painter.actions.register({
      id: "media.paged.image/size",
      title: "Byte size",
      input: "asset",
      output: "value",
      run: (input) => (input as { bytes: Uint8Array }).bytes.length,
    });
    expect(runner.supports("actions@1")).toBe(true);
    expect(runner.actions.list("asset").map((a) => a.id)).toEqual([
      "media.paged.image/invert",
      "media.paged.image/size",
    ]);

    const asset = {
      bytes: new Uint8Array([0, 10, 255]),
      mediaType: "image/x-gray",
    };
    const first = await runner.actions.run("media.paged.image/invert", asset);
    expect(first.cached).toBe(false);
    expect(Array.from((first.output as { bytes: Uint8Array }).bytes)).toEqual([
      255, 245, 0,
    ]);
    const again = await runner.actions.run("media.paged.image/invert", {
      bytes: new Uint8Array([0, 10, 255]),
      mediaType: "image/x-gray",
    });
    expect(again).toMatchObject({ cached: true, key: first.key });
    expect(calls).toBe(1);
    const other = await runner.actions.run("media.paged.image/invert", asset, {
      strength: 0,
    });
    expect(other.cached).toBe(false);
    expect(other.key.split(".")[0]).toBe(first.key.split(".")[0]);

    const chain = await runner.actions.runChain(
      [
        { action: "media.paged.image/invert" },
        { action: "media.paged.image/size" },
      ],
      asset,
    );
    expect(chain.output).toBe(3);
    await expect(
      runner.actions.runChain(
        [
          { action: "media.paged.image/size" },
          { action: "media.paged.image/invert" },
        ],
        asset,
      ),
    ).rejects.toThrow(/gives value, media.paged.image\/invert takes asset/);
  });

  it("the key is the same for equal inputs whatever their key order", async () => {
    const a = await actionKey({ b: 1, a: [1, 2] }, [
      { action: "x", params: { p: 1, q: 2 } },
    ]);
    const b = await actionKey({ a: [1, 2], b: 1 }, [
      { action: "x", params: { q: 2, p: 1 } },
    ]);
    expect(a).toBe(b);
  });

  it("the gate and the absent registry", async () => {
    const registry = createActionRegistry();
    const runner = host(RUNNER, undefined, registry);
    expect(() =>
      runner.actions.register({
        id: "x",
        title: "x",
        input: "value",
        output: "value",
        run: (v) => v,
      }),
    ).toThrow(PluginCapabilityError);
    await expect(
      host(PAINTER, undefined, registry).actions.run("x", 1),
    ).rejects.toBeInstanceOf(PluginCapabilityError);
    const lone = host(RUNNER);
    expect(lone.supports("actions@1")).toBe(false);
    expect(lone.actions.list()).toEqual([]);
    await expect(lone.actions.run("x", 1)).rejects.toThrow(
      /no action registry/,
    );
  });
});
