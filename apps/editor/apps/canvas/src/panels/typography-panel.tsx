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

// The Typography Debugger panel (editor ADR 1237; the UX strategy's Concept
// E; task PX2 of the interaction plan). For the story under the caret, or
// of the selected text frame: every composed line with how tightly it is
// set, its word spacing against the paragraph's bounds and why it broke
// where it did; the settings the composer used; and a preview of a change
// (tracking, hyphenation, the hyphenation zone, the composer) that the
// engine composes in a copy of the document — the document, its history
// and its revision stay untouched until Apply, which is one undo step.

import { useState, useSyncExternalStore } from "react";

import type { LineEvidence, LineEvidenceReport } from "@paged-media/client";
import {
  getViewToggle,
  subscribeViewToggles,
  toggleViewToggle,
  useCanvasClient,
  useEditorScope,
} from "@paged-media/shell";
import { font, radius, space } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  changeRange,
  evidenceSummary,
  previewMutation,
  spacingFacts,
  tightnessColour,
  tightnessLabel,
  useLineEvidence,
  useTypographyTarget,
  whyThisBreak,
  type PreviewChange,
} from "../typography-evidence";

const M = defineMessages("app.typographyPanel", {
  title: "Typography debugger",
  empty:
    "Put the caret in text, or select a text frame, to see how its lines are set.",
  mode: "Show on the canvas",
  summary:
    "{lines, plural, one {# line} other {# lines}} · {loose} loose · {tight} tight · {hyphens, plural, one {# hyphen} other {# hyphens}}",
  overset:
    "{count, plural, one {# character is overset} other {# characters are overset}}.",
  why: "Why did this line break here?",
  settings: "Composition",
  composer: "Composer: {name}",
  composerParagraph: "Paragraph composer",
  composerSingleLine: "Single-line composer",
  composerWordFirstFit: "First-fit (Word)",
  justification: "Alignment: {name}",
  hyphenationOn:
    "Hyphenation on: words of {longer} letters or more, {after} after the first and {before} before the last, at most {ladder} in a row.",
  hyphenationOff: "Hyphenation off.",
  zone: "Hyphenation zone {zone} pt.",
  wordSpacing: "Word spacing {min} / {desired} / {max} %",
  letterSpacing: "Letter spacing {min} / {desired} / {max} %",
  noLimit: "no limit",
  preview: "Preview a change",
  tracking: "Tracking",
  hyphenation: "Hyphenation",
  hyphenationZone: "Hyphenation zone",
  composerField: "Composer",
  on: "On",
  off: "Off",
  previewButton: "Preview",
  apply: "Apply",
  discard: "Discard",
  previewResult:
    "Preview: {lines} lines ({linesNow} now) · {loose} loose ({looseNow}) · {tight} tight ({tightNow}) · {hyphens} hyphens ({hyphensNow}).",
  previewRefused: "This change cannot be previewed.",
  previewScope: "Applies to {scope}.",
  scopeParagraph: "the paragraph at the caret",
  scopeStory: "the whole story",
});

export function TypographyPanel() {
  const strings = useStrings();
  const scope = useEditorScope();
  const target = useTypographyTarget();
  const report = useLineEvidence(target?.storyId ?? null);
  const [chosen, setChosen] = useState<string | null>(null);
  const mode = useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, "typography"),
    () => false,
  );
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  const caretLine =
    report && target?.selection
      ? report.lines.find(
          (l) =>
            l.caretStart <= target.selection!.start &&
            l.caretEnd >= target.selection!.start,
        )
      : undefined;
  const lineKey = (l: LineEvidence) => `${l.paragraph}:${l.line}`;
  const selected =
    report?.lines.find((l) => lineKey(l) === chosen) ?? caretLine ?? null;
  return (
    <div data-typography-panel style={panel}>
      <div style={{ display: "flex", alignItems: "center", gap: space[2] }}>
        <span style={{ ...kicker, margin: 0 }}>{t(M.title)}</span>
        <span style={{ flex: 1 }} />
        <label style={{ ...muted, display: "flex", gap: 4 }}>
          <input
            type="checkbox"
            data-typography-mode
            checked={mode}
            onChange={() => toggleViewToggle(scope, "typography")}
          />
          {t(M.mode)}
        </label>
      </div>
      {!target || !report || !report.found ? (
        <p data-typography-empty style={muted}>
          {t(M.empty)}
        </p>
      ) : (
        <>
          <Summary report={report} />
          <div
            data-typography-lines={report.lines.length}
            style={{ display: "flex", flexDirection: "column", gap: 1 }}
          >
            {report.lines.map((l) => (
              <button
                key={`${l.pageId}:${lineKey(l)}`}
                type="button"
                data-typography-row={lineKey(l)}
                data-tightness={l.tightness}
                data-break={l.breakKind}
                aria-pressed={
                  selected ? lineKey(selected) === lineKey(l) : false
                }
                onClick={() => setChosen(lineKey(l))}
                style={{
                  ...lineRow,
                  outline:
                    selected && lineKey(selected) === lineKey(l)
                      ? "1px solid var(--pg-primary)"
                      : "none",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background:
                      tightnessColour(l.tightness) ?? "var(--chrome-border)",
                    flex: "none",
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {l.text}
                  {l.breakKind === "hyphen" ||
                  l.breakKind === "discretionaryHyphen"
                    ? "-"
                    : ""}
                </span>
                <span style={{ ...muted, fontFamily: font.mono }}>
                  {l.wordSpacing !== null && l.wordSpacing !== undefined
                    ? `${Math.round(l.wordSpacing)} %`
                    : ""}
                </span>
              </button>
            ))}
          </div>
          {selected ? (
            <section data-typography-why={lineKey(selected)} style={card}>
              <div style={summary}>{t(M.why)}</div>
              <div style={muted}>{t(tightnessLabel(selected.tightness))}</div>
              {[
                ...whyThisBreak(selected, t),
                ...spacingFacts(
                  selected,
                  report.paragraphs.find(
                    (p) => p.paragraph === selected.paragraph,
                  )?.wordSpacing,
                  t,
                ),
              ].map((s, i) => (
                <p key={i} style={{ margin: 0 }}>
                  {s}
                </p>
              ))}
            </section>
          ) : null}
          <Settings report={report} paragraph={selected?.paragraph ?? 0} />
          <Preview report={report} />
        </>
      )}
    </div>
  );
}

function Summary({ report }: { report: LineEvidenceReport }) {
  const strings = useStrings();
  const s = evidenceSummary(report);
  return (
    <div data-typography-summary style={muted}>
      {strings.t(M.summary, {
        lines: s.lines,
        loose: s.loose,
        tight: s.tight,
        hyphens: s.hyphens,
      })}
      {report.overset ? (
        <div
          data-typography-overset={report.overset.characters}
          style={{ color: "var(--status-error)" }}
        >
          {strings.t(M.overset, { count: report.overset.characters })}
        </div>
      ) : null}
    </div>
  );
}

function Settings(props: { report: LineEvidenceReport; paragraph: number }) {
  const strings = useStrings();
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  const p =
    props.report.paragraphs.find((x) => x.paragraph === props.paragraph) ??
    props.report.paragraphs[0];
  if (!p) return null;
  const composer =
    p.composer === "singleLine"
      ? t(M.composerSingleLine)
      : p.composer === "wordFirstFit"
        ? t(M.composerWordFirstFit)
        : t(M.composerParagraph);
  return (
    <details data-typography-settings style={card}>
      <summary style={summary}>{t(M.settings)}</summary>
      <p style={settingLine}>{t(M.composer, { name: composer })}</p>
      <p style={settingLine}>{t(M.justification, { name: p.justification })}</p>
      <p style={settingLine}>
        {p.hyphenation
          ? t(M.hyphenationOn, {
              longer: p.hyphenateWordsLongerThan,
              after: p.hyphenateAfterFirst,
              before: p.hyphenateBeforeLast,
              ladder:
                p.hyphenateLadderLimit === 0
                  ? t(M.noLimit)
                  : p.hyphenateLadderLimit,
            })
          : t(M.hyphenationOff)}
      </p>
      {p.hyphenationZone !== null && p.hyphenationZone !== undefined ? (
        <p style={settingLine}>{t(M.zone, { zone: p.hyphenationZone })}</p>
      ) : null}
      <p style={settingLine}>
        {t(M.wordSpacing, {
          min: p.wordSpacing[0]!,
          desired: p.wordSpacing[1]!,
          max: p.wordSpacing[2]!,
        })}
      </p>
      <p style={settingLine}>
        {t(M.letterSpacing, {
          min: p.letterSpacing[0]!,
          desired: p.letterSpacing[1]!,
          max: p.letterSpacing[2]!,
        })}
      </p>
    </details>
  );
}

type Draft =
  | { kind: "tracking"; value: string }
  | { kind: "hyphenation"; value: boolean }
  | { kind: "hyphenationZone"; value: string }
  | { kind: "composer"; value: "HL Composer" | "HL Single" };

function changeOf(d: Draft): PreviewChange | null {
  switch (d.kind) {
    case "tracking": {
      const n = Number(d.value);
      return Number.isFinite(n) ? { kind: "tracking", value: n } : null;
    }
    case "hyphenationZone": {
      const n = Number(d.value);
      return Number.isFinite(n) && n >= 0
        ? { kind: "hyphenationZone", value: n }
        : null;
    }
    default:
      return d;
  }
}

function Preview({ report }: { report: LineEvidenceReport }) {
  const strings = useStrings();
  const client = useCanvasClient();
  const target = useTypographyTarget();
  const [draft, setDraft] = useState<Draft>({ kind: "tracking", value: "-10" });
  const [result, setResult] = useState<LineEvidenceReport | null>(null);
  const t = (k: string, p?: Record<string, string | number>) => strings.t(k, p);
  const selection = target?.selection ?? null;
  const [start, end] = changeRange(report, selection);
  const change = changeOf(draft);
  const mutation = change
    ? previewMutation(report.storyId, start, end, change)
    : null;
  const run = () => {
    if (!mutation) return;
    void client
      .lineEvidence({ story: report.storyId, preview: mutation })
      .then(setResult)
      .catch(() => setResult(null));
  };
  const apply = () => {
    if (!mutation) return;
    void client
      .mutate(mutation)
      .then(() => setResult(null))
      .catch(() => undefined);
  };
  const now = evidenceSummary(report);
  const then = result ? evidenceSummary(result) : null;
  return (
    <section data-typography-preview style={card}>
      <div style={summary}>{t(M.preview)}</div>
      <div style={{ display: "flex", gap: space[2], flexWrap: "wrap" }}>
        <select
          data-typography-change
          value={draft.kind}
          onChange={(e) => {
            const kind = e.target.value as Draft["kind"];
            setResult(null);
            setDraft(
              kind === "tracking"
                ? { kind, value: "-10" }
                : kind === "hyphenationZone"
                  ? { kind, value: "36" }
                  : kind === "hyphenation"
                    ? { kind, value: false }
                    : { kind: "composer", value: "HL Single" },
            );
          }}
        >
          <option value="tracking">{t(M.tracking)}</option>
          <option value="hyphenation">{t(M.hyphenation)}</option>
          <option value="hyphenationZone">{t(M.hyphenationZone)}</option>
          <option value="composer">{t(M.composerField)}</option>
        </select>
        {draft.kind === "tracking" || draft.kind === "hyphenationZone" ? (
          <input
            data-typography-value
            type="text"
            inputMode="decimal"
            value={draft.value}
            onChange={(e) => {
              setResult(null);
              setDraft({ ...draft, value: e.target.value });
            }}
            style={{ width: 64 }}
          />
        ) : draft.kind === "hyphenation" ? (
          <select
            data-typography-value
            value={draft.value ? "on" : "off"}
            onChange={(e) => {
              setResult(null);
              setDraft({ kind: "hyphenation", value: e.target.value === "on" });
            }}
          >
            <option value="on">{t(M.on)}</option>
            <option value="off">{t(M.off)}</option>
          </select>
        ) : (
          <select
            data-typography-value
            value={draft.value}
            onChange={(e) => {
              setResult(null);
              setDraft({
                kind: "composer",
                value: e.target.value as "HL Composer" | "HL Single",
              });
            }}
          >
            <option value="HL Composer">{t(M.composerParagraph)}</option>
            <option value="HL Single">{t(M.composerSingleLine)}</option>
          </select>
        )}
        <button
          type="button"
          data-typography-run
          disabled={!mutation}
          onClick={run}
        >
          {t(M.previewButton)}
        </button>
      </div>
      <div style={muted}>
        {t(M.previewScope, {
          scope: selection ? t(M.scopeParagraph) : t(M.scopeStory),
        })}
      </div>
      {result ? (
        result.preview && then ? (
          <div data-typography-preview-result={then.lines}>
            <p style={{ margin: 0 }}>
              {t(M.previewResult, {
                lines: then.lines,
                linesNow: now.lines,
                loose: then.loose,
                looseNow: now.loose,
                tight: then.tight,
                tightNow: now.tight,
                hyphens: then.hyphens,
                hyphensNow: now.hyphens,
              })}
            </p>
            <div style={{ display: "flex", gap: space[2] }}>
              <button type="button" data-typography-apply onClick={apply}>
                {t(M.apply)}
              </button>
              <button
                type="button"
                data-typography-discard
                onClick={() => setResult(null)}
              >
                {t(M.discard)}
              </button>
            </div>
          </div>
        ) : (
          <p data-typography-preview-refused style={muted}>
            {t(M.previewRefused)}
          </p>
        )
      ) : null}
    </section>
  );
}

const panel: React.CSSProperties = {
  padding: space[3],
  font: `12px ${font.sans}`,
  color: "var(--pg-fg)",
  display: "flex",
  flexDirection: "column",
  gap: space[2],
};

const kicker: React.CSSProperties = {
  font: `700 10px ${font.sans}`,
  letterSpacing: font.trackingWide,
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: `0 0 ${space[2]}`,
};

const summary: React.CSSProperties = {
  font: `600 11px ${font.sans}`,
};

const muted: React.CSSProperties = { color: "var(--pg-muted-fg)" };

const settingLine: React.CSSProperties = { margin: "2px 0" };

const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space[1],
  padding: space[2],
  border: "1px solid var(--chrome-border)",
  borderRadius: radius.md,
};

const lineRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space[2],
  padding: "2px 4px",
  border: "none",
  background: "transparent",
  color: "inherit",
  font: `11px ${font.sans}`,
  textAlign: "left",
  cursor: "pointer",
};
