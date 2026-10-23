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

/** A document tagged the way an InDesign template is (engine ADR 1002): a
 *  text frame's story tagged `Letter`, "Ada" in it tagged `Name` (labelled),
 *  and a graphic frame tagged `Photo`, saved as IDML. */
async function writeTagged(dir: string): Promise<string> {
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    const send = (kind: string, payload: unknown) =>
      h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
        payload: { createdId?: { id: string } };
      }>;
    const [pageId] = await h.load(minimalIdml());
    await send("setSessionPolicy", { policy: { role: "author" } });
    const mutate = (m: unknown) => send("mutate", m);
    const text = await mutate({
      op: "insertTextFrame",
      args: { pageId, bounds: [10, 10, 60, 200] },
    });
    const photo = await mutate({
      op: "insertFrame",
      args: { pageId, bounds: [80, 10, 140, 120] },
    });
    const stories = (await h.host.editor.client.collection(
      "stories" as never,
    )) as { selfId: string }[];
    const storyId = stories[stories.length - 1]!.selfId;
    await mutate({
      op: "insertText",
      args: { storyId, offset: 0, text: "Dear Ada, welcome." },
    });
    await mutate({
      op: "tagItem",
      args: { item: text.payload.createdId!.id, tag: "Letter" },
    });
    await mutate({
      op: "tagRange",
      args: { storyId, start: 5, end: 8, tag: "Name", selfId: "dxName" },
    });
    await mutate({
      op: "setXmlAttribute",
      args: { element: "dxName", name: "label", value: "First name" },
    });
    await mutate({
      op: "tagItem",
      args: { item: photo.payload.createdId!.id, tag: "Photo" },
    });
    const { bytes } = await h.exportDocument("idml");
    const path = join(dir, "tagged.idml");
    writeFileSync(path, bytes);
    return path;
  } finally {
    h.dispose();
  }
}

describe("paged template ingest", () => {
  it("opens a tagged document as a template and writes it", async () => {
    const tagged = await writeTagged(tmp.dir);
    const out = join(tmp.dir, "ingested.paged");
    const r = await cli(["template", "ingest", tagged, "-o", out, NP]);
    expect(r.code).toBe(0);
    const rows = r.json.fields as {
      field: { name: string; kind: string; label?: string };
      value: unknown;
    }[];
    expect(rows.map((f) => [f.field.name, f.field.kind])).toEqual([
      ["Name", "textRun"],
      ["Photo", "image"],
    ]);
    expect(rows[0]!.field.label).toBe("First name");
    expect(rows[0]!.value).toEqual({ kind: "text", text: "Ada" });
    expect(r.json.skipped).toEqual([
      expect.objectContaining({
        tag: "Letter",
        reason: "its tagged ranges are the fields",
      }),
    ]);
    // The written template fills like any other.
    const filled = join(tmp.dir, "ingested-filled.paged");
    const fill = await cli([
      "template",
      "fill",
      out,
      "--values",
      JSON.stringify({ Name: "Grace" }),
      "-o",
      filled,
      NP,
    ]);
    expect(fill.code).toBe(0);
    const got = await cli(["template", "fields", filled, NP]);
    const name = (
      got.json.fields as { field: { name: string }; value: unknown }[]
    ).find((f) => f.field.name === "Name");
    expect(name?.value).toEqual({ kind: "text", text: "Grace" });
  });

  it("refuses a document with nothing tagged", async () => {
    const r = await cli([
      "template",
      "ingest",
      templatePath,
      "-o",
      join(tmp.dir, "never.paged"),
      NP,
    ]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("nothing in the document is a field");
  });
});
