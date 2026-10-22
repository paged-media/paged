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

// `paged template` (plan task F6): fill and check templates on a server with
// the same engine messages the browser's form sends.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../../platform/extensions/packages/plugin-sdk/test/fixtures/minimal-idml";
import { cli, engineOptions, silent, tempDir } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
let templatePath = "";

const NP = "--no-plugins";

/** A card: `headline` (text, at most 20 characters, "Old title") and
 *  `badge` (visibility). */
async function writeTemplate(dir: string): Promise<string> {
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const send = (kind: string, payload: unknown) =>
      h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
        payload: { createdId?: unknown };
      }>;
    const [pageId] = await h.load(minimalIdml());
    await send("setSessionPolicy", { policy: { role: "author" } });
    const mutate = (m: unknown) => send("mutate", m);
    const text = await mutate({
      op: "insertTextFrame",
      args: { pageId, bounds: [10, 10, 60, 200] },
    });
    const badge = await mutate({
      op: "insertFrame",
      args: { pageId, bounds: [80, 10, 100, 30] },
    });
    const policy = (name: string, kind: string, constraints = {}) =>
      JSON.stringify({ v: 1, data: { field: { name, kind, constraints } } });
    await mutate({
      op: "setPluginMetadata",
      args: {
        elementId: text.payload.createdId,
        key: "x-paged:template",
        value: policy("headline", "text", { maxLength: 20 }),
      },
    });
    await mutate({
      op: "setPluginMetadata",
      args: {
        elementId: badge.payload.createdId,
        key: "x-paged:template",
        value: policy("badge", "visibility"),
      },
    });
    const rows = (await h.host.editor.client.collection(
      "templateFields" as never,
    )) as {
      field: { name: string };
      storyId?: string;
    }[];
    const story = rows.find((r) => r.field.name === "headline")!.storyId!;
    await mutate({
      op: "insertText",
      args: { storyId: story, offset: 0, text: "Old title" },
    });
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "card.paged");
    writeFileSync(path, bytes);
    return path;
  } finally {
    h.dispose();
  }
}

beforeAll(async () => {
  tmp = tempDir();
  templatePath = await writeTemplate(tmp.dir);
});
afterAll(() => tmp.done());

describe("paged template", () => {
  it("lists the fields with their values", async () => {
    const r = await cli(["template", "fields", templatePath, NP]);
    expect(r.code).toBe(0);
    const byName = Object.fromEntries(
      (r.json.fields as { field: { name: string }; value: unknown }[]).map(
        (f) => [f.field.name, f.value],
      ),
    );
    expect(byName).toEqual({
      headline: { kind: "text", text: "Old title" },
      badge: { kind: "visible", visible: true },
    });
  });

  it("fills the template as a filler and writes the result", async () => {
    const out = join(tmp.dir, "filled.paged");
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify({ headline: "Ada Example", badge: false }),
      "-o",
      out,
      NP,
    ]);
    expect(r.code).toBe(0);
    const got = await cli(["template", "fields", out, NP]);
    const byName = Object.fromEntries(
      (got.json.fields as { field: { name: string }; value: unknown }[]).map(
        (f) => [f.field.name, f.value],
      ),
    );
    expect(byName).toEqual({
      headline: { kind: "text", text: "Ada Example" },
      badge: { kind: "visible", visible: false },
    });
  });

  it("writes a PDF straight from the filled template", async () => {
    const out = join(tmp.dir, "filled.pdf");
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify({ headline: "Print me" }),
      "-o",
      out,
      NP,
    ]);
    expect(r.code).toBe(0);
    expect(r.json.format).toBe("pdf");
    expect(r.json.bytes).toBeGreaterThan(500);
  });

  it("refuses values that do not fit, and writes nothing", async () => {
    const r = await cli([
      "template",
      "fill",
      templatePath,
      "--values",
      JSON.stringify({
        headline: "A headline much longer than twenty characters",
      }),
      "-o",
      join(tmp.dir, "never.paged"),
      NP,
    ]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("longer than the field allows");
  });

  it("checks a submission: its fields only, or a change the template did not allow", async () => {
    const filled = join(tmp.dir, "submitted.paged");
    expect(
      (
        await cli([
          "template",
          "fill",
          templatePath,
          "--values",
          '{"headline":"Ada"}',
          "-o",
          filled,
          NP,
        ])
      ).code,
    ).toBe(0);
    const ok = await cli(["template", "check", templatePath, filled, NP]);
    expect(ok.code).toBe(0);
    expect(ok.json.ok).toBe(true);

    // Tamper: an editor moves the badge in the submission.
    const tampered = join(tmp.dir, "tampered.paged");
    const moved = await cli([
      "set",
      filled,
      "rectangle:u2",
      "frameBounds",
      "[90, 10, 110, 30]",
      "-o",
      tampered,
      NP,
    ]);
    expect(moved.code).toBe(0);
    const bad = await cli(["template", "check", templatePath, tampered, NP]);
    expect(bad.code).toBe(1);
    expect(bad.json.ok).toBe(false);
    expect(
      (bad.json.differences as string[]).some((d) =>
        d.startsWith("rectangle:"),
      ),
    ).toBe(true);
  });
});
