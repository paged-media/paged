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

// Module content a headless session cannot draw as the editor does (editor
// plan G4): a web frame is baked to native items for every PDF the CLI
// writes and the bake is taken back afterwards; an object a module marks
// `pending` is reported (src/module-content.ts).

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PagedBundle } from "@paged-media/plugin-api";
import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../../platform/extensions/packages/plugin-sdk/test/fixtures/minimal-idml";
import {
  pendingContent,
  pendingLine,
  withModuleContentDrawn,
} from "../src/module-content";
import { openSession } from "../src/session";
import { cli, engineOptions, REPO_ROOT, silent, tempDir } from "./helpers";

const WEB = join(REPO_ROOT, "modules/web/packages/web-bundle/src/index.ts");
// The bake renders with paged.web's engine wasm; without it the web cases
// say so and skip.
const BUILT = existsSync(
  join(REPO_ROOT, "modules/web/packages/web-bundle/bin/blitz_web_bg.wasm"),
);

let tmp: ReturnType<typeof tempDir>;
let docPath = "";

beforeAll(async () => {
  tmp = tempDir();
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    await h.load(minimalIdml());
    const { webBundle } = (await import(WEB)) as { webBundle: PagedBundle };
    h.loadBundle(webBundle);
    await h.objects.invoke("media.paged.web.command.insertWebFrame", {
      page: "page:#1",
      bounds: [10, 10, 120, 300],
      html: "<p>Baked for the PDF</p>",
      css: "p { color: navy; }",
    });
    const { bytes } = await h.exportDocument("paged");
    docPath = join(tmp.dir, "web.paged");
    writeFileSync(docPath, bytes);
  } finally {
    h.dispose();
  }
}, 60_000);
afterAll(() => tmp.done());

describe.skipIf(!BUILT)(
  `web frames in a headless PDF${BUILT ? "" : " (unavailable: the web engine wasm, moon run web:wasm)"}`,
  () => {
    it("bakes every web frame for the PDF and takes the bake back", async () => {
      const s = await openSession(docPath, { plugins: [WEB] });
      try {
        const items = async () =>
          (await s.h.objects.query("textFrame")).length +
          (await s.h.objects.query("rectangle")).length;
        const before = await items();
        let during = 0;
        const { notes } = await withModuleContentDrawn(s, async () => {
          during = await items();
        });
        expect(notes[0]).toBe(
          "baked 1 web frame(s) to native items for the PDF",
        );
        // The bake made native items for the export, and they are gone after.
        expect(during).toBeGreaterThan(before);
        expect(await items()).toBe(before);
      } finally {
        s.dispose();
      }
    }, 60_000);

    it("export -o x.pdf says what it baked", async () => {
      const out = join(tmp.dir, "web.pdf");
      const r = await cli(["export", docPath, "-o", out, `--plugins=${WEB}`]);
      expect(r.code, r.out + r.err).toBe(0);
      expect(JSON.stringify(r.json)).toContain(
        "baked 1 web frame(s) to native items for the PDF",
      );
    }, 60_000);
  },
);

describe("pending module content", () => {
  it("reports a module object marked pending", async () => {
    // A stand-in object model: one module kind with a `pending` row.
    const rows: Record<string, boolean> = {
      "plugin:media.paged.image/image/a": true,
      "plugin:media.paged.image/image/b": false,
    };
    const h = {
      objects: {
        kinds: async () => [
          { kind: "textFrame", owner: "core" },
          { kind: "image", owner: "media.paged.image" },
          { kind: "sheet", owner: "media.paged.sheet" },
        ],
        query: async (kind: string) =>
          kind === "image"
            ? Object.keys(rows)
            : kind === "sheet"
              ? ["plugin:media.paged.sheet/sheet/s"]
              : [],
        schema: async (a: string) =>
          a.includes("/image/") ? [{ path: "pending" }] : [{ path: "name" }],
        get: async (a: string) => ({ kind: "value", value: rows[a] }),
      },
    };
    const pending = await pendingContent({ h } as never);
    expect(pending).toEqual(["plugin:media.paged.image/image/a"]);
    expect(pendingLine(pending[0]!)).toContain("needs a GPU host");
  });
});
