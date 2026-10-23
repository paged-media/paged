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

// Wave 6 — the workbook panel's FORMAT & LAYOUT section (borders, merge,
// column width / row height, the freeze toggle) and its NAMES section (the
// name manager). Thin glue: every control forwards one session verb, every
// rule (validation, dedup, the xlsx records, what a name resolves to) is the
// engine's, and each verb's message shows verbatim.
//
// One home per setting: number format, font, fill, alignment / wrap and
// iterative calculation are rows of the Sheet properties panel. Where the
// host renders that panel, this section shows a one-line pointer to it
// instead of a second set of controls; where it does not, the controls
// render here.

import { onDidChangeOf, useLive } from "@paged-media/react-live";
import { useState, type CSSProperties, type ReactElement } from "react";

import type { CellStylePatch, EdgeStyle } from "../engine";
import type { BorderKind, SessionResult, WorkbookSession } from "../session";
import { font, space } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";

import { FORMAT, NAMES, TOKENS } from "../messages";

/** Number-format presets — format CODES offered as a starting point (the
 *  engine renders them; "Custom" takes any code). `label` is a message key. */
export const NUMBER_FORMAT_PRESETS: { label: string; code: string }[] = [
  { label: FORMAT.presetGeneral, code: "General" },
  { label: FORMAT.presetInteger, code: "0" },
  { label: FORMAT.presetDecimal, code: "0.00" },
  { label: FORMAT.presetThousands, code: "#,##0" },
  { label: FORMAT.presetThousands2, code: "#,##0.00" },
  { label: FORMAT.presetPercent, code: "0%" },
  { label: FORMAT.presetPercent2, code: "0.00%" },
  { label: FORMAT.presetScientific, code: "0.00E+00" },
  { label: FORMAT.presetDateIso, code: "yyyy-mm-dd" },
  { label: FORMAT.presetDateShort, code: "d-mmm-yy" },
  { label: FORMAT.presetTime, code: "h:mm" },
  { label: FORMAT.presetEuro, code: "#,##0.00 [$€-407]" },
  { label: FORMAT.presetText, code: "@" },
];

const BORDER_STYLES = [
  "thin",
  "medium",
  "thick",
  "dashed",
  "dotted",
  "double",
  "hair",
];
const H_ALIGNS = ["general", "left", "center", "right", "justify"];
const V_ALIGNS = ["bottom", "center", "top"];

/** "center" → "Center": an engine enum value as a sentence-case label. */
export const labelOf = (value: string): string =>
  value ? value[0].toUpperCase() + value.slice(1) : value;

/** An engine token's label in the editor's locale: its message where one
 *  is defined, else `labelOf`. */
export const tokenLabel = (
  t: (key: string) => string,
  value: string,
): string =>
  Object.hasOwn(TOKENS, value)
    ? t(TOKENS[value as keyof typeof TOKENS])
    : labelOf(value);

export interface FormatSectionStyles {
  kicker: CSSProperties;
  body: CSSProperties;
  input: CSSProperties;
  button: CSSProperties;
  row: CSSProperties;
}

const linkButton: CSSProperties = {
  font: "inherit",
  color: "var(--pg-primary)",
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline",
};

/** The format & layout controls (rendered inside the workbook panel). */
export function FormatSection(props: {
  session: WorkbookSession;
  styles: FormatSectionStyles;
  /** Opens the Sheet properties panel when the host renders it; the rows
   *  that panel carries then live there only. Absent = render them here. */
  openProperties?: () => void;
}): ReactElement {
  const { session, styles: st, openProperties } = props;
  const { t } = useStrings();
  const [msg, setMsg] = useState<string | null>(null);
  const report = (r: SessionResult, done: string) =>
    setMsg(r.ok ? done : r.message);

  // Read the session during render through a view that changes with it
  // (react-live, editor ADR 229): the session object itself never does.
  const live = useLive(session, onDidChangeOf);
  const target = live.formatTarget();
  const cur = live.styleAtTarget();
  const layout = live.layout();

  const [borderStyle, setBorderStyle] = useState("thin");
  const [borderColor, setBorderColor] = useState("#000000");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");

  const apply = (patch: CellStylePatch, done: string) =>
    report(session.setStyle(patch), done);
  const edge: EdgeStyle = { style: borderStyle, color: borderColor };
  const borders = (kind: BorderKind, done: string) =>
    report(session.setBorders(kind, edge), done);
  const frozen = !!layout && (layout.freezeRows > 0 || layout.freezeCols > 0);

  const summary = cur
    ? [
        cur.numFmt,
        [cur.fontName, cur.fontSize ? `${cur.fontSize} pt` : null]
          .filter(Boolean)
          .join(" "),
        cur.bold ? t(FORMAT.bold) : null,
        cur.italic ? t(FORMAT.italic) : null,
        cur.underline ? t(FORMAT.underline) : null,
        cur.fill ? t(FORMAT.fillSummary, { color: cur.fill }) : null,
        cur.hAlign !== "general"
          ? t(FORMAT.alignSummary, { align: cur.hAlign ?? "" })
          : null,
        cur.wrap ? t(FORMAT.wrapSummary) : null,
      ]
        .filter((p) => p)
        .join(" · ")
    : null;

  return (
    <div data-sheet-format-section>
      <div style={{ ...st.kicker, marginTop: 0 }}>
        {t(FORMAT.kicker)}
        {target ? ` (${target.range})` : ""}
      </div>
      {summary && (
        <div data-sheet-fmt-current style={{ ...st.body, opacity: 0.8 }}>
          {summary}
        </div>
      )}

      {openProperties ? (
        <p
          data-sheet-fmt-pointer
          style={{ ...st.body, margin: `${space[1]} 0 0` }}
        >
          {t(FORMAT.pointer)}{" "}
          <button
            type="button"
            data-sheet-open-properties
            onClick={openProperties}
            style={linkButton}
          >
            {t(FORMAT.properties)}
          </button>
          .
        </p>
      ) : (
        <DuplicatedFormatRows
          session={session}
          styles={st}
          apply={apply}
          report={report}
        />
      )}

      {/* Borders. */}
      <div style={st.row}>
        <select
          data-sheet-fmt-border-style
          value={borderStyle}
          aria-label={t(FORMAT.borderStyle)}
          onChange={(e) => setBorderStyle(e.target.value)}
          style={st.input}
        >
          {BORDER_STYLES.map((b) => (
            <option key={b} value={b}>
              {tokenLabel(t, b)}
            </option>
          ))}
        </select>
        <input
          data-sheet-fmt-border-color
          type="color"
          value={borderColor}
          onChange={(e) => setBorderColor(e.target.value)}
          title={t(FORMAT.borderColour)}
        />
        {(
          ["all", "outline", "top", "bottom", "left", "right", "none"] as const
        ).map((k) => (
          <button
            key={k}
            type="button"
            data-sheet-fmt-border={k}
            style={st.button}
            onClick={() =>
              borders(
                k,
                k === "none"
                  ? t(FORMAT.bordersRemoved)
                  : t(FORMAT.bordersApplied, { edges: tokenLabel(t, k) }),
              )
            }
          >
            {tokenLabel(t, k)}
          </button>
        ))}
      </div>

      <div style={st.kicker}>{t(FORMAT.layout)}</div>
      <div style={st.row}>
        <button
          type="button"
          data-sheet-merge
          style={st.button}
          onClick={() => report(session.mergeTarget(), t(FORMAT.merged))}
        >
          {t(FORMAT.merge)}
        </button>
        <button
          type="button"
          data-sheet-unmerge
          style={st.button}
          onClick={() => report(session.unmergeTarget(), t(FORMAT.unmerged))}
        >
          {t(FORMAT.unmerge)}
        </button>
        <button
          type="button"
          data-sheet-freeze
          style={st.button}
          aria-pressed={frozen}
          onClick={() =>
            report(
              session.toggleFreeze(),
              frozen ? t(FORMAT.unfrozen) : t(FORMAT.frozen),
            )
          }
        >
          {frozen
            ? `${t(FORMAT.unfreeze)} (${layout!.freezeRows} × ${layout!.freezeCols})`
            : t(FORMAT.freeze)}
        </button>
      </div>
      <div style={st.row}>
        <input
          data-sheet-col-width
          type="number"
          min={0}
          max={255}
          value={width}
          placeholder={t(FORMAT.widthPlaceholder)}
          aria-label={t(FORMAT.widthAria)}
          onChange={(e) => setWidth(e.target.value)}
          style={{ ...st.input, width: 80 }}
        />
        <button
          type="button"
          data-sheet-col-width-set
          style={st.button}
          disabled={!width.trim()}
          title={width.trim() ? undefined : t(FORMAT.widthFirst)}
          onClick={() =>
            report(session.setColumnWidth(Number(width)), t(FORMAT.widthSet))
          }
        >
          {t(FORMAT.setWidth)}
        </button>
        <button
          type="button"
          data-sheet-col-width-reset
          style={st.button}
          onClick={() =>
            report(session.setColumnWidth(null), t(FORMAT.widthReset))
          }
        >
          {t(FORMAT.default)}
        </button>
      </div>
      <div style={st.row}>
        <input
          data-sheet-row-height
          type="number"
          min={0}
          max={409}
          value={height}
          placeholder={t(FORMAT.heightPlaceholder)}
          aria-label={t(FORMAT.heightAria)}
          onChange={(e) => setHeight(e.target.value)}
          style={{ ...st.input, width: 80 }}
        />
        <button
          type="button"
          data-sheet-row-height-set
          style={st.button}
          disabled={!height.trim()}
          title={height.trim() ? undefined : t(FORMAT.heightFirst)}
          onClick={() =>
            report(session.setRowHeight(Number(height)), t(FORMAT.heightSet))
          }
        >
          {t(FORMAT.setHeight)}
        </button>
        <button
          type="button"
          data-sheet-row-height-reset
          style={st.button}
          onClick={() =>
            report(session.setRowHeight(null), t(FORMAT.heightReset))
          }
        >
          {t(FORMAT.default)}
        </button>
      </div>

      {msg && (
        <div
          data-sheet-format-msg
          role="status"
          style={{ ...st.body, marginTop: 4 }}
        >
          {msg}
        </div>
      )}
    </div>
  );
}

/** Number format, font, fill, alignment / wrap and iterative calculation:
 *  the rows the Sheet properties panel also carries. Rendered only on a
 *  host without that panel (see the file header). */
function DuplicatedFormatRows(props: {
  session: WorkbookSession;
  styles: FormatSectionStyles;
  apply: (patch: CellStylePatch, done: string) => void;
  report: (r: SessionResult, done: string) => void;
}): ReactElement {
  const { session, styles: st, apply, report } = props;
  const { t } = useStrings();
  const live = useLive(session, onDidChangeOf);
  const cur = live.styleAtTarget();
  const [preset, setPreset] = useState("0.00");
  const [custom, setCustom] = useState("");
  const [fontName, setFontName] = useState("");
  const [fontSize, setFontSize] = useState("");
  const [fontColor, setFontColor] = useState("#000000");
  const [fill, setFill] = useState("#FFFF00");
  return (
    <>
      {/* Number format: a preset or a custom code. */}
      <div style={st.row}>
        <select
          data-sheet-fmt-numfmt
          value={preset}
          aria-label={t(FORMAT.numberFormat)}
          onChange={(e) => setPreset(e.target.value)}
          style={st.input}
        >
          {NUMBER_FORMAT_PRESETS.map((p) => (
            <option key={p.code} value={p.code}>
              {t(p.label)}
            </option>
          ))}
        </select>
        <input
          data-sheet-fmt-numfmt-custom
          type="text"
          value={custom}
          placeholder={t(FORMAT.customCode)}
          aria-label={t(FORMAT.customCodeAria)}
          onChange={(e) => setCustom(e.target.value)}
          style={{ ...st.input, width: 110 }}
        />
        <button
          type="button"
          data-sheet-fmt-numfmt-apply
          style={st.button}
          onClick={() =>
            apply(
              { numFmt: custom.trim() || preset },
              t(FORMAT.numberFormatApplied),
            )
          }
        >
          {t(FORMAT.numberFormat)}
        </button>
      </div>

      {/* Font. */}
      <div style={st.row}>
        <button
          type="button"
          data-sheet-fmt-bold
          style={{ ...st.button, fontWeight: 700 }}
          aria-pressed={!!cur?.bold}
          aria-label={t(FORMAT.boldLabel)}
          title={t(FORMAT.boldLabel)}
          onClick={() => apply({ bold: !cur?.bold }, t(FORMAT.boldToggled))}
        >
          B
        </button>
        <button
          type="button"
          data-sheet-fmt-italic
          style={{ ...st.button, fontStyle: "italic" }}
          aria-pressed={!!cur?.italic}
          aria-label={t(FORMAT.italicLabel)}
          title={t(FORMAT.italicLabel)}
          onClick={() =>
            apply({ italic: !cur?.italic }, t(FORMAT.italicToggled))
          }
        >
          I
        </button>
        <button
          type="button"
          data-sheet-fmt-underline
          style={{ ...st.button, textDecoration: "underline" }}
          aria-pressed={!!cur?.underline}
          aria-label={t(FORMAT.underlineLabel)}
          title={t(FORMAT.underlineLabel)}
          onClick={() =>
            apply({ underline: !cur?.underline }, t(FORMAT.underlineToggled))
          }
        >
          U
        </button>
        <input
          data-sheet-fmt-font-name
          type="text"
          value={fontName}
          placeholder={cur?.fontName ?? t(FORMAT.font)}
          aria-label={t(FORMAT.fontName)}
          onChange={(e) => setFontName(e.target.value)}
          style={{ ...st.input, width: 90 }}
        />
        <input
          data-sheet-fmt-font-size
          type="number"
          min={1}
          max={409}
          value={fontSize}
          placeholder={cur?.fontSize ? String(cur.fontSize) : "pt"}
          aria-label={t(FORMAT.fontSize)}
          onChange={(e) => setFontSize(e.target.value)}
          style={{ ...st.input, width: 48 }}
        />
        <input
          data-sheet-fmt-font-color
          type="color"
          value={fontColor}
          onChange={(e) => setFontColor(e.target.value)}
          title={t(FORMAT.textColour)}
        />
        <button
          type="button"
          data-sheet-fmt-font-apply
          style={st.button}
          onClick={() =>
            apply(
              {
                ...(fontName.trim() ? { fontName: fontName.trim() } : {}),
                ...(fontSize.trim() ? { fontSize: Number(fontSize) } : {}),
                fontColor,
              },
              t(FORMAT.fontApplied),
            )
          }
        >
          {t(FORMAT.font)}
        </button>
      </div>

      {/* Fill. */}
      <div style={st.row}>
        <input
          data-sheet-fmt-fill
          type="color"
          value={fill}
          onChange={(e) => setFill(e.target.value)}
          title={t(FORMAT.fillColour)}
        />
        <button
          type="button"
          data-sheet-fmt-fill-apply
          style={st.button}
          onClick={() => apply({ fill }, t(FORMAT.fillApplied))}
        >
          {t(FORMAT.fill)}
        </button>
        <button
          type="button"
          data-sheet-fmt-fill-clear
          style={st.button}
          onClick={() => apply({ fill: "" }, t(FORMAT.fillCleared))}
        >
          {t(FORMAT.noFill)}
        </button>
      </div>

      {/* Alignment + wrap. */}
      <div style={st.row}>
        <select
          data-sheet-fmt-halign
          value={cur?.hAlign ?? "general"}
          aria-label={t(FORMAT.hAlign)}
          onChange={(e) =>
            apply({ hAlign: e.target.value }, t(FORMAT.alignApplied))
          }
          style={st.input}
        >
          {H_ALIGNS.map((a) => (
            <option key={a} value={a}>
              {tokenLabel(t, a)}
            </option>
          ))}
        </select>
        <select
          data-sheet-fmt-valign
          value={cur?.vAlign ?? "bottom"}
          aria-label={t(FORMAT.vAlign)}
          onChange={(e) =>
            apply({ vAlign: e.target.value }, t(FORMAT.vAlignApplied))
          }
          style={st.input}
        >
          {V_ALIGNS.map((a) => (
            <option key={a} value={a}>
              {tokenLabel(t, a)}
            </option>
          ))}
        </select>
        <label
          style={{ ...st.body, display: "flex", alignItems: "center", gap: 4 }}
        >
          <input
            data-sheet-fmt-wrap
            type="checkbox"
            checked={!!cur?.wrap}
            onChange={(e) =>
              apply(
                { wrap: e.target.checked },
                e.target.checked ? t(FORMAT.wrapOn) : t(FORMAT.wrapOff),
              )
            }
          />
          {t(FORMAT.wrap)}
        </label>
      </div>

      {/* Iterative calculation (a workbook setting; Sheet properties ▸ Workbook). */}
      <label
        style={{
          ...st.body,
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginTop: space[1],
        }}
      >
        <input
          data-sheet-iterative
          type="checkbox"
          checked={live.calcSettings()?.iterative ?? false}
          onChange={(e) =>
            report(
              session.setIterative(e.target.checked),
              e.target.checked ? t(FORMAT.iterativeOn) : t(FORMAT.iterativeOff),
            )
          }
        />
        {t(FORMAT.iterative)}
      </label>
    </>
  );
}

/** The name manager: define a name, place or delete an existing one. */
export function NamesSection(props: {
  session: WorkbookSession;
  styles: FormatSectionStyles;
}): ReactElement {
  const { session, styles: st } = props;
  const { t } = useStrings();
  const [msg, setMsg] = useState<string | null>(null);
  const report = (r: SessionResult, done: string) =>
    setMsg(r.ok ? done : r.message);
  const live = useLive(session, onDidChangeOf);
  const target = live.formatTarget();
  const names = live.names();
  const [nameNew, setNameNew] = useState("");
  const [nameRefers, setNameRefers] = useState("");
  const [nameLocal, setNameLocal] = useState(false);

  return (
    <div data-sheet-names-section>
      <div style={st.row}>
        <input
          data-sheet-name-new
          type="text"
          value={nameNew}
          placeholder={t(NAMES.name)}
          aria-label={t(NAMES.name)}
          onChange={(e) => setNameNew(e.target.value)}
          style={{ ...st.input, width: 90 }}
        />
        <input
          data-sheet-name-refers
          type="text"
          value={nameRefers}
          placeholder={target?.range ?? "A1:B5"}
          aria-label={t(NAMES.refersTo)}
          onChange={(e) => setNameRefers(e.target.value)}
          style={{ ...st.input, width: 90 }}
        />
        <label
          style={{ ...st.body, display: "flex", alignItems: "center", gap: 4 }}
        >
          <input
            data-sheet-name-local
            type="checkbox"
            checked={nameLocal}
            onChange={(e) => setNameLocal(e.target.checked)}
          />
          {t(NAMES.thisSheetOnly)}
        </label>
        <button
          type="button"
          data-sheet-name-define
          style={st.button}
          disabled={!nameNew.trim()}
          title={nameNew.trim() ? undefined : t(NAMES.nameFirst)}
          onClick={() =>
            report(
              session.defineName(
                nameNew,
                nameRefers.trim() || undefined,
                nameLocal,
              ),
              t(NAMES.defined, { name: nameNew.trim() }),
            )
          }
        >
          {t(NAMES.define)}
        </button>
      </div>
      {names.length > 0 && (
        <ul
          data-sheet-names
          style={{ ...st.body, margin: "4px 0 0", paddingLeft: 16 }}
        >
          {names.map((n) => (
            <li key={`${n.name}:${n.scope ?? "wb"}`}>
              <span style={{ fontFamily: font.mono }}>{n.name}</span>
              {n.scope != null ? t(NAMES.thisSheet) : ""} = {n.refersTo}{" "}
              <button
                type="button"
                data-sheet-name-place={n.name}
                style={st.button}
                title={t(NAMES.placeTitle)}
                onClick={() =>
                  void session
                    .placeName(n.name)
                    .then((id) =>
                      setMsg(
                        id
                          ? t(NAMES.placed, { name: n.name })
                          : t(NAMES.notARange, { name: n.name }),
                      ),
                    )
                }
              >
                {t(NAMES.place)}
              </button>{" "}
              <button
                type="button"
                data-sheet-name-delete={n.name}
                style={st.button}
                onClick={() =>
                  report(
                    session.deleteName(n.name, n.scope ?? null),
                    t(NAMES.deleted, { name: n.name }),
                  )
                }
              >
                {t(NAMES.delete)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <div
          data-sheet-names-msg
          role="status"
          style={{ ...st.body, marginTop: 4 }}
        >
          {msg}
        </div>
      )}
    </div>
  );
}
