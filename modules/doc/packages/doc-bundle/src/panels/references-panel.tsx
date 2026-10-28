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

// Word's References and Insert dialogs as one panel (doc ADR 612): a
// bookmark at the caret, a cross-reference to a bookmark or a heading, a
// field by its code, an index entry, a footnote or endnote with its text,
// and the page setup of the caret's section. Each button is one engine
// mutation at the caret (word/structure.ts). The host has no modal dialog
// door, so the dialogs are sections of a docked panel; the commands that
// open them name the section (`openPanel(id, { target })`).

import type { PanelProps } from "@paged-media/plugin-api";
import { t as tActive, useStrings } from "@paged-media/strings";
import * as React from "react";

import { WORD } from "../messages.js";
import type { PanelDescriptor } from "./outline-panel.js";

/** The panel's sections, by the `target` that opens each. */
export type ReferencesSection =
  | "bookmark"
  | "crossReference"
  | "field"
  | "indexEntry"
  | "notes"
  | "pageSetup";

/** What the cross-reference list offers: a bookmark, or a heading. */
export interface ReferenceTarget {
  label: string;
  target: { bookmark: string } | { storyId: string; paragraph: number };
}

/** The page setup of the caret's section, in points. */
export interface PageSetup {
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  marginRightPt: number;
  columns: number;
}

export interface ReferencesActions {
  insertBookmark(name: string): Promise<boolean>;
  /** The bookmarks and headings a cross-reference can point at. */
  targets(): Promise<ReferenceTarget[]>;
  insertCrossReference(
    target: ReferenceTarget["target"],
    referTo: "text" | "pageNumber" | "aboveBelow",
  ): Promise<boolean>;
  insertField(code: string): Promise<boolean>;
  insertIndexEntry(topic: string[]): Promise<boolean>;
  insertNote(endnote: boolean, text: string): Promise<boolean>;
  /** The caret's section's page setup; `null` outside a Word document. */
  pageSetup(): Promise<PageSetup | null>;
  applyPageSetup(setup: PageSetup): Promise<boolean>;
}

const box: React.CSSProperties = {
  borderTop: "1px solid var(--paged-border, #ddd)",
  padding: "8px 12px",
  display: "grid",
  gap: 6,
};
const row: React.CSSProperties = { display: "flex", gap: 6 };
const head: React.CSSProperties = { fontSize: 12, fontWeight: 600 };

/** One action's outcome, shown under its section. */
function useOutcome(): [string | null, (ok: boolean) => void] {
  const { t } = useStrings();
  const [msg, setMsg] = React.useState<string | null>(null);
  return [msg, (ok) => setMsg(ok ? t(WORD.refDone) : t(WORD.refRefused))];
}

function Bookmark({ actions }: { actions: ReferencesActions }) {
  const { t } = useStrings();
  const [name, setName] = React.useState("");
  const [msg, done] = useOutcome();
  return (
    <section style={box} data-ref-section="bookmark">
      <div style={head}>{t(WORD.bookmark)}</div>
      <div style={row}>
        <input
          aria-label={t(WORD.refName)}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-ref-input="bookmark"
        />
        <button
          type="button"
          disabled={!/^[A-Za-z_][\w]*$/.test(name)}
          onClick={() => void actions.insertBookmark(name).then(done)}
          data-ref-action="bookmark"
        >
          {t(WORD.refAdd)}
        </button>
      </div>
      {msg && <small data-ref-outcome="bookmark">{msg}</small>}
    </section>
  );
}

function CrossReference({ actions }: { actions: ReferencesActions }) {
  const { t } = useStrings();
  const [targets, setTargets] = React.useState<ReferenceTarget[]>([]);
  const [pick, setPick] = React.useState(0);
  const [referTo, setReferTo] = React.useState<
    "text" | "pageNumber" | "aboveBelow"
  >("text");
  const [msg, done] = useOutcome();
  React.useEffect(() => {
    let live = true;
    void actions.targets().then((x) => {
      if (live) setTargets(x);
    });
    return () => {
      live = false;
    };
  }, [actions]);
  const chosen = targets[pick];
  return (
    <section style={box} data-ref-section="crossReference">
      <div style={head}>{t(WORD.crossReference)}</div>
      <select
        aria-label={t(WORD.crossReference)}
        value={pick}
        onChange={(e) => setPick(Number(e.target.value))}
        data-ref-input="target"
      >
        {targets.map((x, i) => (
          <option key={`${i}-${x.label}`} value={i}>
            {x.label}
          </option>
        ))}
      </select>
      <div style={row}>
        <select
          aria-label={t(WORD.refInsertAs)}
          value={referTo}
          onChange={(e) => setReferTo(e.target.value as typeof referTo)}
          data-ref-input="referTo"
        >
          <option value="text">{t(WORD.refAsText)}</option>
          <option value="pageNumber">{t(WORD.refAsPage)}</option>
          <option value="aboveBelow">{t(WORD.refAsAboveBelow)}</option>
        </select>
        <button
          type="button"
          disabled={!chosen}
          onClick={() =>
            chosen &&
            void actions.insertCrossReference(chosen.target, referTo).then(done)
          }
          data-ref-action="crossReference"
        >
          {t(WORD.refInsert)}
        </button>
      </div>
      {msg && <small data-ref-outcome="crossReference">{msg}</small>}
    </section>
  );
}

function Field({ actions }: { actions: ReferencesActions }) {
  const { t } = useStrings();
  const [code, setCode] = React.useState("");
  const [msg, done] = useOutcome();
  return (
    <section style={box} data-ref-section="field">
      <div style={head}>{t(WORD.field)}</div>
      <div style={row}>
        <input
          aria-label={t(WORD.refFieldCode)}
          placeholder="PAGE"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          data-ref-input="field"
        />
        <button
          type="button"
          disabled={code.trim() === ""}
          onClick={() => void actions.insertField(code.trim()).then(done)}
          data-ref-action="field"
        >
          {t(WORD.refInsert)}
        </button>
      </div>
      {msg && <small data-ref-outcome="field">{msg}</small>}
    </section>
  );
}

function IndexEntry({ actions }: { actions: ReferencesActions }) {
  const { t } = useStrings();
  const [topic, setTopic] = React.useState("");
  const [msg, done] = useOutcome();
  const path = topic
    .split(":")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return (
    <section style={box} data-ref-section="indexEntry">
      <div style={head}>{t(WORD.indexEntry)}</div>
      <div style={row}>
        <input
          aria-label={t(WORD.refTopic)}
          placeholder="Main:Sub"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          data-ref-input="indexEntry"
        />
        <button
          type="button"
          disabled={path.length === 0 || path.length > 4}
          onClick={() => void actions.insertIndexEntry(path).then(done)}
          data-ref-action="indexEntry"
        >
          {t(WORD.refMark)}
        </button>
      </div>
      {msg && <small data-ref-outcome="indexEntry">{msg}</small>}
    </section>
  );
}

function Notes({ actions }: { actions: ReferencesActions }) {
  const { t } = useStrings();
  const [text, setText] = React.useState("");
  const [msg, done] = useOutcome();
  return (
    <section style={box} data-ref-section="notes">
      <div style={head}>{t(WORD.refNotes)}</div>
      <textarea
        aria-label={t(WORD.refNoteText)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        data-ref-input="note"
      />
      <div style={row}>
        <button
          type="button"
          onClick={() => void actions.insertNote(false, text).then(done)}
          data-ref-action="footnote"
        >
          {t(WORD.footnote)}
        </button>
        <button
          type="button"
          onClick={() => void actions.insertNote(true, text).then(done)}
          data-ref-action="endnote"
        >
          {t(WORD.endnote)}
        </button>
      </div>
      {msg && <small data-ref-outcome="notes">{msg}</small>}
    </section>
  );
}

const SIZES: Array<{ name: string; w: number; h: number }> = [
  { name: "Letter", w: 612, h: 792 },
  { name: "A4", w: 595.3, h: 841.9 },
  { name: "Legal", w: 612, h: 1008 },
  { name: "A5", w: 419.5, h: 595.3 },
];

function PageSetupSection({ actions }: { actions: ReferencesActions }) {
  const { t } = useStrings();
  const [setup, setSetup] = React.useState<PageSetup | null>(null);
  const [msg, done] = useOutcome();
  React.useEffect(() => {
    let live = true;
    void actions.pageSetup().then((s) => {
      if (live) setSetup(s);
    });
    return () => {
      live = false;
    };
  }, [actions]);
  if (!setup) {
    return (
      <section style={box} data-ref-section="pageSetup">
        <div style={head}>{t(WORD.pageSetup)}</div>
        <small>{t(WORD.refNoPageSetup)}</small>
      </section>
    );
  }
  const landscape = setup.widthPt > setup.heightPt;
  const num = (key: keyof PageSetup, label: string) => (
    <label style={{ display: "grid", fontSize: 12 }}>
      {label}
      <input
        type="number"
        value={Math.round(setup[key] * 100) / 100}
        onChange={(e) =>
          setSetup({ ...setup, [key]: Number(e.target.value) || 0 })
        }
        data-ref-input={key}
      />
    </label>
  );
  return (
    <section style={box} data-ref-section="pageSetup">
      <div style={head}>{t(WORD.pageSetup)}</div>
      <div style={row}>
        <select
          aria-label={t(WORD.refPageSize)}
          value={
            SIZES.find(
              (s) =>
                Math.abs(Math.min(setup.widthPt, setup.heightPt) - s.w) < 1 &&
                Math.abs(Math.max(setup.widthPt, setup.heightPt) - s.h) < 1,
            )?.name ?? ""
          }
          onChange={(e) => {
            const s = SIZES.find((x) => x.name === e.target.value);
            if (!s) return;
            setSetup({
              ...setup,
              widthPt: landscape ? s.h : s.w,
              heightPt: landscape ? s.w : s.h,
            });
          }}
          data-ref-input="size"
        >
          <option value="">{t(WORD.refCustom)}</option>
          {SIZES.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() =>
            setSetup({
              ...setup,
              widthPt: setup.heightPt,
              heightPt: setup.widthPt,
            })
          }
          data-ref-action="orientation"
        >
          {landscape ? t(WORD.refPortrait) : t(WORD.refLandscape)}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {num("marginTopPt", t(WORD.refTop))}
        {num("marginBottomPt", t(WORD.refBottom))}
        {num("marginLeftPt", t(WORD.refLeft))}
        {num("marginRightPt", t(WORD.refRight))}
        {num("columns", t(WORD.refColumns))}
      </div>
      <button
        type="button"
        onClick={() => void actions.applyPageSetup(setup).then(done)}
        data-ref-action="pageSetup"
      >
        {t(WORD.refApply)}
      </button>
      {msg && <small data-ref-outcome="pageSetup">{msg}</small>}
    </section>
  );
}

export function makeReferencesPanel(
  actions: ReferencesActions,
): PanelDescriptor {
  const Component: React.FC<PanelProps> = () => (
    <div style={{ fontSize: 13 }} data-doc-panel="references">
      <Bookmark actions={actions} />
      <CrossReference actions={actions} />
      <Field actions={actions} />
      <IndexEntry actions={actions} />
      <Notes actions={actions} />
      <PageSetupSection actions={actions} />
    </div>
  );
  return {
    title: tActive(WORD.references),
    component: Component,
    defaultDock: "right",
    icon: "panel-outline",
  };
}
