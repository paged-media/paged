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

// paged.slide's template field kinds (editor plan G3a) on the real headless
// host and the real slide wasm: an author makes a placeholder or a slide a
// module field, the session takes the filler role, and the field is read
// and written through `host.objects` as the editor's form and
// `paged-node template fill` do. The engine checks every write against the
// role: the field's own placeholder passes, any other is refused.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";
import type { ObjectValue, TemplateFieldRef } from "@paged-media/plugin-api";

import slideBundle from "../../src/index";
import { IMPORT_PPTX_COMMAND } from "../../src/object-model";
import {
  PLACEHOLDER_TEXT_KIND,
  VISIBILITY_KIND,
} from "../../src/template-fields";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = new URL(
  "../../../../slide-conformance/fixtures/placeholders.pptx",
  import.meta.url,
);
const P = "plugin:media.paged.slide";
const v = (x: ObjectValue): unknown => (x.kind === "value" ? x.value : x);

let h: HeadlessHost;
let slides: string[];

beforeEach(async () => {
  h = await createHeadlessHost({ resolveFrom: ENGINE_ANCHOR });
  h.loadBundle(slideBundle);
  const out = (await h.objects.invoke(IMPORT_PPTX_COMMAND, {
    bytes: new Uint8Array(readFileSync(FIXTURE)),
    name: "placeholders.pptx",
  })) as { slides: string[] };
  slides = out.slides;
}, 60_000);
afterEach(() => h.dispose());

const send = (kind: string, payload: unknown) =>
  h.host.editor.client.send({ kind, payload } as never) as Promise<{
    kind: string;
    payload: Record<string, unknown>;
  }>;

/** The placeholder of `type` on slide `n` (1-based). */
async function placeholder(n: number, type: string): Promise<string> {
  const [a] = await h.objects.query(
    `${slides[n - 1]!} > ${P}/placeholder[type=${type}]`,
  );
  return a!;
}

const frameId = (address: string) => address.split("/").pop()!;

/** Make `frame` a module field (as the author), with the document-wide
 *  `defaults` given, and take the filler role; answers the field as the
 *  template lists it. */
async function template(
  frame: string,
  kind: string,
  def: unknown,
  grants: string[],
  defaults: string[] = [],
): Promise<TemplateFieldRef> {
  expect(
    (await send("setSessionPolicy", { policy: { role: "author" } })).kind,
  ).toBe("sessionPolicyApplied");
  const field = {
    v: 1,
    data: {
      field: { name: "part", kind: "module", module: { kind, grants, def } },
    },
  };
  const ops: unknown[] = [
    {
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "textFrame", id: frame },
        key: "x-paged:template",
        value: JSON.stringify(field),
      },
    },
  ];
  if (defaults.length > 0)
    ops.push({
      op: "setDocumentMetadata",
      args: {
        key: "x-paged:template",
        value: JSON.stringify({ v: 1, data: { defaults } }),
      },
    });
  expect((await send("mutate", { op: "batch", args: { ops } })).kind).toBe(
    "mutationApplied",
  );
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

describe("[plugin-slide.object-model] template field kinds", () => {
  it("the bundle lists its two kinds with their controls and grants", async () => {
    const kinds = (await h.objects.templateFieldKinds()).filter(
      (k) => k.owner === "media.paged.slide",
    );
    expect(kinds.map((k) => [k.kind, k.control.kind, k.grants])).toEqual([
      [PLACEHOLDER_TEXT_KIND, "text", ["text.edit"]],
      [VISIBILITY_KIND, "toggle", ["item.visibility"]],
    ]);
  });

  it("placeholderText on its own frame: a filler reads and writes it, one undo step, the run's look kept", async () => {
    const title = await placeholder(2, "title");
    const field = await template(frameId(title), PLACEHOLDER_TEXT_KIND, null, [
      "text.edit",
    ]);
    expect(field.targetId).toBe(frameId(title));
    const before = v(await h.objects.get(title, "content"));
    expect(await h.objects.readTemplateField(field)).toEqual({
      control: { kind: "text" },
      value: before,
    });
    expect(await h.objects.writeTemplateField(field, "Our results")).toEqual({
      ok: true,
    });
    expect(v(await h.objects.get(title, "content"))).toBe("Our results");
    await h.host.document.undo();
    expect(v(await h.objects.get(title, "content"))).toBe(before);
    // A title is one line.
    expect(await h.objects.writeTemplateField(field, "Two\nlines")).toEqual({
      ok: false,
      problem: "A title is one line and cannot hold a line break.",
    });
    expect(await h.objects.writeTemplateField(field, 7)).toEqual({
      ok: false,
      problem: "A placeholder's text must be text.",
    });
  });

  it("placeholderText by type and index on a slide; a body takes lines; a write outside the field is refused", async () => {
    const body = await placeholder(3, "body");
    const field = await template(
      frameId(body),
      PLACEHOLDER_TEXT_KIND,
      { slide: 3, placeholder: { type: "body", idx: 1 } },
      ["text.edit"],
    );
    expect((await h.objects.readTemplateField(field)).control).toEqual({
      kind: "text",
      multiline: true,
    });
    expect(
      await h.objects.writeTemplateField(field, "First point\nSecond point"),
    ).toEqual({ ok: true });
    expect(v(await h.objects.get(body, "content"))).toBe(
      "First point\nSecond point",
    );
    // The same kind pointed at the slide's title: not the field's frame.
    const title = await placeholder(3, "title");
    const before = v(await h.objects.get(title, "content"));
    const out = await h.objects.writeTemplateField(
      { ...field, def: { slide: 3, placeholder: { type: "title" } } },
      "Not mine",
    );
    expect(out).toEqual({
      ok: false,
      problem: expect.stringMatching(
        /^The template does not permit text\.edit on story \S+, which is outside this field\.$/,
      ),
    });
    expect(v(await h.objects.get(title, "content"))).toBe(before);
    // A placeholder the slide does not have.
    expect(
      await h.objects.writeTemplateField(
        { ...field, def: { slide: 3, placeholder: { type: "pic" } } },
        "x",
      ),
    ).toEqual({ ok: false, problem: "Slide 3 has no pic placeholder." });
  });

  it("visibility: the engine checks a slide's hidden flag document-wide, so a filler needs the template to grant it", async () => {
    const title = await placeholder(4, "title");
    const field = await template(frameId(title), VISIBILITY_KIND, null, [
      "item.visibility",
    ]);
    expect(await h.objects.readTemplateField(field)).toEqual({
      control: { kind: "toggle" },
      value: true,
    });
    expect(await h.objects.writeTemplateField(field, false)).toEqual({
      ok: false,
      problem:
        "The template does not let a filler show or hide slides: it must grant document.metadata to the whole document.",
    });
    expect(v(await h.objects.get(slides[3]!, "hidden"))).toBe(false);
  });

  it("visibility where the template grants document metadata: hidden and shown again, one undo step", async () => {
    const title = await placeholder(4, "title");
    const field = await template(
      frameId(title),
      VISIBILITY_KIND,
      { slide: 4 },
      ["item.visibility"],
      ["document.metadata"],
    );
    expect(await h.objects.writeTemplateField(field, false)).toEqual({
      ok: true,
    });
    expect(v(await h.objects.get(slides[3]!, "hidden"))).toBe(true);
    expect((await h.objects.readTemplateField(field)).value).toBe(false);
    await h.host.document.undo();
    expect(v(await h.objects.get(slides[3]!, "hidden"))).toBe(false);
    expect(await h.objects.writeTemplateField(field, "no")).toEqual({
      ok: false,
      problem: "Whether a slide is shown is yes or no.",
    });
  });
});
