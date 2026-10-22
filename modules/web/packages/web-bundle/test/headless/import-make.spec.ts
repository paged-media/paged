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

// The typed twins of the panel's import and "Make web frame" (editor plan
// G4), and the `webFrame.diagnostics` row, on the real headless host: what
// the Node CLI and a script reach through `host.objects`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { webBundle } from "../../src";
import { loadWebSource } from "../../src/source-part";
import { recordScene } from "../conformance/blitz";
import { openHost } from "../conformance/host";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";

const C = "media.paged.web.command.";
let h: HeadlessHost;
let host: BundleHost;

beforeEach(async () => {
  h = await openHost();
  await h.load(W1_EMPTY_PAGE.bytes());
  recordScene(h);
  h.loadBundle(webBundle);
  host = h.host as unknown as BundleHost;
}, 60_000);

afterEach(() => h?.dispose());

const idOf = (address: string) => address.slice(address.lastIndexOf(":") + 1);
const rect = (id: string) => ({ kind: "rectangle", id }) as never;

describe("paged.web importHtml and makeWebFrame (typed)", () => {
  it("importHtml splits a whole file into its lanes and sanitises it; one undo removes the frame", async () => {
    covers("command:media.paged.web.command.importHtml");
    const out = (await h.objects.invoke(`${C}importHtml`, {
      html: '<html><head><style>p { color: red; }</style></head><body><p onclick="x()">Hi</p><script>x()</script></body></html>',
      page: "page:#1",
      bounds: [10, 10, 110, 210],
    })) as { webFrame: string; frame: string; removed: string[] };
    expect(out.webFrame).toBe(
      `plugin:media.paged.web/webFrame/${idOf(out.frame)}`,
    );
    expect(out.removed.sort()).toEqual([
      "<script> element",
      "event-handler attribute",
    ]);
    const source = await loadWebSource(host, rect(idOf(out.frame)));
    expect(source!.css).toBe("p { color: red; }");
    expect(source!.html).not.toContain("script");
    expect(source!.html).not.toContain("onclick");
    expect(source!.html).toContain("<p");
    await h.host.document.undo();
    expect(await h.objects.query("plugin:media.paged.web/webFrame")).toEqual(
      [],
    );
  });

  it("importHtml with css takes html as the html lane", async () => {
    const out = (await h.objects.invoke(`${C}importHtml`, {
      html: "<p>Lane</p><script>x()</script>",
      css: "p { margin: 0 }",
      page: "page:#1",
      bounds: [10, 10, 110, 210],
    })) as { frame: string; removed: string[] };
    const source = await loadWebSource(host, rect(idOf(out.frame)));
    expect({ html: source!.html, css: source!.css }).toEqual({
      html: "<p>Lane</p>",
      css: "p { margin: 0 }",
    });
    expect(out.removed).toEqual(["<script> element"]);
    await expect(
      h.objects.invoke(`${C}importHtml`, {
        html: "<p/>",
        page: "page:#9",
        bounds: [0, 0, 10, 10],
      }),
    ).rejects.toThrow(/invalidValue: page:#9 is not a page/);
  });

  it("makeWebFrame turns a plain frame into a web frame, from a starter; one undo takes it back", async () => {
    covers("command:media.paged.web.command.makeWebFrame");
    const made = (await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [10, 10, 110, 210] },
    } as never)) as { createdId: { id: string } };
    const id = made.createdId.id;
    const out = (await h.objects.invoke(`${C}makeWebFrame`, {
      frame: `rectangle:${id}`,
      template: "card",
    })) as { webFrame: string };
    expect(out.webFrame).toBe(`plugin:media.paged.web/webFrame/${id}`);
    const source = await loadWebSource(host, rect(id));
    expect(source!.html.length).toBeGreaterThan(0);

    await expect(
      h.objects.invoke(`${C}makeWebFrame`, { frame: `rectangle:${id}` }),
    ).rejects.toThrow(/is a web frame already/);

    await h.host.document.undo();
    expect(await loadWebSource(host, rect(id))).toBeNull();
    await expect(
      h.objects.invoke(`${C}makeWebFrame`, {
        frame: `rectangle:${id}`,
        template: "nope",
      }),
    ).rejects.toThrow(/invalidValue/);
  });

  it("webFrame.diagnostics lists what the source panel lints", async () => {
    const { webFrame } = (await h.objects.invoke(`${C}insertWebFrame`, {
      page: "page:#1",
      bounds: [10, 10, 110, 210],
      html: "<div><p>{{doc.missing}}</div>",
      css: "",
    })) as { webFrame: string };
    const d = await h.objects.get(webFrame, "diagnostics");
    expect(d.kind).toBe("value");
    const list = (d as { value: { severity: string; message: string }[] })
      .value;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((x) => typeof x.message === "string")).toBe(true);
    expect(list.some((x) => x.message.includes("doc.missing"))).toBe(true);
  });
});
