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

// The Typography Debugger's words and writes (editor ADR 1227): a line's
// evidence said as sentences, the range a change applies to, the write a
// preview tries.

import { describe, expect, test } from "bun:test";

import type { LineEvidence, LineEvidenceReport } from "@paged-media/client";

import {
  changeRange,
  evidenceSummary,
  previewMutation,
  spacingFacts,
  TYPO,
  whyThisBreak,
} from "../../src/typography-evidence";

const t = (key: string, p?: Record<string, string | number>) =>
  p ? `${key}${JSON.stringify(p)}` : key;

const line = (over: Partial<LineEvidence>): LineEvidence =>
  ({
    pageId: "p1",
    frameId: "f1",
    paragraph: 0,
    line: 0,
    start: 0,
    end: 10,
    caretStart: 0,
    caretEnd: 10,
    text: "",
    baseline: 0,
    left: 0,
    right: 90,
    top: 0,
    bottom: 12,
    available: 90,
    natural: 81,
    ratio: 2,
    wordSpacing: 180,
    wordSpacingMin: 180,
    wordSpacingMax: 180,
    letterSpacing: 0,
    breakKind: "wordSpace",
    frameEnd: false,
    oversetAfter: false,
    hyphenation: null,
    tightness: "veryLoose",
    outliers: ["wordSpacingAboveMaximum"],
    composer: "paragraph",
    justified: true,
    gridShift: null,
    ...over,
  }) as LineEvidence;

describe("why this line broke", () => {
  test("a word space names the word that went whole and why it offered no point", () => {
    const out = whyThisBreak(
      line({
        hyphenation: {
          word: "the",
          wordStart: 11,
          points: [],
          used: null,
          hyphenationOn: true,
          reason: "short",
        },
      }),
      t,
    );
    expect(out[0]).toBe(`${TYPO.wordSpace}{"word":"the"}`);
    expect(out[1]).toContain(TYPO.reasonShort);
    expect(out.at(-1)).toContain(TYPO.measure);
  });

  test("a hyphen, an overset end and the spacing against its bounds", () => {
    const out = whyThisBreak(
      line({
        breakKind: "hyphen",
        oversetAfter: true,
        hyphenation: {
          word: "responsibility",
          wordStart: 0,
          points: [2, 5],
          used: 5,
          hyphenationOn: true,
          reason: null,
        },
      }),
      t,
    );
    expect(out[0]).toContain(TYPO.hyphen);
    expect(out[1]).toBe(TYPO.oversetAfter);
    expect(spacingFacts(line({}), [80, 100, 133], t)[0]).toContain(
      '"high":133',
    );
  });
});

describe("a preview's write", () => {
  const report = {
    storyId: "s1",
    found: true,
    preview: false,
    refused: null,
    paragraphs: [],
    overset: { from: 40, characters: 5 },
    revision: 1,
    lines: [
      line({ paragraph: 0, start: 0, end: 10, caretStart: 0, caretEnd: 10 }),
      line({ paragraph: 1, start: 10, end: 30, caretStart: 11, caretEnd: 31 }),
    ],
  } as unknown as LineEvidenceReport;

  test("the caret's paragraph, else the whole story with its overset text", () => {
    expect(changeRange(report, null)).toEqual([0, 45]);
    expect(
      changeRange(report, {
        storyId: "s1",
        start: 15,
        end: 15,
        affinity: false,
      } as never),
    ).toEqual([10, 30]);
  });

  test("tracking is a story-range property write", () => {
    expect(previewMutation("s1", 0, 10, { kind: "tracking", value: -10 })).toEqual(
      {
        op: "setElementProperty",
        args: {
          elementId: {
            kind: "storyRange",
            id: { story_id: "s1", start: 0, end: 10 },
          },
          path: "characterTracking",
          value: { type: "length", value: -10 },
        },
      } as never,
    );
  });

  test("a summary counts loose lines and hyphens", () => {
    expect(evidenceSummary(report)).toEqual({
      lines: 2,
      loose: 2,
      tight: 0,
      hyphens: 0,
      overset: 5,
    });
  });
});
