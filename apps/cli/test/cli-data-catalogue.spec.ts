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

// A catalogue from the command line (paged.data ADR 560): a template whose
// text field `title` is bound to a query's `name` (saved with the data
// session), made into one page per record by `paged invoke …
// media.paged.data.runCatalogue`, and read back with `paged template
// fields`. The template's own constraint refuses a value from the command
// line too.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { openSession } from "../src/session";
import { cli, tempDir, writeFixture } from "./helpers";

const D = "media.paged.data";
const DATA = "--plugins=@paged-media/data";
const CSV = "sku,name\nA-1,Alpha\nB-2,Beta\nC-3,Gamma\n";

let tmp: ReturnType<typeof tempDir>;

/** The fixture's text frame as the text field `title` (at most
 *  `maxLength` characters), bound to `name` of query `q`. */
async function writeTemplate(
  dir: string,
  file: string,
  maxLength: number,
): Promise<string> {
  const fx = await writeFixture(dir);
  const s = await openSession(fx.paged, {});
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
    const send = (kind: string, payload: unknown) =>
      s.driver.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
      }>;
    await send("setSessionPolicy", { policy: { role: "author" } });
    const [frame] = await objects.query("textFrame");
    const labelled = await send("mutate", {
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "textFrame", id: frame!.split(":")[1] },
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: { name: "title", kind: "text", constraints: { maxLength } },
          },
        }),
      },
    });
    expect(labelled.kind).toBe("mutationApplied");
    const bound = (await objects.invoke(`${D}.bindTemplateField` as never, {
      field: "title",
      query: "q",
      expr: "name",
    })) as { ok: boolean; reason?: string };
    expect(bound.ok, bound.reason).toBe(true);
    const path = join(dir, file);
    await s.save(path);
    return path;
  } finally {
    s.dispose();
  }
}

const titles = (json: {
  fields: { field: { name: string }; value: { text?: string } | null }[];
}) =>
  json.fields
    .filter((f) => f.field.name === "title")
    .map((f) => f.value?.text ?? "")
    .sort();

describe("paged invoke media.paged.data.runCatalogue", () => {
  beforeAll(() => {
    tmp = tempDir();
  });
  afterAll(() => tmp?.done());

  it("makes one filled page per record; the saved file holds them", async () => {
    const template = await writeTemplate(tmp.dir, "card.paged", 20);
    const out = join(tmp.dir, "catalogue.paged");
    const r = await cli([
      "invoke",
      template,
      `${D}.runCatalogue`,
      "{}",
      "-o",
      out,
      DATA,
    ]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.result).toMatchObject({
      ok: true,
      instances: 3,
      records: 3,
      undoSteps: 2,
    });
    expect(
      (await cli(["query", out, "page", DATA])).json.addresses,
    ).toHaveLength(3);
    expect(titles((await cli(["template", "fields", out, DATA])).json)).toEqual(
      ["Alpha", "Beta", "Gamma"],
    );
  });

  it("refuses a value the template's field does not allow, and leaves the pages alone", async () => {
    const template = await writeTemplate(tmp.dir, "short.paged", 4);
    const out = join(tmp.dir, "never.paged");
    const r = await cli([
      "invoke",
      template,
      `${D}.runCatalogue`,
      '{"mode":"perRecord"}',
      "-o",
      out,
      DATA,
    ]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.result.ok).toBe(false);
    expect(r.json.result.problems).toEqual([
      { instance: "1", field: "title", problem: "longer than 4 characters" },
      { instance: "3", field: "title", problem: "longer than 4 characters" },
    ]);
    expect(existsSync(out)).toBe(true);
    expect(
      (await cli(["query", out, "page", DATA])).json.addresses,
    ).toHaveLength(1);
  });
});
