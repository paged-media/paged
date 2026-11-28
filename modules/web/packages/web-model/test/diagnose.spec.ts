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

import { describe, expect, it } from "bun:test";

import { diagnoseHtml } from "../src/diagnose";
import {
  composePreviewSrcdoc,
  composeSrcdoc,
  DEFAULT_SOURCE,
  PREVIEW_CSP,
  sourceKeyFor,
} from "../src/source";

describe("diagnoseHtml — policy", () => {
  it("flags <script> as a policy error with its line", () => {
    const d = diagnoseHtml("<p>ok</p>\n<script>alert(1)</script>");
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("error");
    expect(d[0].line).toBe(2);
    expect(d[0].message).toMatch(/never executes/);
  });

  it("flags event-handler attributes as ignored", () => {
    const d = diagnoseHtml('<button onclick="x()">hi</button>');
    expect(d[0].severity).toBe("warning");
    expect(d[0].message).toMatch(/event-handler/);
  });

  it("empty source is an info, not an error", () => {
    expect(diagnoseHtml("  \n")).toEqual([
      { severity: "info", message: "empty web frame", source: "html" },
    ]);
  });
});

describe("diagnoseHtml — balance", () => {
  it("clean fragments produce no diagnostics", () => {
    expect(
      diagnoseHtml('<div class="a"><p>x <b>y</b></p><img src="i.png"></div>'),
    ).toEqual([]);
    expect(diagnoseHtml(DEFAULT_SOURCE.html)).toEqual([]);
  });

  it("reports never-closed tags with their open line", () => {
    const d = diagnoseHtml("<div>\n<p>text");
    expect(d.map((x) => x.message)).toEqual([
      "<div> is never closed",
      "<p> is never closed",
    ]);
    expect(d[0].line).toBe(1);
    expect(d[1].line).toBe(2);
  });

  it("reports stray close tags", () => {
    const d = diagnoseHtml("<p>x</p></div>");
    expect(d[0].message).toBe("</div> has no matching open tag");
  });

  it("self-closing and void tags do not unbalance", () => {
    expect(diagnoseHtml('<br><hr/><meta charset="utf-8"><p>x</p>')).toEqual([]);
  });

  it("closing an outer tag reports the skipped inner one", () => {
    const d = diagnoseHtml("<div><span>x</div>");
    expect(d.map((x) => x.message)).toEqual(["<span> is never closed"]);
  });
});

describe("source model", () => {
  it("composeSrcdoc embeds css and the media class", () => {
    const doc = composeSrcdoc({
      html: "<p>hi</p>",
      css: "p{color:red}",
      options: { media: "print", overflow: "clip" },
    });
    expect(doc).toContain("<style>p{color:red}</style>");
    expect(doc).toContain('class="media-print"');
    expect(doc).toContain("<p>hi</p>");
  });

  it("the preview document states its policy ahead of every source byte", () => {
    const source = {
      html: '<img src="https://example.invalid/a.png"><p>hi</p>',
      css: "p{background:url(https://example.invalid/b.png)}",
      options: { media: "print" as const, overflow: "clip" as const },
    };
    const doc = composePreviewSrcdoc(source, "@font-face{font-family:F}");
    const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
    expect(doc.startsWith(`<!doctype html><html><head>${meta}`)).toBe(true);
    expect(doc.indexOf(meta)).toBeLessThan(doc.indexOf("@font-face"));
    expect(doc.indexOf(meta)).toBeLessThan(doc.indexOf(source.css));
    expect(doc.indexOf(meta)).toBeLessThan(doc.indexOf(source.html));
    // The rest is the document every other lane composes.
    expect(doc.replace(meta, "")).toBe(
      composeSrcdoc(source, "@font-face{font-family:F}"),
    );
  });

  it("the preview policy allows inline CSS and data: resources only", () => {
    const directives = new Map(
      PREVIEW_CSP.split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("style-src")).toEqual(["'unsafe-inline'"]);
    for (const name of ["img-src", "font-src", "media-src"])
      expect(directives.get(name)).toEqual(["data:"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    // Nothing grants script, a connection, a frame or a network scheme.
    for (const name of ["script-src", "connect-src", "frame-src", "child-src"])
      expect(directives.has(name)).toBe(false);
    expect(PREVIEW_CSP).not.toMatch(/https?:|\*|blob:|'self'/);
    expect(PREVIEW_CSP).not.toContain('"');
  });

  it("sourceKeyFor is stable per element", () => {
    expect(sourceKeyFor({ kind: "rectangle", id: "u42" })).toBe(
      "source.rectangle:u42",
    );
  });
});
