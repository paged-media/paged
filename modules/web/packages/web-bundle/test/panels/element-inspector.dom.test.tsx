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

// Web ADR 416 — the Web source panel's inspection: the element in focus
// (line, open tag, path, size, rules, its line's diagnostics), the
// publication notes, and the sample data beside the source.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PX_PER_PT } from "@paged-media/helpers";

import "../../src/activate";
import {
  ElementInspector,
  PublicationNotes,
  SampleData,
} from "../../src/panels/element-inspector";
import { tagOutline } from "../../../web-model/src";

afterEach(() => cleanup());

const HTML = '<div class="card">\n  <p class="lead">{{title}}</p>\n</div>';
const CSS = ".card p { margin: 0 }\np:hover { color: red }\nh1 { x: y }";

describe("the element inspector (web ADR 416)", () => {
  it("says where the element is, its path, its size and the rules that reach it", () => {
    const outline = tagOutline(HTML);
    const p = outline.findIndex((e) => e.tag === "p");
    const show = mock((_i: number) => {});
    const view = render(
      <ElementInspector
        html={HTML}
        css={CSS}
        outline={outline}
        index={p}
        boxes={[
          { tag: "p", n: 0, x: 0, y: 0, w: 120 * PX_PER_PT, h: 14 * PX_PER_PT },
        ]}
        diagnostics={[
          {
            severity: "warning",
            message: "on the p's line",
            line: 2,
            source: "html",
          },
          {
            severity: "warning",
            message: "elsewhere",
            line: 3,
            source: "html",
          },
        ]}
        onShowInSource={show}
      />,
    );
    const q = (s: string) => view.container.querySelector(s);
    expect(q("[data-web-inspect]")?.getAttribute("data-web-inspect")).toBe(
      "element",
    );
    expect(q("[data-web-inspect-tag]")?.textContent).toBe('<p class="lead">');
    expect(q("[data-web-inspect-selector]")?.textContent).toBe(
      "div.card > p.lead",
    );
    expect(q("[data-web-inspect-size]")?.textContent).toBe("120 × 14 pt");
    const rules = [
      ...view.container.querySelectorAll("[data-web-inspect-rule]"),
    ].map((r) => r.getAttribute("data-web-inspect-rule"));
    expect(rules).toEqual(["matched", "unevaluated"]);
    expect(
      [...view.container.querySelectorAll("[data-web-inspect-diagnostic]")].map(
        (d) => d.textContent,
      ),
    ).toEqual(["on the p's line"]);
    fireEvent.click(q("[data-web-inspect-show]")!);
    expect(show).toHaveBeenCalledWith(p);
  });

  it("asks for a pick when nothing is in focus", () => {
    const view = render(
      <ElementInspector
        html={HTML}
        css=""
        outline={tagOutline(HTML)}
        index={null}
        boxes={null}
        diagnostics={[]}
        onShowInSource={() => {}}
      />,
    );
    expect(
      view.container
        .querySelector("[data-web-inspect]")
        ?.getAttribute("data-web-inspect"),
    ).toBe("empty");
  });

  it("explains what the page cannot show, and why no script runs", () => {
    const view = render(
      <PublicationNotes
        css={CSS}
        diagnostics={[
          {
            severity: "error",
            message:
              "page JavaScript never executes in a web frame (platform policy) — remove <script>",
            source: "html",
            line: 1,
          },
        ]}
      />,
    );
    expect(
      view.container.querySelector('[data-web-print-note="interaction"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector("[data-web-script-why]")?.textContent,
    ).toContain("sandbox");
    cleanup();
    const quiet = render(
      <PublicationNotes css="p { margin: 0 }" diagnostics={[]} />,
    );
    expect(quiet.container.textContent).toBe("");
  });

  it("lists the placeholders without a value and adds one with a click", () => {
    const add = mock((_n: string) => {});
    const view = render(
      <SampleData html={HTML} css="" vars={{ other: "x" }} onAdd={add} />,
    );
    expect(
      view.container.querySelector("[data-web-sample-missing]")?.textContent,
    ).toBe("{{title}} has no value");
    fireEvent.click(
      view.container.querySelector('[data-web-sample-add="title"]')!,
    );
    expect(add).toHaveBeenCalledWith("title");
    cleanup();
    const done = render(
      <SampleData html={HTML} css="" vars={{ title: "Hi" }} onAdd={add} />,
    );
    expect(
      done.container
        .querySelector("[data-web-sample-data]")
        ?.getAttribute("data-web-sample-data"),
    ).toBe("0");
  });
});
