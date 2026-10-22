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

// `paged template` over a paged.draw field (plan G3): a card whose
// rectangle's fill is a `media.paged.draw.paint` field, filled through
// `paged-node template fill` with the draw bundle loaded from the
// workspace, as a filler.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../../platform/extensions/packages/plugin-sdk/test/fixtures/minimal-idml";
import { cli, engineOptions, silent, tempDir } from "./helpers";

const DRAW_ENTRY = fileURLToPath(
  new URL(
    "../../../modules/draw/packages/draw-bundle/src/index.ts",
    import.meta.url,
  ),
);
const DRAW = `--plugins=${DRAW_ENTRY}`;
const PAINT = "media.paged.draw.paint";

let tmp: ReturnType<typeof tempDir>;
let templatePath = "";

/** The SDK's minimal document (rectangle `urect`) with two swatches and a
 *  `colour` field: the rectangle's fill, Red or Blue. */
async function writeTemplate(dir: string): Promise<string> {
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const send = (kind: string, payload: unknown) =>
      h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
      }>;
    await h.load(minimalIdml());
    await send("setSessionPolicy", { policy: { role: "author" } });
    for (const [selfId, value] of [
      ["Color/Red", [0, 100, 100, 0]],
      ["Color/Blue", [100, 60, 0, 0]],
      ["Color/Green", [80, 0, 100, 0]],
    ] as const) {
      const made = await send("mutate", {
        op: "createSwatch",
        args: {
          spec: { selfId, name: selfId.slice(6), space: "CMYK", value },
        },
      });
      if (made.kind !== "mutationApplied") throw new Error("swatch refused");
    }
    const field = await send("mutate", {
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "rectangle", id: "urect" },
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: {
              name: "colour",
              kind: "module",
              module: {
                kind: PAINT,
                grants: ["appearance.fill", "appearance.stroke"],
                def: { channel: "fill", allowed: ["Red", "Blue"] },
              },
            },
          },
        }),
      },
    });
    if (field.kind !== "mutationApplied") throw new Error("field refused");
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "card.paged");
    writeFileSync(path, bytes);
    return path;
  } finally {
    h.dispose();
  }
}

const valueOf = (json: {
  fields: { field: { name: string }; value: unknown }[];
}) => json.fields.find((f) => f.field.name === "colour")?.value;

beforeAll(async () => {
  tmp = tempDir();
  templatePath = await writeTemplate(tmp.dir);
});
afterAll(() => tmp.done());

describe("paged template — a paged.draw paint field", () => {
  it("lists the draw kinds when the bundle is loaded", async () => {
    const r = await cli(["template", "kinds", DRAW]);
    expect(r.code).toBe(0);
    expect((r.json.kinds as { kind: string }[]).map((k) => k.kind)).toEqual(
      expect.arrayContaining([
        PAINT,
        "media.paged.draw.graphicStyle",
        "media.paged.draw.textOnPath",
        "media.paged.draw.symbolChoice",
      ]),
    );
  });

  it("reads the field's value through the module", async () => {
    const r = await cli(["template", "fields", templatePath, DRAW]);
    expect(r.code).toBe(0);
    expect(valueOf(r.json)).toEqual({ kind: "module", value: "Color/Black" });
  });

  it("fills it as a filler, by name, and writes the result", async () => {
    const out = join(tmp.dir, "filled.paged");
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify([{ name: "colour", value: "Blue" }]),
      "-o",
      out,
      DRAW,
    ]);
    expect(r.code, r.err).toBe(0);
    const got = await cli(["template", "fields", out, DRAW]);
    expect(valueOf(got.json)).toEqual({ kind: "module", value: "Color/Blue" });
    const check = await cli(["template", "check", templatePath, out, DRAW]);
    expect(check.json.ok).toBe(true);
  });

  it("refuses a colour the field does not offer, and writes nothing", async () => {
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify([{ name: "colour", value: "Green" }]),
      "-o",
      join(tmp.dir, "never.paged"),
      DRAW,
    ]);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.out || r.err) as {
      error: { problems: { name: string; problem: string }[] };
    };
    expect(err.error.problems).toEqual([
      { name: "colour", problem: `"Green" is not one of this field's colours` },
    ]);
    expect(existsSync(join(tmp.dir, "never.paged"))).toBe(false);
  });
});
