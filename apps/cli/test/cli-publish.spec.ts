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

// @feat: plugin-platform.object-model.node-cli
//
// Plan G4, publish / pdf: `paged-node preflight` through paged.publish's
// typed preflight, and `paged-node package` (InDesign's File ▸ Package):
// the document as IDML with its links rebased into Links/, the linked
// files, the fonts it sets in (a face whose licence restricts embedding is
// reported, not copied), a report, and the document as .paged with the
// module content IDML cannot carry, as a folder or a .zip. The bundle is the
// workspace's paged.publish source; the fonts are the engine corpus's
// licence-clear faces.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { facesOf } from "../src/fonts";
import { openSession } from "../src/session";
import { cli, REPO_ROOT, tempDir, writeFixture } from "./helpers";

const NP = "--no-plugins";
const PUBLISH = `--plugins=${join(REPO_ROOT, "modules/publish/packages/publish-bundle/src/index.ts")}`;
const LORA = join(REPO_ROOT, "engine/core/corpus/fonts/Lora.ttf");
const RED = join(
  REPO_ROOT,
  "modules/data/conformance/indesign-merge/images/red.png",
);

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
/** The fixture, its story set in Lora and its rectangle linked to
 *  images/red.png beside it. */
let doc = "";

beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
  mkdirSync(join(tmp.dir, "images"));
  copyFileSync(RED, join(tmp.dir, "images", "red.png"));
  const lora = join(tmp.dir, "lora.paged");
  const set = await cli([
    "set",
    fx.paged,
    "story",
    "characterFontFamily",
    "Lora",
    "-o",
    lora,
    NP,
  ]);
  expect(set.code, set.out).toBe(0);
  doc = join(tmp.dir, "card.paged");
  const placed = await cli([
    "invoke",
    lora,
    "core.placeImage",
    '{"elementId":"rectangle:urect","uri":"images/red.png"}',
    "-o",
    doc,
    NP,
  ]);
  expect(placed.code, placed.out).toBe(0);
});
afterAll(() => tmp.done());

/** The entries of a ZIP (name → bytes), read from its central directory. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  while (end > 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLen),
    );
    const start =
      local +
      30 +
      v.getUint16(local + 26, true) +
      v.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(body)) : body);
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

/** A copy of Lora whose OS/2 fsType says Restricted Licence embedding. */
function restrictedLora(dir: string): string {
  const bytes = new Uint8Array(readFileSync(LORA));
  const v = new DataView(bytes.buffer);
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    if (String.fromCharCode(...bytes.subarray(r, r + 4)) === "OS/2")
      v.setUint16(v.getUint32(r + 8) + 8, 0x0002);
  }
  const path = join(dir, "Lora-restricted.ttf");
  writeFileSync(path, bytes);
  return path;
}

describe("paged-node preflight", () => {
  it("answers the exporter's findings through the typed preflight; a warning is not a failure", async () => {
    const r = await cli(["preflight", doc, PUBLISH]);
    expect(r.code, r.out).toBe(0);
    expect(r.json).toMatchObject({
      via: "media.paged.publish.preflight",
      ok: true,
      errors: 0,
      pageCount: 1,
    });
    // The corpus face is not registered: the exporter says Lora was
    // substituted.
    expect(
      (r.json.findings as { code: string; message: string }[]).some(
        (f) => f.code === "font_substituted" && f.message.includes("Lora"),
      ),
    ).toBe(true);
    const text = await cli(["preflight", doc, PUBLISH, "--text"]);
    expect(text.out).toMatch(/^ok: 0 error\(s\), \d+ warning\(s\) on 1 page/);
  });

  it("passes only the options given; a check that cannot run exits 1", async () => {
    const r = await cli(["preflight", doc, "--pages", "1", PUBLISH]);
    expect(r.code).toBe(0);
    expect(r.json.options).toEqual({ pages: "1" });
    const x4 = await cli([
      "preflight",
      doc,
      "--pdf-standard",
      "pdfx4",
      PUBLISH,
    ]);
    expect(x4.code).toBe(1);
    expect(x4.json.error.message).toMatch(/pdfx4 needs an outputIntentProfile/);
  });

  it("without paged.publish it says what is missing (exit 2)", async () => {
    const r = await cli(["preflight", doc, NP]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(
      /needs paged\.publish's typed preflight/,
    );
  });
});

describe("paged-node package", () => {
  it("a folder: the IDML with its link rebased, the linked file, the font, a PDF, instructions and a report", async () => {
    const out = join(tmp.dir, "pkg");
    const r = await cli([
      "package",
      doc,
      "-o",
      out,
      "--fonts",
      LORA,
      "--pdf",
      PUBLISH,
    ]);
    expect(r.code, r.out).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "Document fonts",
      "Instructions.txt",
      "Links",
      "card Report.txt",
      "card.idml",
      "card.paged",
      "card.pdf",
    ]);
    expect(readFileSync(join(out, "Links", "red.png"))).toEqual(
      readFileSync(RED),
    );
    expect(readFileSync(join(out, "Document fonts", "Lora.ttf"))).toEqual(
      readFileSync(LORA),
    );
    expect(r.json.links).toEqual([
      {
        fileName: "red.png",
        sourceUri: "images/red.png",
        status: "copied",
        from: join(tmp.dir, "images", "red.png"),
      },
    ]);
    expect(r.json.fonts).toEqual([
      {
        family: "Lora",
        status: "copied",
        files: [
          {
            file: "Lora.ttf",
            from: LORA,
            style: expect.any(String),
            embedding: "installable",
            copied: true,
          },
        ],
      },
    ]);
    expect(r.json.pdf.via).toBe("media.paged.publish.exportPdf");
    expect(readFileSync(join(out, "card.pdf")).subarray(0, 5).toString()).toBe(
      "%PDF-",
    );
    // The IDML's link points into the package, as InDesign spells it.
    const idml = unzip(readFileSync(join(out, "card.idml")));
    const spreads = [...idml]
      .filter(([n]) => n.startsWith("Spreads/"))
      .map(([, b]) => new TextDecoder().decode(b))
      .join("");
    expect(spreads).toContain(
      `LinkResourceURI="file:${join(out, "Links", "red.png")}"`,
    );
    const report = readFileSync(join(out, "card Report.txt"), "utf8");
    expect(report).toContain("Lora");
    expect(report).toMatch(/red\.png\s+copied/);
  });

  it("a restricted face is reported, not copied; a family no file answers for is missing", async () => {
    const restricted = restrictedLora(tmp.dir);
    expect(facesOf(restricted, readFileSync(restricted))[0]).toMatchObject({
      family: "Lora",
      embedding: "restricted",
    });
    const out = join(tmp.dir, "pkg-restricted");
    const r = await cli(["package", doc, "-o", out, "--fonts", restricted, NP]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.fonts[0]).toMatchObject({
      family: "Lora",
      status: "restricted",
      files: [{ file: "Lora-restricted.ttf", copied: false }],
    });
    expect(existsSync(join(out, "Document fonts"))).toBe(false);
    expect(readFileSync(join(out, "card Report.txt"), "utf8")).toContain(
      "licence restricts copying; not collected",
    );
    const none = await cli(["package", doc, "-o", join(tmp.dir, "p3"), NP]);
    expect(none.json.fonts).toEqual([
      { family: "Lora", status: "missing", files: [] },
    ]);
  });

  it("a .zip unpacks into <name>/ beside it, its links pointing there", async () => {
    const out = join(tmp.dir, "card-package.zip");
    const r = await cli(["package", doc, "-o", out, "--fonts", LORA, NP]);
    expect(r.code, r.out).toBe(0);
    const entries = unzip(readFileSync(out));
    expect([...entries.keys()].sort()).toEqual([
      "card-package/Document fonts/Lora.ttf",
      "card-package/Instructions.txt",
      "card-package/Links/red.png",
      "card-package/card Report.txt",
      "card-package/card.idml",
      "card-package/card.paged",
    ]);
    expect(entries.get("card-package/Links/red.png")).toEqual(
      new Uint8Array(readFileSync(RED)),
    );
    const idml = unzip(entries.get("card-package/card.idml")!);
    expect(
      [...idml].some(([, b]) =>
        new TextDecoder()
          .decode(b)
          .includes(join(tmp.dir, "card-package", "Links", "red.png")),
      ),
    ).toBe(true);
  });

  it("module content IDML cannot carry is in <name>.paged, and the report says so; --no-paged leaves it out", async () => {
    // A document with one module part, as a module's save writes it.
    const PART = "paged/media.example.module/o1/spec.json";
    const withPart = join(tmp.dir, "module.paged");
    const s = await openSession(doc, { plugins: [] });
    try {
      const w = (await s.driver.editor.client.send({
        kind: "writePagedPart",
        payload: {
          path: PART,
          bytes: [...new TextEncoder().encode('{"cells":1}')],
        },
      } as never)) as unknown as { kind: string };
      expect(w.kind).toBe("pagedPartWritten");
      await s.save(withPart);
    } finally {
      s.dispose();
    }

    const out = join(tmp.dir, "pkg-module");
    const r = await cli(["package", withPart, "-o", out, NP]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.paged).toBe(join(out, "module.paged"));
    expect(r.json.moduleParts).toEqual([PART]);
    const container = unzip(readFileSync(join(out, "module.paged")));
    expect(new TextDecoder().decode(container.get(PART))).toBe('{"cells":1}');
    // The IDML has no such part: the .paged is where it lives.
    expect(unzip(readFileSync(join(out, "module.idml"))).has(PART)).toBe(false);
    const report = readFileSync(join(out, "module Report.txt"), "utf8");
    expect(report).toContain(
      "Module content: 1 part(s), in module.paged (IDML does not carry them)",
    );
    expect(report).toContain(`  ${PART}`);
    expect(report).toContain("Paged document: module.paged");

    const bare = join(tmp.dir, "pkg-no-paged");
    const n = await cli(["package", withPart, "-o", bare, "--no-paged", NP]);
    expect(n.code, n.out).toBe(0);
    expect(n.json.paged).toBeNull();
    expect(existsSync(join(bare, "module.paged"))).toBe(false);
    expect(readFileSync(join(bare, "module Report.txt"), "utf8")).toContain(
      "Module content not carried by IDML: 1 part(s) (left out: --no-paged)",
    );
  });

  it("a link whose file is gone is reported missing; a folder with files in it is refused", async () => {
    const moved = join(tmp.dir, "elsewhere");
    mkdirSync(moved);
    copyFileSync(doc, join(moved, "card.paged"));
    const r = await cli([
      "package",
      join(moved, "card.paged"),
      "-o",
      join(tmp.dir, "pkg-missing"),
      NP,
    ]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.links[0]).toMatchObject({
      fileName: "red.png",
      status: "missing",
    });
    const full = await cli(["package", doc, "-o", moved, NP]);
    expect(full.code).toBe(2);
    expect(full.json.error.message).toMatch(/is not empty/);
  });
});
