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

// @feat: plugin-platform.object-model
//
// Template field kinds (G1): a module contributes the parts of its content
// a template can open, through `contribute.objectModel`; `host.objects`
// lists them and routes a field's read and write to the module.

import { afterEach, describe, expect, it } from "bun:test";

import type {
  PagedBundle,
  PluginManifest,
  TemplateFieldRef,
} from "@paged-media/plugin-api";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { silentConsole as silent } from "../src/testing";
import { minimalIdml } from "./fixtures/minimal-idml";

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

const manifest = (declared: boolean): PluginManifest => ({
  id: "acme.price",
  name: "Price list",
  version: "1.0.0",
  apiVersion: "^0.2.0",
  capabilities: { document: { read: "broad", write: "broad" } },
  contributes: {
    objectModel: {
      kinds: [],
      ...(declared
        ? { templateFields: [{ kind: "acme.price.cell", title: "Price" }] }
        : {}),
    },
  },
});

function priceBundle(
  values: Map<string, string>,
  declared = true,
  kind = "acme.price.cell",
): PagedBundle {
  return {
    manifest: manifest(declared),
    activate(host) {
      return host.contribute.objectModel({
        kinds: [],
        templateFields: [
          {
            kind,
            title: "Price",
            control: { kind: "number", min: 0 },
            grants: ["text.edit"],
            read: (_ctx, field) => values.get(ref(field)) ?? null,
            write(_ctx, field, value) {
              if (typeof value !== "number" || value < 0)
                return { ok: false, problem: "not a price" };
              values.set(ref(field), value.toFixed(2));
              return { ok: true };
            },
          },
        ],
      });
    },
  };
}

const ref = (f: TemplateFieldRef) =>
  `${f.targetId}:${(f.def as { cell: string }).cell}`;

const field: TemplateFieldRef = {
  name: "price",
  targetId: "u1",
  kind: "acme.price.cell",
  def: { cell: "B4" },
};

describe("template field kinds", () => {
  it("are listed, read and written through host.objects", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    const values = new Map([["u1:B4", "12.50"]]);
    const bundle = h.loadBundle(priceBundle(values));

    expect(await h.objects.templateFieldKinds()).toEqual([
      {
        kind: "acme.price.cell",
        title: "Price",
        owner: "acme.price",
        control: { kind: "number", min: 0 },
        grants: ["text.edit"],
      },
    ]);
    expect(await h.objects.readTemplateField(field)).toEqual({
      control: { kind: "number", min: 0 },
      value: "12.50",
    });
    expect(await h.objects.writeTemplateField(field, 9)).toEqual({ ok: true });
    expect(values.get("u1:B4")).toBe("9.00");
    expect(await h.objects.writeTemplateField(field, -1)).toEqual({
      ok: false,
      problem: "not a price",
    });

    await expect(
      h.objects.readTemplateField({ ...field, kind: "acme.other.cell" }),
    ).rejects.toThrow(/unknownFieldKind/);

    bundle.dispose();
    expect(await h.objects.templateFieldKinds()).toEqual([]);
  });

  it("must be declared in the manifest and namespaced under the module's id", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    expect(() => h.loadBundle(priceBundle(new Map(), false))).toThrow(
      /templateFields\[\] must include "acme.price.cell"/,
    );
  });
});
