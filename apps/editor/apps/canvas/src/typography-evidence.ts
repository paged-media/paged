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

// The Typography Debugger's shared half (editor ADR 1234): which story it
// looks at, what a line's evidence means in words ("Why did this line break
// here?"), the colour of a line's tightness, and the writes a preview
// tries. The panel and the canvas overlay both read the engine's evidence
// (`client.lineEvidence`, engine ADR 1308); nothing here measures a line.

import { useEffect, useRef, useState } from "react";

import {
  changesTheDocument,
  type ContentSelection,
  type ElementId,
  type LineEvidence,
  type LineEvidenceReport,
  type Mutation,
  type Tightness,
} from "@paged-media/client";
import {
  useCanvasClient,
  useContentSelection,
  useSelection,
} from "@paged-media/shell";
import { defineMessages } from "@paged-media/strings";

export const TYPO = defineMessages("app.typography", {
  wordSpace: "The next word, “{word}”, did not fit on the line.",
  wordSpaceNoPoint:
    "It offers no hyphenation point here ({reason}), so it went to the next line whole.",
  wordSpacePoints:
    "The dictionary offers {count, plural, one {# point} other {# points}} in it; breaking there would have set the line worse.",
  hyphen: "The word “{word}” was hyphenated at a dictionary point.",
  discretionary: "The word “{word}” was broken at its discretionary hyphen.",
  hardHyphen: "The line breaks after the hyphen the text already has.",
  forced: "A forced line break (Shift+Return) ends the line.",
  paragraphEnd: "The paragraph ends here.",
  storyEnd: "The story ends here.",
  emergency:
    "Nothing allowed a break: the line was cut where it filled the measure.",
  oversetAfter: "The frames end here; the rest of the story is overset.",
  frameEnd: "The text continues in the next frame.",
  measure:
    "Set in {available} pt; its natural width is {natural} pt ({fill} % of the measure).",
  spacing:
    "Word spaces {mean} % of the font's space (from {min} to {max} %); the paragraph allows {low} to {high} %.",
  letters: "Letters spread by {pt} pt each.",
  grid: "Aligned to the baseline grid, moved {shift} pt.",
  reasonShort: "the word is short",
  reasonCapitalized: "capitalised words are not hyphenated",
  reasonLastWord: "the last word is not hyphenated",
  reasonNoLanguage: "no hyphenation language",
  reasonOff: "hyphenation is off",
  reasonNoPattern: "no pattern matches",
  veryTight: "Very tight",
  tight: "Tight",
  normal: "Normal",
  loose: "Loose",
  veryLoose: "Very loose",
});

/** The colour a line of `t` is drawn in; none for a normal line. */
export function tightnessColour(t: Tightness): string | null {
  switch (t) {
    case "veryTight":
      return "var(--status-error)";
    case "tight":
      return "var(--status-review)";
    case "loose":
      return "var(--status-info)";
    case "veryLoose":
      return "var(--overlay-selection)";
    default:
      return null;
  }
}

export function tightnessLabel(t: Tightness): string {
  return {
    veryTight: TYPO.veryTight,
    tight: TYPO.tight,
    normal: TYPO.normal,
    loose: TYPO.loose,
    veryLoose: TYPO.veryLoose,
  }[t];
}

const REASON: Record<string, string> = {
  short: TYPO.reasonShort,
  capitalized: TYPO.reasonCapitalized,
  lastWord: TYPO.reasonLastWord,
  noLanguage: TYPO.reasonNoLanguage,
  off: TYPO.reasonOff,
  noPattern: TYPO.reasonNoPattern,
};

type T = (key: string, params?: Record<string, string | number>) => string;

const round = (n: number, d = 1) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/** "Why did this line break here?" — the line's evidence, in sentences,
 *  most telling first. PURE (given `t`). */
export function whyThisBreak(line: LineEvidence, t: T): string[] {
  const out: string[] = [];
  const h = line.hyphenation;
  switch (line.breakKind) {
    case "wordSpace":
      if (h) {
        out.push(t(TYPO.wordSpace, { word: h.word }));
        out.push(
          h.points.length === 0
            ? t(TYPO.wordSpaceNoPoint, {
                reason: t(
                  REASON[h.reason ?? "noPattern"] ?? TYPO.reasonNoPattern,
                ),
              })
            : t(TYPO.wordSpacePoints, { count: h.points.length }),
        );
      }
      break;
    case "hyphen":
      out.push(t(TYPO.hyphen, { word: h?.word ?? "" }));
      break;
    case "discretionaryHyphen":
      out.push(t(TYPO.discretionary, { word: h?.word ?? "" }));
      break;
    case "hardHyphen":
      out.push(t(TYPO.hardHyphen));
      break;
    case "forcedLineBreak":
      out.push(t(TYPO.forced));
      break;
    case "paragraphEnd":
      out.push(t(TYPO.paragraphEnd));
      break;
    case "storyEnd":
      out.push(t(TYPO.storyEnd));
      break;
    default:
      out.push(t(TYPO.emergency));
  }
  if (line.oversetAfter) out.push(t(TYPO.oversetAfter));
  else if (line.frameEnd) out.push(t(TYPO.frameEnd));
  if (line.available > 0)
    out.push(
      t(TYPO.measure, {
        available: round(line.available),
        natural: round(line.natural),
        fill: Math.round((line.natural / line.available) * 100),
      }),
    );
  return out;
}

/** The line's spacing against its paragraph's bounds, in sentences. */
export function spacingFacts(
  line: LineEvidence,
  band: readonly number[] | undefined,
  t: T,
): string[] {
  const out: string[] = [];
  if (
    line.wordSpacing !== null &&
    line.wordSpacing !== undefined &&
    band &&
    band.length === 3
  )
    out.push(
      t(TYPO.spacing, {
        mean: Math.round(line.wordSpacing),
        min: Math.round(line.wordSpacingMin ?? line.wordSpacing),
        max: Math.round(line.wordSpacingMax ?? line.wordSpacing),
        low: band[0]!,
        high: band[2]!,
      }),
    );
  if (Math.abs(line.letterSpacing) > 0.01)
    out.push(t(TYPO.letters, { pt: round(line.letterSpacing, 2) }));
  if (line.gridShift !== null && line.gridShift !== undefined)
    out.push(t(TYPO.grid, { shift: round(line.gridShift, 2) }));
  return out;
}

/** The story the debugger looks at: the caret's, else the selected text
 *  frame's. */
export interface TypographyTarget {
  storyId: string;
  /** The caret's selection (caret units), when the target came from it. */
  selection: ContentSelection | null;
}

/** The target of the current selection, kept per editor. A text frame's
 *  story is asked of the engine once per selection (`explain`'s
 *  overview). */
export function useTypographyTarget(): TypographyTarget | null {
  const client = useCanvasClient();
  const { contentSelection } = useContentSelection();
  const { elementSelection } = useSelection();
  const [frameStory, setFrameStory] = useState<{
    frame: string;
    story: string | null;
  } | null>(null);
  const frame: ElementId | undefined = elementSelection.find(
    (e) => e.kind === "textFrame",
  );
  const frameId = frame ? String(frame.id) : null;
  useEffect(() => {
    if (!frameId) return;
    let cancelled = false;
    void client
      .explain({ kind: "textFrame", id: frameId } as ElementId, {
        aspect: "overview",
      })
      .then((x) => {
        if (!cancelled)
          setFrameStory({ frame: frameId, story: x.text?.storyId ?? null });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, frameId]);
  if (contentSelection && !contentSelection.cell)
    return {
      storyId: contentSelection.storyId,
      selection: contentSelection,
    };
  if (frameId && frameStory?.frame === frameId && frameStory.story)
    return { storyId: frameStory.story, selection: null };
  return null;
}

/** Read the evidence of `storyId`, or null when the read failed. Outside
 *  the component: no conditional in a `try` (ADR 229). */
async function readEvidence(
  client: ReturnType<typeof useCanvasClient>,
  storyId: string,
): Promise<LineEvidenceReport | null> {
  try {
    return await client.lineEvidence({ story: storyId });
  } catch {
    return null;
  }
}

/** The document's evidence for `storyId`, re-read after every change. */
export function useLineEvidence(
  storyId: string | null,
): LineEvidenceReport | null {
  const client = useCanvasClient();
  const [report, setReport] = useState<LineEvidenceReport | null>(null);
  const runRef = useRef(0);
  useEffect(() => {
    const refresh = () => {
      const run = ++runRef.current;
      if (!storyId) {
        setReport(null);
        return;
      }
      void readEvidence(client, storyId).then((r) => {
        if (run === runRef.current) setReport(r);
      });
    };
    refresh();
    return client.subscribe((msg) => {
      if (changesTheDocument(msg)) refresh();
    });
  }, [client, storyId]);
  return report;
}

/** What a preview may change. */
export type PreviewChange =
  | { kind: "tracking"; value: number }
  | { kind: "hyphenation"; value: boolean }
  | { kind: "hyphenationZone"; value: number }
  | { kind: "composer"; value: "HL Composer" | "HL Single" };

/** The write a preview tries and Apply makes, over story characters
 *  `[start, end)`: the paragraphs the caret is in, else the whole story. */
export function previewMutation(
  storyId: string,
  start: number,
  end: number,
  change: PreviewChange,
): Mutation {
  const elementId = {
    kind: "storyRange",
    id: { story_id: storyId, start, end },
  } as ElementId;
  const set = (path: string, value: unknown) =>
    ({
      op: "setElementProperty",
      args: { elementId, path, value },
    }) as unknown as Mutation;
  switch (change.kind) {
    case "tracking":
      return set("characterTracking", { type: "length", value: change.value });
    case "hyphenation":
      return set("paragraphHyphenation", { type: "bool", value: change.value });
    case "hyphenationZone":
      return set("paragraphHyphenationZone", {
        type: "length",
        value: change.value,
      });
    default:
      return set("paragraphComposer", { type: "text", value: change.value });
  }
}

/** The story characters a change applies to: the paragraphs holding the
 *  caret's lines, else the whole story (its placed lines and its overset
 *  text). PURE. */
export function changeRange(
  report: LineEvidenceReport,
  selection: ContentSelection | null,
): [number, number] {
  const end = Math.max(
    0,
    ...report.lines.map((l) => l.end),
    report.overset ? report.overset.from + report.overset.characters : 0,
  );
  if (!selection) return [0, end];
  const paragraphs = new Set(
    report.lines
      .filter(
        (l) =>
          l.caretStart <= Math.max(selection.start, selection.end) &&
          l.caretEnd >= Math.min(selection.start, selection.end),
      )
      .map((l) => l.paragraph),
  );
  const lines = report.lines.filter((l) => paragraphs.has(l.paragraph));
  if (lines.length === 0) return [0, end];
  return [
    Math.min(...lines.map((l) => l.start)),
    Math.max(...lines.map((l) => l.end)),
  ];
}

/** A summary of a report, to compare a preview with the document. PURE. */
export function evidenceSummary(r: LineEvidenceReport): {
  lines: number;
  loose: number;
  tight: number;
  hyphens: number;
  overset: number;
} {
  return {
    lines: r.lines.length,
    loose: r.lines.filter(
      (l) => l.tightness === "loose" || l.tightness === "veryLoose",
    ).length,
    tight: r.lines.filter(
      (l) => l.tightness === "tight" || l.tightness === "veryTight",
    ).length,
    hyphens: r.lines.filter(
      (l) => l.breakKind === "hyphen" || l.breakKind === "discretionaryHyphen",
    ).length,
    overset: r.overset?.characters ?? 0,
  };
}
