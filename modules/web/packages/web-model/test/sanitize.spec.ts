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

import { sanitizeHtml } from "../src/sanitize";
import { diagnoseHtml } from "../src/diagnose";
import { DEFAULT_SOURCE } from "../src/source";

describe("sanitizeHtml — script removal", () => {
  it("strips a <script>…</script> block, body and all", () => {
    const r = sanitizeHtml("<p>ok</p><script>alert(1)</script><p>after</p>");
    expect(r.html).toBe("<p>ok</p><p>after</p>");
    expect(r.removed).toContain("<script> element");
  });

  it("strips multiple script blocks", () => {
    const r = sanitizeHtml(
      "<script>a()</script><div>x</div><script>b()</script>",
    );
    expect(r.html).toBe("<div>x</div>");
    // One removal class, even across several blocks.
    expect(r.removed).toEqual(["<script> element"]);
  });

  it("strips a script with attributes and whitespace in the tag", () => {
    const r = sanitizeHtml(
      '<p>x</p>< script type="text/javascript" >evil()</ script >',
    );
    expect(r.html).toBe("<p>x</p>");
    expect(r.removed).toContain("<script> element");
  });

  it("strips an orphan/unterminated <script>", () => {
    const r = sanitizeHtml("<p>x</p><script>oops");
    expect(r.html).toBe("<p>x</p>oops");
    expect(r.removed).toContain("<script> element");
  });

  it("is idempotent — sanitizing the output again is a no-op", () => {
    const once = sanitizeHtml('<script>a()</script><b onclick="x()">y</b>');
    const twice = sanitizeHtml(once.html);
    expect(twice.html).toBe(once.html);
    expect(twice.removed).toEqual([]);
  });
});

describe("sanitizeHtml — event-handler attributes", () => {
  it("strips an onclick handler, keeping the rest of the tag", () => {
    const r = sanitizeHtml('<button onclick="doEvil()" class="b">Go</button>');
    expect(r.html).toBe('<button class="b">Go</button>');
    expect(r.removed).toContain("event-handler attribute");
  });

  it("strips handlers with single-quoted and bare values", () => {
    const r = sanitizeHtml("<img src=\"a.png\" onerror='boom()' onload=run>");
    expect(r.html).toBe('<img src="a.png">');
    expect(r.removed).toContain("event-handler attribute");
  });

  it("keeps a prefixed attribute (data-online) where 'on' is not the name start", () => {
    // The handler grammar is `on<name>=` at an attribute boundary, so a
    // `data-online` attribute (the `on` is mid-name) is untouched.
    const r = sanitizeHtml('<div data-online="yes" class="c">x</div>');
    expect(r.html).toBe('<div data-online="yes" class="c">x</div>');
    expect(r.removed).toEqual([]);
  });

  it("conservatively strips ANY on*= attribute (matches the linter's scan)", () => {
    // Like `diagnoseHtml`'s `\son[a-z]+=` scan, a bare `on<word>=` at an
    // attribute boundary is treated as a handler and removed — the safe
    // security posture (the browser would run it if it WERE a handler).
    const r = sanitizeHtml('<div onmouseover="evil()">x</div>');
    expect(r.html).toBe("<div>x</div>");
    expect(r.removed).toContain("event-handler attribute");
  });
});

describe("sanitizeHtml — handlers behind any attribute separator", () => {
  const cases: Array<[string, string, string]> = [
    ["a slash", "<svg/onload=alert(1)>", "<svg/>"],
    ["a slash, quoted", '<svg/onload="alert(1)"/>', "<svg//>"],
    ["a tab", "<img\tonerror=x src=a>", "<img src=a>"],
    ["a newline", "<img\nonerror=x\nsrc=a>", "<img\nsrc=a>"],
    ["a form feed", "<img\fonerror=x>", "<img>"],
    [
      "a closing quote",
      '<img src="a"onerror="x()" alt="b">',
      '<img src="a" alt="b">',
    ],
    [
      "an apostrophe",
      "<img src='a'onerror='x()'alt='b'>",
      "<img src='a'alt='b'>",
    ],
    ["slashes and spaces", "<svg / onload = 'x()' />", "<svg / />"],
    ["upper case", "<SVG/ONLOAD=alert(1)>", "<SVG/>"],
  ];
  for (const [what, input, expected] of cases) {
    it(`strips a handler after ${what}`, () => {
      const r = sanitizeHtml(input);
      expect(r.html).toBe(expected);
      expect(r.removed).toEqual(["event-handler attribute"]);
      expect(sanitizeHtml(r.html)).toEqual({ html: r.html, removed: [] });
    });
  }

  it("finds the tag a comment or a quoted value hides", () => {
    for (const input of [
      '<!-- <a title="--><svg/onload=alert(1)>">',
      '<a title="<svg/onload=alert(1)>">',
    ]) {
      const r = sanitizeHtml(input);
      expect(r.html).not.toContain("onload");
      expect(r.removed).toEqual(["event-handler attribute"]);
    }
  });

  it("keeps on… inside a bare or quoted value, where it is no attribute", () => {
    for (const html of [
      "<img src=a/onload=x>",
      '<a href="/turn/online=1">x</a>',
      '<p class="x"data-on="1"one-thing="2">y</p>',
    ]) {
      expect(sanitizeHtml(html)).toEqual({ html, removed: [] });
    }
  });

  it("empties a javascript: URL behind a slash or a quote", () => {
    const r = sanitizeHtml(
      '<a/href="javascript:x()">a</a><a title="t"href=javascript:y()>b</a>',
    );
    expect(r.html).toBe('<a/href="">a</a><a title="t"href=>b</a>');
    expect(r.removed).toEqual(["javascript: URL"]);
  });

  it("stays linear on tags nested in quoted values", () => {
    const hostile = '<a x="'.repeat(200_000);
    const t0 = performance.now();
    const r = sanitizeHtml(hostile + "<svg/onload=x>");
    expect(r.html).not.toContain("onload");
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("the linter flags the same handlers", () => {
    for (const html of ["<svg/onload=x></svg>", '<img src="a"onerror=x>']) {
      expect(
        diagnoseHtml(html).some((d) => d.message.includes("event-handler")),
      ).toBe(true);
    }
  });
});

describe("sanitizeHtml — javascript: URLs", () => {
  it("neutralizes a javascript: href to an empty value", () => {
    const r = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(r.html).toBe('<a href="">click</a>');
    expect(r.removed).toContain("javascript: URL");
  });

  it("neutralizes a javascript: src", () => {
    const r = sanitizeHtml("<iframe src='javascript:evil()'></iframe>");
    expect(r.html).toBe("<iframe src=''></iframe>");
    expect(r.removed).toContain("javascript: URL");
  });

  it("leaves a normal http/relative URL untouched", () => {
    const r = sanitizeHtml(
      '<a href="https://paged.media">p</a><img src="a.png">',
    );
    expect(r.html).toBe('<a href="https://paged.media">p</a><img src="a.png">');
    expect(r.removed).toEqual([]);
  });
});

describe("sanitizeHtml — well-formed passthrough + totality", () => {
  it("returns clean HTML byte-for-byte with empty removed", () => {
    const html =
      '<div class="a"><h1>Title</h1><p>Body <b>copy</b>.</p><img src="i.png"></div>';
    const r = sanitizeHtml(html);
    expect(r.html).toBe(html);
    expect(r.removed).toEqual([]);
  });

  it("passes the default source through unchanged", () => {
    const r = sanitizeHtml(DEFAULT_SOURCE.html);
    expect(r.html).toBe(DEFAULT_SOURCE.html);
    expect(r.removed).toEqual([]);
  });

  it("empty / non-string input never throws", () => {
    expect(sanitizeHtml("")).toEqual({ html: "", removed: [] });
    expect(sanitizeHtml(undefined as unknown as string)).toEqual({
      html: "",
      removed: [],
    });
  });

  it("reports every distinct class when several are present", () => {
    const r = sanitizeHtml(
      '<script>a()</script><a href="javascript:x()" onclick="y()">go</a>',
    );
    expect(r.removed).toContain("<script> element");
    expect(r.removed).toContain("event-handler attribute");
    expect(r.removed).toContain("javascript: URL");
    // Deduplicated, first-seen order (script → handler → URL pass order).
    expect(r.removed).toEqual([
      "<script> element",
      "event-handler attribute",
      "javascript: URL",
    ]);
  });

  it("the sanitized output is clean per the policy linter", () => {
    const r = sanitizeHtml(
      '<div><script>a()</script><button onclick="x()">b</button></div>',
    );
    // No ERROR-severity diagnostic survives (the <script> policy error is
    // gone because the element is gone).
    expect(diagnoseHtml(r.html).filter((d) => d.severity === "error")).toEqual(
      [],
    );
  });
});
