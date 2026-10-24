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

// Doc ADR 608 — the Home group and the status items, RENDERED (happy-dom)
// over a word store: the buttons light from the selection's effective
// format, a click runs the command, the style box lists the document's
// styles first and applies the chosen one, and the status items read the
// page and word counts.

import { afterEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type { WordCommandName } from "../../src/word/commands";
import { makeHomeGroup } from "../../src/word/home-group";
import { makePageStatus, makeWordsStatus } from "../../src/word/status-items";
import type { WordSnapshot, WordStore } from "../../src/word/word-state";

afterEach(() => cleanup());

function store(snap: Partial<WordSnapshot>): WordStore {
  const full: WordSnapshot = {
    format: {},
    hasSelection: true,
    styles: [],
    fonts: [],
    swatches: [],
    page: null,
    words: null,
    ...snap,
  };
  return {
    get: () => full,
    subscribe: () => () => {},
    refreshFormat: async () => {},
    refreshDocument: async () => {},
    refreshPage: async () => {},
    refreshWords: async () => {},
  };
}

describe("the Word Home group (doc ADR 608)", () => {
  it("lights the selection's format and runs a command on click", () => {
    const ran: WordCommandName[] = [];
    const Home = makeHomeGroup(
      store({
        format: {
          characterFontStyle: "Bold Italic",
          characterUnderline: false,
          paragraphJustification: "CenterAlign",
          paragraphListType: "BulletList",
        },
      }),
      {
        run: (n) => ran.push(n),
        applyParagraphStyle() {},
        setFontFamily() {},
        setFontSize() {},
        setTextColor() {},
      },
    );
    const { container } = render(<Home editContext="wordDocument" />);
    const button = (id: string) =>
      container.querySelector<HTMLButtonElement>(`[data-word-button="${id}"]`)!;
    expect(button("bold").getAttribute("aria-pressed")).toBe("true");
    expect(button("italic").getAttribute("aria-pressed")).toBe("true");
    expect(button("underline").getAttribute("aria-pressed")).toBe("false");
    expect(button("alignCenter").getAttribute("aria-pressed")).toBe("true");
    expect(button("bullets").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("underline"));
    fireEvent.click(button("justify"));
    expect(ran).toEqual(["underline", "justify"]);
  });

  it("lists the document's styles first and applies the chosen one", () => {
    const applied: string[] = [];
    const Home = makeHomeGroup(
      store({
        format: { appliedParagraphStyle: "ParagraphStyle/docx-Normal" },
        styles: [
          {
            selfId: "ParagraphStyle/docx-auto-p1",
            name: "docx direct format 1",
          },
          { selfId: "ParagraphStyle/docx-Default", name: "docx defaults" },
          { selfId: "ParagraphStyle/docx-Normal", name: "Normal" },
          { selfId: "ParagraphStyle/docx-Heading1", name: "heading 1" },
        ],
      }),
      {
        run() {},
        applyParagraphStyle: (id) => applied.push(id),
        setFontFamily() {},
        setFontSize() {},
        setTextColor() {},
      },
    );
    const { container } = render(<Home editContext="wordDocument" />);
    const box =
      container.querySelector<HTMLSelectElement>("[data-word-style]")!;
    expect([...box.options].map((o) => o.textContent)).toEqual([
      "Normal",
      "heading 1",
      "docx defaults",
    ]);
    expect(box.value).toBe("ParagraphStyle/docx-Normal");
    fireEvent.change(box, {
      target: { value: "ParagraphStyle/docx-Heading1" },
    });
    expect(applied).toEqual(["ParagraphStyle/docx-Heading1"]);
  });

  it("is disabled without a text selection", () => {
    const Home = makeHomeGroup(store({ hasSelection: false }), {
      run() {},
      applyParagraphStyle() {},
      setFontFamily() {},
      setFontSize() {},
      setTextColor() {},
    });
    const { container } = render(<Home editContext="wordDocument" />);
    expect(
      container.querySelector<HTMLButtonElement>('[data-word-button="bold"]')!
        .disabled,
    ).toBe(true);
  });
});

describe("the Word status items", () => {
  it("read page X of Y and the words, the selection's of the document's", () => {
    const s = store({
      page: { index: 1, count: 3 },
      words: { total: 120, selected: 4 },
    });
    const Page = makePageStatus(s);
    const Words = makeWordsStatus(s);
    const { container } = render(
      <>
        <Page editContext="wordDocument" />
        <Words editContext="wordDocument" />
      </>,
    );
    expect(
      container.querySelector('[data-word-status="page"]')!.textContent,
    ).toBe("Page 2 of 3");
    expect(
      container.querySelector('[data-word-status="words"]')!.textContent,
    ).toBe("4 of 120 words");
  });
});
