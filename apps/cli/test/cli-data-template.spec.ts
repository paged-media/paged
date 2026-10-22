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

// `paged template` over paged.data's module fields (plan G3): a rectangle
// whose stroke weight is bound to a query, and a record field that chooses
// which record fills it — filled from the command line as a filler, read
// back from the saved file (the choice is saved with the data session) and
// checked against the template. The CLI loads @paged-media/data itself.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { openSession } from "../src/session";
import { cli, tempDir, writeFixture } from "./helpers";

const D = "media.paged.data";
const MM = 72 / 25.4;
const CSV = "sku,weight_mm,name\nA-1,2,Alpha\nB-2,4,Beta\nC-3,6,Gamma\n";

let tmp: ReturnType<typeof tempDir>;
let templatePath = "";

/** The template: the fixture's rectangle `urect`, its stroke weight bound
 *  to `weight_mm` of query `q`, and the `product` record field on it
 *  (labelled by `name`), granting the stroke. */
async function writeTemplate(dir: string): Promise<string> {
  const fx = await writeFixture(dir);
  const s = await openSession(fx.idml, {});
  try {
    const objects = s.h.objects;
    await objects.invoke(`${D}.defineSource` as never, {
      name: "products",
      csv: CSV,
    });
    const q = await objects.batch([
      {
        op: "create",
        kind: `plugin:${D}/query`,
        handle: "q",
        props: { sql: "SELECT * FROM products ORDER BY sku" },
      },
    ]);
    expect(q.applied, q.reason).toBe(true);
    const bound = (await objects.invoke(`${D}.defineProperty` as never, {
      id: "weight",
      selector: "rectangle:urect",
      path: "frameStrokeWeight",
      query: "q",
      expr: "MM(weight_mm)",
    })) as { ok: boolean; reason?: string };
    expect(bound.ok, bound.reason).toBe(true);
    await objects.invoke(`${D}.apply` as never, { record: 0 });
    const send = (kind: string, payload: unknown) =>
      s.driver.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
      }>;
    await send("setSessionPolicy", { policy: { role: "author" } });
    const labelled = await send("mutate", {
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "rectangle", id: "urect" },
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: {
              name: "product",
              kind: "module",
              module: {
                kind: `${D}.record`,
                grants: ["appearance.stroke"],
                def: { query: "q", label: "name" },
              },
            },
          },
        }),
      },
    });
    expect(labelled.kind).toBe("mutationApplied");
    const path = join(dir, "card.paged");
    await s.save(path);
    return path;
  } finally {
    s.dispose();
  }
}

const byName = (json: {
  fields: { field: { name: string }; value: unknown }[];
}) => Object.fromEntries(json.fields.map((f) => [f.field.name, f.value]));

async function strokeOf(path: string): Promise<number> {
  const r = await cli(["get", path, "rectangle:urect", "frameStrokeWeight"]);
  return r.json.value as number;
}

describe("paged template — data fields", () => {
  beforeAll(async () => {
    tmp = tempDir();
    templatePath = await writeTemplate(tmp.dir);
  });
  afterAll(() => tmp?.done());

  it("lists the data module's field kinds", async () => {
    const r = await cli(["template", "kinds"]);
    expect(r.code).toBe(0);
    expect(
      (r.json.kinds as { kind: string }[])
        .map((k) => k.kind)
        .filter((k) => k.startsWith(D)),
    ).toEqual([
      `${D}.record`,
      `${D}.bindingValue`,
      `${D}.dataSet`,
      `${D}.variable`,
    ]);
  });

  it("fills the record field as a filler; the saved file shows and names the record", async () => {
    const before = await cli(["template", "fields", templatePath]);
    expect(byName(before.json)).toEqual({ product: null });
    const out = join(tmp.dir, "filled.paged");
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify([
        { name: "product", value: { kind: "module", value: "3" } },
      ]),
      "-o",
      out,
    ]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(await strokeOf(out)).toBeCloseTo(6 * MM, 5);
    const got = await cli(["template", "fields", out]);
    expect(byName(got.json)).toEqual({
      product: { kind: "module", value: "3" },
    });
  });

  // `template check` compares every readable row, derived ones included:
  // the query's `recordCount` (what this session ingested) is 3 after the
  // refill and 0 in the reopened submission, though the documents agree.
  // Passes (as failing) until check skips `access: "derived"` rows.
  it.failing("checks a filled record field clean", async () => {
    const out = join(tmp.dir, "checked.paged");
    await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify([
        { name: "product", value: { kind: "module", value: "2" } },
      ]),
      "-o",
      out,
    ]);
    const check = await cli(["template", "check", templatePath, out]);
    expect(check.json.differences).toEqual([]);
  });

  it("refuses a record the query does not have, and writes nothing", async () => {
    const out = join(tmp.dir, "never.paged");
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify([
        { name: "product", value: { kind: "module", value: "9" } },
      ]),
      "-o",
      out,
    ]);
    expect(r.code).toBe(1);
    expect(r.json.error.problems).toEqual([
      { name: "product", problem: '"9" is not a record of "q" (1 to 3).' },
    ]);
    expect(existsSync(out)).toBe(false);
  });
});
