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

// paged.pdf's template field kind (editor plan G3a, engine ADR 1003) on the
// real headless host and the real engine: an author makes a frame that
// places a three-page PDF a `media.paged.pdf.page` field, the session takes
// the filler role, and the field is read and written through
// `host.objects` as the editor's form and `paged-node template fill` do.
// The page is checked against the PDF's page count; the engine checks the
// write against the role, so the field's own frame passes and another
// frame is refused.

import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";
import type { ObjectValue, TemplateFieldRef } from "@paged-media/plugin-api";
import { buildFixtureIdml, rect } from "@paged-media/test-kit";

import manifest from "../../manifest.json";
import { pdfBundle } from "../../src/activate";
import { PDF_PAGE_FIELD, PDF_TEMPLATE_FIELDS } from "../../src/template-fields";
import { tinyPdf } from "../fixtures/tiny-pdf";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const v = (x: ObjectValue): unknown => (x.kind === "value" ? x.value : x);

/** A picture frame placing `pdf` as its embedded contents. */
function pdfFrame(self: string, top: number, pdf: Uint8Array): string {
  const frame = rect(self, [top, 72, top + 200, 272]);
  const contents = Buffer.from(pdf).toString("base64");
  return frame.replace(
    "</Rectangle>",
    `<Image Self="${self}-img" ItemTransform="0.25 0 0 0.25 72 ${top}">` +
      `<Properties><Contents><![CDATA[${contents}]]></Contents></Properties>` +
      `</Image></Rectangle>`,
  );
}

const PDF = tinyPdf([["Page one"], ["Page two"], ["Page three"]]);

let h: HeadlessHost;

beforeEach(async () => {
  h = await createHeadlessHost({ resolveFrom: ENGINE_ANCHOR });
  h.loadBundle(pdfBundle);
  await h.load(
    buildFixtureIdml({
      name: "pdf-page",
      pages: [
        {
          id: "p1",
          items: [
            pdfFrame("cover", 72, PDF),
            pdfFrame("other", 320, PDF),
            rect("plain", [560, 72, 640, 272]),
          ],
        },
      ],
    }),
  );
}, 60_000);
afterEach(() => h.dispose());

const send = (kind: string, payload: unknown) =>
  h.host.editor.client.send({ kind, payload } as never) as Promise<{
    kind: string;
    payload: Record<string, unknown>;
  }>;

/** Make `frame` a page field (as the author) and take the filler role;
 *  answers the field as the template lists it. */
async function template(
  frame: string,
  def: unknown,
): Promise<TemplateFieldRef> {
  expect(
    (await send("setSessionPolicy", { policy: { role: "author" } })).kind,
  ).toBe("sessionPolicyApplied");
  const field = {
    v: 1,
    data: {
      field: {
        name: "page",
        kind: "module",
        module: { kind: PDF_PAGE_FIELD, grants: ["image.replace"], def },
      },
    },
  };
  const out = await send("mutate", {
    op: "setPluginMetadata",
    args: {
      elementId: { kind: "rectangle", id: frame },
      key: "x-paged:template",
      value: JSON.stringify(field),
    },
  });
  expect(out.kind).toBe("mutationApplied");
  expect(
    (await send("setSessionPolicy", { policy: { role: "filler" } })).kind,
  ).toBe("sessionPolicyApplied");
  const rows = (await h.host.editor.client.collection(
    "templateFields" as never,
  )) as {
    field: { name: string; module?: { kind: string; def: unknown } };
    targetId: string;
  }[];
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  return {
    name: row.field.name,
    targetId: row.targetId,
    kind: row.field.module!.kind,
    def: row.field.module!.def,
  };
}

describe("[plugin-pdf.object-model] the PDF page template field", () => {
  it("is declared in the manifest and listed with its control and grants", async () => {
    expect(manifest.contributes.objectModel.templateFields).toEqual(
      PDF_TEMPLATE_FIELDS.map((f) => ({ ...f })),
    );
    const kinds = (await h.objects.templateFieldKinds()).filter(
      (k) => k.owner === "media.paged.pdf",
    );
    expect(kinds.map((k) => [k.kind, k.control.kind, k.grants])).toEqual([
      [PDF_PAGE_FIELD, "number", ["image.replace"]],
    ]);
  });

  it("a filler reads the page as 1 of 3 and writes page 2, one undo step", async () => {
    const field = await template("cover", null);
    expect(v(await h.objects.get("rectangle:cover", "pdfPageCount"))).toBe(3);
    expect(await h.objects.readTemplateField(field)).toEqual({
      control: { kind: "number", min: 1, max: 3, step: 1 },
      value: 1,
    });
    expect(await h.objects.writeTemplateField(field, 2)).toEqual({ ok: true });
    expect(v(await h.objects.get("rectangle:cover", "framePdfPage"))).toBe(2);
    expect((await h.objects.readTemplateField(field)).value).toBe(2);
    // The editor's undo (the bundle itself declares no document write).
    expect(
      (await h.host.editor.client.send({ kind: "undo" } as never)).kind,
    ).toBe("undoApplied");
    expect(v(await h.objects.get("rectangle:cover", "framePdfPage"))).toBe(
      null,
    );
  });

  it("refuses a page past the PDF's last, and one that is no page", async () => {
    const field = await template("cover", { frame: "rectangle:cover" });
    expect(await h.objects.writeTemplateField(field, 4)).toEqual({
      ok: false,
      problem: "The PDF has 3 pages; there is no page 4.",
    });
    for (const bad of [0, 1.5, "two"]) {
      expect(await h.objects.writeTemplateField(field, bad)).toEqual({
        ok: false,
        problem: "The page must be a whole number of at least 1.",
      });
    }
    expect(v(await h.objects.get("rectangle:cover", "framePdfPage"))).toBe(
      null,
    );
  });

  it("offers the pages a definition allows as a choice", async () => {
    const field = await template("cover", {
      allowed: [1, { value: 3, label: "Back" }],
    });
    expect(await h.objects.readTemplateField(field)).toEqual({
      control: {
        kind: "choice",
        options: [{ value: "1" }, { value: "3", label: "Back" }],
      },
      value: "1",
    });
    expect(await h.objects.writeTemplateField(field, "2")).toEqual({
      ok: false,
      problem: "Page 2 is not one of the pages this field allows.",
    });
    expect(await h.objects.writeTemplateField(field, "3")).toEqual({
      ok: true,
    });
    expect(v(await h.objects.get("rectangle:cover", "framePdfPage"))).toBe(3);
  });

  it("the engine refuses the page of a frame the field is not on", async () => {
    const field = await template("cover", null);
    const out = await h.objects.writeTemplateField(
      { ...field, targetId: "other" },
      2,
    );
    expect(out.ok).toBe(false);
    expect(!out.ok && out.problem).toContain("image.replace");
    expect(v(await h.objects.get("rectangle:other", "framePdfPage"))).toBe(
      null,
    );
  });

  it("a frame that places no PDF answers a problem", async () => {
    const field = await template("plain", null);
    expect((await h.objects.readTemplateField(field)).value).toBe(null);
    expect(await h.objects.writeTemplateField(field, 1)).toEqual({
      ok: false,
      problem: "Frame plain does not place a PDF.",
    });
  });
});
