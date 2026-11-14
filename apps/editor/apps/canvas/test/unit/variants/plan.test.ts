/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Layout variants (editor ADR 1235): shared changes reach a variant only
// by an explicit "apply to variants", and only where the variant did not
// change the same thing itself — its own changes are overrides, kept.

import { describe, expect, test } from "bun:test";

import {
  planSharedChanges,
  styleOps,
  type SharedFacts,
} from "../../../src/variants/variants";

type Entry = { path: string; value: { type: "number"; value: number } };

function facts(
  styles: Record<string, Record<string, number>>,
  links: Record<string, string> = {},
): SharedFacts {
  const out: SharedFacts = { styles: new Map(), links: new Map() };
  for (const [id, props] of Object.entries(styles)) {
    const raw: Entry[] = Object.entries(props).map(([path, value]) => ({
      path,
      value: { type: "number", value },
    }));
    out.styles.set(id, {
      collection: "paragraph",
      name: id.replace("ParagraphStyle/", ""),
      entries: new Map(raw.map((e) => [e.path, JSON.stringify(e.value)])),
      raw: raw as never,
    });
  }
  for (const [frame, uri] of Object.entries(links))
    out.links.set(frame, { uri, element: { kind: "rectangle", id: frame } });
  return out;
}

describe("apply to variants", () => {
  test("main's changes since the variant was made, where the variant kept the base's", () => {
    const base = facts(
      {
        "ParagraphStyle/Heading": {
          characterFontSize: 24,
          characterLeading: 28,
        },
        "ParagraphStyle/Body": { characterFontSize: 10 },
        "ParagraphStyle/Caption": { characterFontSize: 8 },
      },
      {
        hero: "file:///hero-1.jpg",
        logo: "file:///logo.png",
        side: "file:///a.jpg",
      },
    );
    const main = facts(
      {
        // Main changed Heading's size; Body's too; Caption not at all.
        "ParagraphStyle/Heading": {
          characterFontSize: 28,
          characterLeading: 28,
        },
        "ParagraphStyle/Body": { characterFontSize: 11 },
        "ParagraphStyle/Caption": { characterFontSize: 8 },
      },
      {
        hero: "file:///hero-2.jpg",
        logo: "file:///logo.png",
        side: "file:///b.jpg",
      },
    );
    const variant = facts(
      {
        // The variant changed Heading's leading (not its size) and Body's
        // size itself: Body is its own.
        "ParagraphStyle/Heading": {
          characterFontSize: 24,
          characterLeading: 30,
        },
        "ParagraphStyle/Body": { characterFontSize: 9 },
        "ParagraphStyle/Caption": { characterFontSize: 8 },
      },
      // The variant replaced its side picture itself.
      {
        hero: "file:///hero-1.jpg",
        logo: "file:///logo.png",
        side: "file:///c.jpg",
      },
    );
    const plan = planSharedChanges(base, main, variant);
    expect(plan.styles).toEqual([
      {
        styleId: "ParagraphStyle/Heading",
        name: "Heading",
        collection: "paragraph",
        entries: [
          { path: "characterFontSize", value: { type: "number", value: 28 } },
        ],
      },
    ]);
    expect(plan.pictures).toEqual([
      {
        frame: "hero",
        element: { kind: "rectangle", id: "hero" },
        from: "file:///hero-1.jpg",
        to: "file:///hero-2.jpg",
      },
    ]);
    expect(plan.kept).toEqual(["Body", "side"]);
    expect(styleOps(plan)).toEqual([
      {
        op: "setStyleProperty",
        args: {
          collection: "paragraph",
          styleId: "ParagraphStyle/Heading",
          path: "characterFontSize",
          value: { type: "number", value: 28 },
        },
      },
    ]);
    // A variant that already has main's state has nothing to apply.
    const caught = planSharedChanges(base, main, main);
    expect(caught.styles).toEqual([]);
    expect(caught.pictures).toEqual([]);
  });
});
