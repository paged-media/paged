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

// The protocol-69 doors (core ADR 127): the document-scoped plugin label.
//   · setDocumentMetadata derives the key, names the caller, rides mutate;
//   · getDocumentMetadata reads only this plugin's entry from DocumentMeta,
//     and answers null on an engine that predates the field;
//   · the raw-mutate namespace gate covers setDocumentMetadata, also inside
//     a batch.

import { describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const MANIFEST: PluginManifest = {
  id: "media.paged.data",
  name: "data",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad", write: "broad" } },
};
const KEY = "x-paged:media.paged.data";

function host() {
  const fake = makeFakeEditor();
  const { host: h } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
  return { host: h, fake };
}

describe("document.documentMetadata (protocol 69)", () => {
  it("is advertised", () => {
    expect(host().host.supports("document.documentMetadata@1")).toBe(true);
  });

  it("setDocumentMetadata writes the derived key, the envelope and the caller", async () => {
    const { host: h, fake } = host();
    const out = await h.document.setDocumentMetadata({ v: 1, data: { parts: "a1" } });
    expect(out.applied).toBe(true);
    expect(fake.mutations).toEqual([
      {
        op: "setDocumentMetadata",
        args: { key: KEY, value: '{"v":1,"data":{"parts":"a1"}}', caller: "media.paged.data" },
      },
    ]);
  });

  it("setDocumentMetadata(null) clears", async () => {
    const { host: h, fake } = host();
    await h.document.setDocumentMetadata(null);
    expect((fake.mutations[0] as { args: { value: unknown } }).args.value).toBeNull();
  });

  it("getDocumentMetadata reads only this plugin's entry", async () => {
    const { host: h, fake } = host();
    fake.setDocumentMeta({
      pageCount: 1,
      pluginMetadata: [
        { key: "x-paged:media.paged.web", value: '{"v":1,"data":{"theirs":true}}' },
        { key: KEY, value: '{"v":2,"data":{"mine":true}}' },
      ],
    });
    expect(await h.document.getDocumentMetadata()).toEqual({ v: 2, data: { mine: true } });
  });

  it("getDocumentMetadata is null when absent and on a pre-69 engine", async () => {
    const { host: h, fake } = host();
    expect(await h.document.getDocumentMetadata()).toBeNull();
    fake.setDocumentMeta({ pageCount: 1, pluginMetadata: [] });
    expect(await h.document.getDocumentMetadata()).toBeNull();
  });

  it("a raw setDocumentMetadata outside the namespace is refused, also in a batch", async () => {
    const { host: h, fake } = host();
    const foreign = { op: "setDocumentMetadata", args: { key: "x-paged:media.paged.web", value: "{}" } };
    const direct = await h.document.mutate(foreign as never);
    expect(direct.applied).toBe(false);
    expect(String((direct as { error: unknown }).error)).toMatch(/outside this plugin's namespace/);
    const batched = await h.document.mutate({ op: "batch", args: { ops: [foreign] } } as never);
    expect(batched.applied).toBe(false);
    expect(fake.mutations).toHaveLength(0);
  });
});
