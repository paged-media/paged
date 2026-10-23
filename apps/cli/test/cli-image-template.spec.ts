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

// `paged template` over a paged.image field (plan G3): a card whose
// rectangle holds an image, its picture a `media.paged.image.picture`
// field, filled through `paged-node template fill` with a `{ "$file" }`
// value and the image bundle loaded from the workspace, as a filler.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../../platform/extensions/packages/plugin-sdk/test/fixtures/minimal-idml";
import { cli, engineOptions, silent, tempDir } from "./helpers";

const IMAGE_ENTRY = fileURLToPath(
  new URL("../../../modules/image/glue/src/index.ts", import.meta.url),
);
const IMAGE = `--plugins=${IMAGE_ENTRY}`;
const PICTURE = "media.paged.image.picture";

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A w×h PNG of one RGBA colour. */
function png(w: number, h: number, rgba: number[]): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(rgba, y * (1 + w * 4) + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let tmp: ReturnType<typeof tempDir>;
let templatePath = "";
let redPath = "";

/** The minimal document with a grey image in `urect`, whose picture is
 *  the `photo` field. */
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
    const placed = await h.host.document.mutate({
      op: "replaceImageBytes",
      args: {
        elementId: "urect",
        bytes: Array.from(png(4, 4, [128, 128, 128, 255])),
      },
    } as never);
    if (!placed.applied) throw new Error("image refused");
    const field = await send("mutate", {
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "rectangle", id: "urect" },
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: {
              name: "photo",
              kind: "module",
              module: { kind: PICTURE, grants: ["image.replace"], def: {} },
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

/** The image a .paged document places in `urect`. */
async function placedSha(path: string): Promise<string> {
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    await h.load(new Uint8Array(readFileSync(path)));
    return sha((await h.host.assets.getPlacedImage("urect"))!.bytes);
  } finally {
    h.dispose();
  }
}

const photoOf = (json: {
  fields: { field: { name: string }; value: unknown }[];
}) => json.fields.find((f) => f.field.name === "photo")?.value;

beforeAll(async () => {
  tmp = tempDir();
  templatePath = await writeTemplate(tmp.dir);
  redPath = join(tmp.dir, "red.png");
  writeFileSync(redPath, png(4, 4, [255, 0, 0, 255]));
});
afterAll(() => tmp.done());

describe("paged template — a paged.image picture field", () => {
  it("reads the picture's layer and whether its composite is pending", async () => {
    const r = await cli(["template", "fields", templatePath, IMAGE]);
    expect(r.code, r.err).toBe(0);
    expect(photoOf(r.json)).toEqual({
      kind: "module",
      value: { name: "Background", pending: false },
    });
  });

  it("fills it from a file as a filler: the frame shows the new picture", async () => {
    const out = join(tmp.dir, "filled.paged");
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify([{ name: "photo", value: { $file: redPath } }]),
      "-o",
      out,
      IMAGE,
    ]);
    expect(r.code, r.err).toBe(0);
    expect(await placedSha(out)).not.toBe(await placedSha(templatePath));
    const got = await cli(["template", "fields", out, IMAGE]);
    expect(photoOf(got.json)).toEqual({
      kind: "module",
      value: { name: "Background", pending: false },
    });
  });

  it("refuses a file that is not an image, and writes nothing", async () => {
    const bad = join(tmp.dir, "not-an-image.png");
    writeFileSync(bad, "plain text");
    const out = join(tmp.dir, "never.paged");
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify([{ name: "photo", value: { $file: bad } }]),
      "-o",
      out,
      IMAGE,
    ]);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.out || r.err) as {
      error: { problems: { name: string; problem: string }[] };
    };
    expect(err.error.problems[0]!.name).toBe("photo");
    expect(err.error.problems[0]!.problem).toContain("does not decode");
    expect(existsSync(out)).toBe(false);
  });
});
