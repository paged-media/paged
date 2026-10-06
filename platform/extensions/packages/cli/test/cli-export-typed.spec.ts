/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// @feat: plugin-platform.object-model.node-cli
//
// ADR 323 §21.8 / ADR 324 — `paged export --format pdf` through a TYPED
// exporter command passes only the options the user named; `invoke` fills
// the struct's defaults. Two lanes:
//   · a fixture exporter (always) that echoes the args it received;
//   · the real paged.publish bundle, when PAGED_PUBLISH_BUNDLE names its
//     built module (a packed @paged-media/publish dist/index.js) —
//     REQUIRE_REAL_PUBLISH=1 makes its absence a failure.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cli, FIXTURES, tempDir, writeFixture } from "./helpers";

const PDFX = `--plugins=${join(FIXTURES, "pdf-exporter-plugin.ts")}`;

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
});
afterAll(() => tmp.done());

describe("export pdf through a typed exporter (fixture)", () => {
  it("passes only the named options; the struct's defaults fill the rest", async () => {
    const out = join(tmp.dir, "partial.pdf");
    const r = await cli(["export", fx.paged, "--format", "pdf", "--pages", "1-2", "--option", "cropMarks=true", "-o", out, PDFX]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ via: "acme.pdfx.exportPdf", options: { pages: "1-2", cropMarks: true } });
    // The CLI sent ONLY those two …
    expect(Object.keys(r.json.options).sort()).toEqual(["cropMarks", "pages"]);
    // … and the plugin received the defaults too; the optional title stays absent.
    const seen = JSON.parse(readFileSync(out, "latin1").replace(/^%PDF-fake /, ""));
    expect(seen).toEqual({ standard: "pdf17", pages: "1-2", cropMarks: true, bleed: [], effectDpi: 300 });
  });

  it("types each option by its field, and names the fields on a miss (exit 2)", async () => {
    const out = join(tmp.dir, "x.pdf");
    const ok = await cli(["export", fx.paged, "-o", out, "--option", "bleed=[9,0,0,0]", "--option", "title=Report", PDFX]);
    expect(ok.code).toBe(0);
    const seen = JSON.parse(readFileSync(out, "latin1").replace(/^%PDF-fake /, ""));
    expect(seen.title).toBe("Report");
    expect(seen.bleed).toEqual([9, 0, 0, 0]);
    const unknown = await cli(["export", fx.paged, "-o", out, "--option", "dpi=300", PDFX]);
    expect(unknown.code).toBe(2);
    expect(unknown.json.error.message).toMatch(/no option "dpi" — options: standard, pages, cropMarks, bleed, effectDpi, title/);
    const bad = await cli(["export", fx.paged, "-o", out, "--pdf-standard", "pdfa", PDFX]);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/expected enum \(pdf17 \| pdfx4\)/);
  });

  it("--core keeps core's door; --option without a typed exporter is a usage error", async () => {
    const out = join(tmp.dir, "core.pdf");
    const core = await cli(["export", fx.paged, "-o", out, "--core", PDFX]);
    expect(core.code).toBe(0);
    expect(core.json.via).toBeUndefined();
    expect(readFileSync(out).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const r = await cli(["export", fx.paged, "-o", out, "--option", "title=x", "--no-plugins"]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/--option needs a typed exporter/);
  });
});

const PUBLISH = process.env["PAGED_PUBLISH_BUNDLE"];
if (process.env["REQUIRE_REAL_PUBLISH"] === "1" && !(PUBLISH && existsSync(PUBLISH))) {
  throw new Error("REQUIRE_REAL_PUBLISH=1 but PAGED_PUBLISH_BUNDLE does not name a built @paged-media/publish module");
}

describe.runIf(PUBLISH && existsSync(PUBLISH))("export pdf through paged.publish's exportPdf (real bundle)", () => {
  it("a partial option set renders a real PDF", async () => {
    const out = join(tmp.dir, "publish.pdf");
    const r = await cli(["export", fx.paged, "--format", "pdf", "--pages", "1", "--option", "title=Partial", "-o", out, `--plugins=${PUBLISH}`]);
    expect(r.err).toBe("");
    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(r.json).toMatchObject({ via: "media.paged.publish.exportPdf", options: { pages: "1", title: "Partial" }, pageCount: 1 });
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("Partial");
  });
});
