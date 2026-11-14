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

// Source ↔ render inspection in the Web source panel (web ADR 416):
//
//   ElementInspector  the element in focus — picked on the canvas or
//                     clicked in the outline: its line and open tag (a
//                     button selects it and outlines it on the canvas), its
//                     selector path, its rendered size, the stylesheet
//                     rules that reach it and the diagnostics of its line;
//   PublicationNotes  what the frame's CSS asks for that a printed page
//                     cannot show, and why scripts never run;
//   SampleData        the placeholders the source uses, the ones without a
//                     value, and one click to add each.
//
// Host surfaces and React only (the bundle's rule); the source side is
// web-model's pure scanners.

import type { CSSProperties, ReactElement } from "react";

import { font, radius, space } from "@paged-media/panel-kit";
import { PX_PER_PT } from "@paged-media/helpers";
import { defineMessages, t } from "@paged-media/strings";

import {
  elementInfo,
  placeholderNames,
  printNotes,
  rulesFor,
  type PrintNoteCode,
} from "../../../web-model/src/element-inspect";
import type { InspectBox } from "../../../web-model/src/inspect";
import type { TagOutlineEntry, WebDiagnostic } from "../../../web-model/src";

export const INSPECT = defineMessages("web.inspect", {
  title: "Inspect element",
  hint: "Click an element on the canvas, or a tag in the outline, to see where it is in the source and which rules reach it.",
  line: "Line {line}",
  showInSource: "Show in source",
  selector: "Path",
  size: "Rendered size",
  sizeValue: "{width} × {height} pt",
  notPainted: "Paints no box at this size",
  rules: "Rules that apply",
  noRules: "No rule of this frame's stylesheet applies.",
  unevaluated: "not evaluated",
  unevaluatedTitle:
    "This rule names the element but needs more than the inspector evaluates (a pseudo-class, an attribute or a sibling selector); the publication rendering decides.",
  media: "@media {media}",
  lineDiagnostics: "On this line",
  notesTitle: "Publication notes",
  noteAnimation:
    "Animation has no printed form: the page shows the element without it.",
  noteTransition:
    "A transition needs interaction: the page shows the element's resting state.",
  noteInteraction:
    "Hover, focus, active and visited states never occur on a printed page.",
  noteFixedPosition:
    "Fixed and sticky positioning are for scrolling screens: on a page the element is placed once.",
  notePointer: "Cursor and pointer styling have no effect on a page.",
  scriptWhy:
    "Why: page JavaScript never runs here. The browser preview is a sandbox without permissions, and the publication is drawn natively by Paged's engine, which runs no script.",
  sampleTitle: "Sample data",
  sampleHint:
    "The placeholders this source uses; the preview shows them with these values as you type. Saved with the source.",
  sampleMissing: "{name} has no value",
  sampleAdd: "Add {name}",
  sampleNone: "This source uses no {example} placeholders.",
  sampleAll: "Every placeholder has a value.",
});

const NOTE_TEXT: Record<PrintNoteCode, string> = {
  animation: INSPECT.noteAnimation,
  transition: INSPECT.noteTransition,
  interaction: INSPECT.noteInteraction,
  fixedPosition: INSPECT.noteFixedPosition,
  pointer: INSPECT.notePointer,
};

const kicker: CSSProperties = {
  font: `700 10px ${font.sans}`,
  letterSpacing: font.trackingWide,
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: `${space[3]} 0 ${space[1]}`,
};
const label: CSSProperties = {
  font: `10px ${font.sans}`,
  color: "var(--pg-muted-fg)",
  minWidth: 72,
};
const mono: CSSProperties = {
  font: `11px/1.5 ${font.mono}`,
  color: "var(--pg-fg)",
  wordBreak: "break-all",
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: space[2],
  margin: `0 0 ${space[1]}`,
};
const note: CSSProperties = {
  font: `10px/1.5 ${font.sans}`,
  color: "var(--pg-muted-fg)",
};
const smallButton: CSSProperties = {
  font: `500 11px ${font.sans}`,
  color: "var(--pg-fg)",
  background: "var(--pg-bg)",
  border: "1px solid var(--pg-border)",
  borderRadius: radius.sm,
  padding: "2px 8px",
  cursor: "pointer",
};

const round = (v: number) => Math.round(v * 10) / 10;

/** The element in focus. */
export function ElementInspector({
  html,
  css,
  outline,
  index,
  boxes,
  diagnostics,
  onShowInSource,
}: {
  html: string;
  css: string;
  outline: readonly TagOutlineEntry[];
  /** The outline entry in focus, or null. */
  index: number | null;
  /** Its painted boxes (the inspected render's px), or null while unknown. */
  boxes: readonly InspectBox[] | null;
  diagnostics: readonly WebDiagnostic[];
  onShowInSource: (index: number) => void;
}): ReactElement {
  const info = index === null ? null : elementInfo(html, index, outline);
  return (
    <div data-web-inspect={info ? "element" : "empty"}>
      <div style={kicker}>{t(INSPECT.title)}</div>
      {!info || index === null ? (
        <div style={note}>{t(INSPECT.hint)}</div>
      ) : (
        <InspectBody
          info={info}
          index={index}
          css={css}
          boxes={boxes}
          diagnostics={diagnostics}
          onShowInSource={onShowInSource}
        />
      )}
    </div>
  );
}

function InspectBody({
  info,
  index,
  css,
  boxes,
  diagnostics,
  onShowInSource,
}: {
  info: NonNullable<ReturnType<typeof elementInfo>>;
  index: number;
  css: string;
  boxes: readonly InspectBox[] | null;
  diagnostics: readonly WebDiagnostic[];
  onShowInSource: (index: number) => void;
}): ReactElement {
  const rules = rulesFor(css, info.path);
  const here = diagnostics.filter((d) => d.line === info.line);
  const box = boxes?.[0] ?? null;
  return (
    <>
      <div style={row}>
        <span style={label}>{t(INSPECT.line, { line: info.line })}</span>
        <code data-web-inspect-tag style={mono}>
          {info.openTag}
        </code>
        <button
          type="button"
          data-web-inspect-show
          onClick={() => onShowInSource(index)}
          style={smallButton}
        >
          {t(INSPECT.showInSource)}
        </button>
      </div>
      <div style={row}>
        <span style={label}>{t(INSPECT.selector)}</span>
        <code data-web-inspect-selector style={mono}>
          {info.selector}
        </code>
      </div>
      <div style={row}>
        <span style={label}>{t(INSPECT.size)}</span>
        <span data-web-inspect-size style={mono}>
          {boxes === null
            ? "…"
            : box
              ? t(INSPECT.sizeValue, {
                  width: round(box.w / PX_PER_PT),
                  height: round(box.h / PX_PER_PT),
                })
              : t(INSPECT.notPainted)}
        </span>
      </div>
      <div style={{ ...label, margin: `${space[1]} 0` }}>
        {t(INSPECT.rules)}
      </div>
      {rules.length === 0 ? (
        <div style={note}>{t(INSPECT.noRules)}</div>
      ) : (
        <ul
          data-web-inspect-rules
          style={{ listStyle: "none", margin: 0, padding: 0 }}
        >
          {rules.map((m, i) => (
            <li
              key={i}
              data-web-inspect-rule={m.status}
              title={
                m.status === "unevaluated"
                  ? t(INSPECT.unevaluatedTitle)
                  : undefined
              }
              style={{ ...mono, margin: `0 0 ${space[1]}` }}
            >
              <span style={{ color: "var(--pg-muted-fg)" }}>
                {m.rule.line}:{" "}
              </span>
              {m.rule.media
                ? `${t(INSPECT.media, { media: m.rule.media })} `
                : ""}
              <strong>{m.rule.selector}</strong>
              {" { "}
              {m.rule.body}
              {" }"}
              {m.status === "unevaluated" ? (
                <span style={note}> · {t(INSPECT.unevaluated)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {here.length > 0 ? (
        <>
          <div style={{ ...label, margin: `${space[1]} 0` }}>
            {t(INSPECT.lineDiagnostics)}
          </div>
          {here.map((d, i) => (
            <div key={i} data-web-inspect-diagnostic style={mono}>
              {d.message}
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}

/** What the page cannot show, from the stylesheet; and why no script runs,
 *  when the source has one. */
export function PublicationNotes({
  css,
  diagnostics,
}: {
  css: string;
  diagnostics: readonly WebDiagnostic[];
}): ReactElement | null {
  const notes = printNotes(css);
  const scripted = diagnostics.some(
    (d) =>
      d.source === "html" &&
      (/<script>|JavaScript/i.test(d.message) ||
        /event-handler/.test(d.message)),
  );
  if (notes.length === 0 && !scripted) return null;
  return (
    <div data-web-publication-notes>
      <div style={kicker}>{t(INSPECT.notesTitle)}</div>
      {notes.map((n, i) => (
        <div key={i} data-web-print-note={n.code} style={row}>
          <code style={{ ...mono, minWidth: 28 }}>{n.line}</code>
          <span style={note}>
            <code style={mono}>{n.feature}</code> — {t(NOTE_TEXT[n.code])}
          </span>
        </div>
      ))}
      {scripted ? (
        <div data-web-script-why style={note}>
          {t(INSPECT.scriptWhy)}
        </div>
      ) : null}
    </div>
  );
}

/** The placeholders of the source and their values: the ones missing, with
 *  one click to add each. */
export function SampleData({
  html,
  css,
  vars,
  onAdd,
}: {
  html: string;
  css: string;
  vars: Readonly<Record<string, string>> | undefined;
  onAdd: (name: string) => void;
}): ReactElement {
  const names = placeholderNames(`${html}\n${css}`);
  const missing = names.filter(
    (n) => !vars || !Object.prototype.hasOwnProperty.call(vars, n),
  );
  return (
    <div data-web-sample-data={missing.length}>
      <div style={kicker}>{t(INSPECT.sampleTitle)}</div>
      <div style={note}>
        {names.length === 0
          ? t(INSPECT.sampleNone, { example: "{{name}}" })
          : missing.length === 0
            ? t(INSPECT.sampleAll)
            : t(INSPECT.sampleHint)}
      </div>
      {missing.map((name) => (
        <div key={name} style={{ ...row, margin: `${space[1]} 0 0` }}>
          <span data-web-sample-missing={name} style={mono}>
            {t(INSPECT.sampleMissing, { name: `{{${name}}}` })}
          </span>
          <button
            type="button"
            data-web-sample-add={name}
            onClick={() => onAdd(name)}
            style={smallButton}
          >
            {t(INSPECT.sampleAdd, { name })}
          </button>
        </div>
      ))}
    </div>
  );
}
