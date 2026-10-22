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

// paged.web's template field kinds (extensions ADR 335) on the REAL engine:
// an author makes a web frame a field, the session turns filler, and the
// field is read and written through `host.objects` — one undo step, the
// value refused when it is not one the field takes, and the same write
// refused by the engine on a web frame that is not the field's.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { BundleHost, TemplateFieldRef } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { webBundle } from "../../src";
import { loadWebSource } from "../../src/source-part";
import { blitzPresent, primeBlitz, recordScene } from "../conformance/blitz";
import { openHost } from "../conformance/host";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";

let h: HeadlessHost;
let host: BundleHost;

const send = (kind: string, payload: unknown) =>
  h.host.editor.client.send({ kind, payload } as never) as Promise<{
    kind: string;
    payload: unknown;
  }>;

const HTML = '<h1>{{doc.company}}</h1><p class="lead">Hello</p>';
const CSS = ":root { --accent: red; }\nh1 { color: var(--accent); }";

/** Insert a web frame through the typed command; answers its item id. */
async function webFrame(
  html = HTML,
  css = CSS,
  bounds = [60, 60, 240, 300],
): Promise<string> {
  const out = (await h.objects.invoke(
    "media.paged.web.command.insertWebFrame",
    { page: "page:#1", bounds, html, css },
  )) as { frame: string };
  return out.frame.slice(out.frame.lastIndexOf(":") + 1);
}

/** Make item `id` a module field (as an author). */
async function makeField(
  id: string,
  name: string,
  kind: string,
  def: unknown,
): Promise<void> {
  const out = await send("mutate", {
    op: "setPluginMetadata",
    args: {
      elementId: { kind: "rectangle", id },
      key: "x-paged:template",
      value: JSON.stringify({
        v: 1,
        data: {
          field: { name, kind: "module", module: { kind, grants: [], def } },
        },
      }),
    },
  });
  expect(out.kind).toBe("mutationApplied");
}

const filler = async () => {
  const r = await send("setSessionPolicy", { policy: { role: "filler" } });
  expect(r.kind).toBe("sessionPolicyApplied");
};

const ref = (
  name: string,
  targetId: string,
  kind: string,
  def: unknown,
): TemplateFieldRef => ({ name, targetId, kind, def });

beforeEach(async () => {
  h = await openHost();
  await h.load(W1_EMPTY_PAGE.bytes());
  recordScene(h);
  h.loadBundle(webBundle);
  host = h.host as unknown as BundleHost;
  if (blitzPresent) await primeBlitz(host);
  await send("setSessionPolicy", { policy: { role: "author" } });
}, 60_000);

afterEach(() => h?.dispose());

describe("paged.web template field kinds", () => {
  it("are listed with their controls", async () => {
    const kinds = (await h.objects.templateFieldKinds()).filter(
      (k) => k.owner === "media.paged.web",
    );
    expect(kinds.map((k) => [k.kind, k.control])).toEqual([
      ["media.paged.web.value", { kind: "text" }],
      ["media.paged.web.source", { kind: "text", multiline: true }],
      ["media.paged.web.cssVar", { kind: "text" }],
    ]);
  });

  it("value: a filler fills {{doc.key}} in the field's frame, one undo step; other frames refuse", async () => {
    const id = await webFrame();
    const other = await webFrame();
    await makeField(id, "company", "media.paged.web.value", {
      name: "doc.company",
    });
    await filler();
    const field = ref("company", id, "media.paged.web.value", {
      name: "doc.company",
    });
    expect(await h.objects.readTemplateField(field)).toEqual({
      control: { kind: "text" },
      value: null,
    });

    expect(await h.objects.writeTemplateField(field, "Smith & <Co>")).toEqual({
      ok: true,
    });
    expect((await h.objects.readTemplateField(field)).value).toBe(
      "Smith & <Co>",
    );
    const e = { kind: "rectangle", id } as never;
    // Stored as text: markup in a value never reaches the HTML lane.
    expect((await loadWebSource(host, e))!.vars).toEqual({
      "doc.company": "Smith &amp; &lt;Co&gt;",
    });

    await h.host.document.undo();
    expect((await loadWebSource(host, e))!.vars).toBeUndefined();

    // Refused values: not text, a name the frame does not use.
    expect(await h.objects.writeTemplateField(field, 4)).toEqual({
      ok: false,
      problem: "The value must be text.",
    });
    expect(
      await h.objects.writeTemplateField(
        { ...field, def: { name: "doc.other" } },
        "x",
      ),
    ).toEqual({
      ok: false,
      problem: "This web frame does not use {{doc.other}}.",
    });

    // The same write on a frame the template does not open: the engine
    // refuses it.
    const outside = await h.objects.writeTemplateField(
      { ...field, targetId: other },
      "Smith",
    );
    expect(outside.ok).toBe(false);
    expect((outside as { problem: string }).problem).toBe(
      `The template does not let this field change the web frame (document.metadata is not permitted on item ${other}).`,
    );
    expect(
      (await loadWebSource(host, { kind: "rectangle", id: other } as never))!
        .vars,
    ).toBeUndefined();
  });

  it("source: html is sanitised on write; css refuses a closing style tag; other frames refuse", async () => {
    const id = await webFrame();
    const other = await webFrame();
    await makeField(id, "body", "media.paged.web.source", { lane: "html" });
    await filler();
    const html = ref("body", id, "media.paged.web.source", { lane: "html" });
    expect((await h.objects.readTemplateField(html)).value).toBe(HTML);

    expect(
      await h.objects.writeTemplateField(
        html,
        "<p>New</p><script>alert(1)</script>",
      ),
    ).toEqual({ ok: true });
    expect((await h.objects.readTemplateField(html)).value).toBe("<p>New</p>");
    await h.host.document.undo();
    expect((await h.objects.readTemplateField(html)).value).toBe(HTML);

    const css = { ...html, def: { lane: "css" } };
    expect(
      await h.objects.writeTemplateField(css, "p{}</style><p>x</p>"),
    ).toEqual({
      ok: false,
      problem: "The CSS may not contain a closing style tag.",
    });
    expect(
      await h.objects.writeTemplateField({ ...html, def: {} }, "x"),
    ).toEqual({
      ok: false,
      problem: 'The field\'s definition needs a lane, "html" or "css".',
    });

    const outside = await h.objects.writeTemplateField(
      { ...html, targetId: other },
      "<p>Nope</p>",
    );
    expect(outside.ok).toBe(false);
    expect(
      (await loadWebSource(host, { kind: "rectangle", id: other } as never))!
        .html,
    ).toBe(HTML);
  });

  it("cssVar: a choice of the allowed values; others refused, as are other frames", async () => {
    const id = await webFrame();
    const other = await webFrame();
    const def = {
      name: "--accent",
      allowed: [{ value: "red", label: "Red" }, "navy"],
    };
    await makeField(id, "accent", "media.paged.web.cssVar", def);
    await filler();
    const field = ref("accent", id, "media.paged.web.cssVar", def);
    expect(await h.objects.readTemplateField(field)).toEqual({
      control: {
        kind: "choice",
        options: [{ value: "red", label: "Red" }, { value: "navy" }],
      },
      value: "red",
    });
    expect(await h.objects.writeTemplateField(field, "navy")).toEqual({
      ok: true,
    });
    expect((await h.objects.readTemplateField(field)).value).toBe("navy");
    const e = { kind: "rectangle", id } as never;
    expect((await loadWebSource(host, e))!.css).toBe(
      ":root { --accent: navy; }\nh1 { color: var(--accent); }",
    );
    await h.host.document.undo();
    expect((await h.objects.readTemplateField(field)).value).toBe("red");

    expect(await h.objects.writeTemplateField(field, "lime")).toEqual({
      ok: false,
      problem: '"lime" is not one of the values this field allows.',
    });
    const outside = await h.objects.writeTemplateField(
      { ...field, targetId: other },
      "navy",
    );
    expect(outside.ok).toBe(false);
  });

  it("a field on an item that is not a web frame answers a problem", async () => {
    const id = await webFrame();
    await filler();
    expect(
      await h.objects.writeTemplateField(
        ref("x", "nope", "media.paged.web.cssVar", { name: "--accent" }),
        "red",
      ),
    ).toEqual({ ok: false, problem: "Item nope is not a web frame." });
    expect(
      await h.objects.writeTemplateField(
        ref("x", id, "media.paged.web.cssVar", {
          name: "--accent",
          frame: "frame:zzz",
        }),
        "red",
      ),
    ).toEqual({
      ok: false,
      problem: `The field names the web frame frame:zzz, but it is on item ${id}.`,
    });
  });

  it.skipIf(!blitzPresent)(
    "content that no longer fits the frame is the field's problem",
    async () => {
      const id = await webFrame("<p>Short</p>", "", [60, 60, 100, 300]);
      const set = await h.objects.set(
        `plugin:media.paged.web/webFrame/${id}`,
        "overflow",
        "thread",
      );
      expect(set.applied).toBe(true);
      await makeField(id, "body", "media.paged.web.source", { lane: "html" });
      await filler();
      const field = ref("body", id, "media.paged.web.source", {
        lane: "html",
      });
      expect(await h.objects.writeTemplateField(field, "<p>Fits</p>")).toEqual({
        ok: true,
      });
      const long = Array.from({ length: 40 }, (_, i) => `<p>Line ${i}</p>`);
      expect(await h.objects.writeTemplateField(field, long.join(""))).toEqual({
        ok: false,
        problem:
          "The value was written, but the content no longer fits the web frame.",
      });
    },
  );
});
