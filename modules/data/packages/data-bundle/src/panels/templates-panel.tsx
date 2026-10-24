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

// The Record templates panel: the library of the cells a record flow repeats
// (src/record-templates.ts). It lists the document's templates with the flows
// using each, makes one from the selected text frames (lines written as for
// Data Merge), renames and deletes, and previews a template filled with
// record N of a query. The engine keeps the library and fills the preview;
// the panel reads the session through a live view (react-live).

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { BundleHost } from "@paged-media/plugin-api";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import {
  ConfirmButton,
  Refusal,
  StatusLine,
  color,
  font,
  radius,
  space,
  status,
} from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";

import type { TemplateEntry, TemplatePreview } from "../record-templates";
import type { DataSourceSession } from "../session";
import { RECORD_TEMPLATES as M } from "../messages";

const SOURCES_PANEL_ID = "media.paged.data.panel.sources";

const wrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space[3],
  padding: space[3],
  fontSize: "12px",
  color: color.fg,
};

const note: CSSProperties = {
  color: color.mutedFg,
  fontSize: "11px",
  lineHeight: 1.5,
  margin: 0,
};

const mono: CSSProperties = { fontFamily: font.mono };

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space[2],
  flexWrap: "wrap",
};

const card = (selected: boolean): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: space[1],
  padding: space[2],
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: selected ? color.primarySoft : color.bg,
});

const well: CSSProperties = {
  margin: 0,
  padding: space[2],
  background: color.muted,
  borderRadius: radius.sm,
  fontFamily: font.mono,
  fontSize: "11px",
  whiteSpace: "pre-wrap",
  listStyle: "none",
};

export function makeTemplatesPanel(
  host: BundleHost,
  session: DataSourceSession,
): () => ReactElement {
  // A declaration, so the React Compiler sees the component (editor ADR 229).
  function TemplatesPanel(): ReactElement {
    const live = useLive(session, onDidChangeOf);
    const { t } = useStrings();
    const library = live.templateLibrary();
    const queries = live.listQueries().map((q) => q.id);

    const [name, setName] = useState("");
    const [outcome, setOutcome] = useState<{
      ok: string | null;
      error: string | null;
    }>({ ok: null, error: null });
    const [renaming, setRenaming] = useState<{ id: string; to: string } | null>(
      null,
    );
    const [selected, setSelected] = useState<string | null>(null);

    async function onCreate(): Promise<void> {
      const trimmed = name.trim();
      if (!trimmed) {
        setOutcome({ ok: null, error: t(M.needsName) });
        return;
      }
      const r = await session.createTemplateFromSelection(trimmed);
      if (r.error !== null || !r.template) {
        setOutcome({ ok: null, error: r.error });
        return;
      }
      const made = t(M.created, {
        name: r.template.id,
        count: r.template.fields.length,
      });
      setOutcome({
        ok:
          r.unreferenced && r.unreferenced.length > 0
            ? `${made} ${t(M.unreferenced, { names: r.unreferenced.join(", ") })}`
            : made,
        error: null,
      });
      setName("");
      setSelected(r.template.id);
    }

    async function onRename(): Promise<void> {
      if (!renaming) return;
      const error = await session.renameTemplate(renaming.id, renaming.to);
      setOutcome({ ok: null, error });
      if (error === null) {
        if (selected === renaming.id) setSelected(renaming.to.trim());
        setRenaming(null);
      }
    }

    async function onDelete(entry: TemplateEntry): Promise<void> {
      const error = await session.deleteTemplate(entry.template.id);
      setOutcome({ ok: null, error });
      if (error === null && selected === entry.template.id) setSelected(null);
    }

    if (library === null) {
      return (
        <div style={wrap} data-data-tmpl-idle>
          <p style={note}>{t(M.engineIdle)}</p>
          <button
            type="button"
            style={{ alignSelf: "flex-start" }}
            data-data-tmpl-open-sources
            onClick={() => host.shell.openPanel(SOURCES_PANEL_ID)}
          >
            {t(M.openSources)}
          </button>
        </div>
      );
    }

    const current = library.find((e) => e.template.id === selected) ?? null;

    return (
      <div style={wrap}>
        <p style={note}>{t(M.intro)}</p>
        <div style={row}>
          <label style={row}>
            {t(M.nameLabel)}
            <input
              type="text"
              data-data-tmpl-name
              value={name}
              placeholder={t(M.namePlaceholder)}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button
            type="button"
            data-data-tmpl-create
            title={t(M.fromSelectionTitle)}
            onClick={() => void onCreate()}
          >
            {t(M.fromSelection)}
          </button>
        </div>
        <p style={note}>{t(M.howTo)}</p>
        <StatusLine tone="ok" attr="data-data-tmpl-made">
          {outcome.ok}
        </StatusLine>
        <Refusal text={outcome.error} attr="data-data-tmpl-error" />

        {library.length === 0 ? (
          <p style={note} data-data-tmpl-empty>
            {t(M.empty)}
          </p>
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: space[2],
            }}
          >
            {library.map((entry) => {
              const tm = entry.template;
              const isRenaming = renaming?.id === tm.id;
              return (
                <li
                  key={tm.id}
                  data-data-tmpl={tm.id}
                  style={card(tm.id === selected)}
                >
                  <div style={row}>
                    {isRenaming ? (
                      <>
                        <input
                          type="text"
                          data-data-tmpl-rename-input
                          value={renaming.to}
                          aria-label={t(M.rename)}
                          onChange={(e) =>
                            setRenaming({ id: tm.id, to: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void onRename();
                            if (e.key === "Escape") setRenaming(null);
                          }}
                        />
                        <button
                          type="button"
                          data-data-tmpl-rename-save
                          onClick={() => void onRename()}
                        >
                          {t(M.renameSave)}
                        </button>
                        <button type="button" onClick={() => setRenaming(null)}>
                          {t(M.renameCancel)}
                        </button>
                      </>
                    ) : (
                      <strong style={mono}>{tm.id}</strong>
                    )}
                  </div>
                  <span style={note}>
                    {t(M.lines, {
                      count: tm.fields.length,
                      height: tm.lineHeightPt,
                    })}{" "}
                    ·{" "}
                    <span data-data-tmpl-users>
                      {entry.usedBy.length > 0
                        ? t(M.usedBy, { flows: entry.usedBy.join(", ") })
                        : t(M.unused)}
                    </span>
                  </span>
                  <ul style={well}>
                    {tm.fields.map((f, i) => (
                      <li key={i}>
                        {f.label}
                        <span style={{ color: status.info }}>
                          {f.expr === '""' ? "" : `{${f.expr}}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div style={row}>
                    <button
                      type="button"
                      data-data-tmpl-preview-open
                      onClick={() => setSelected(tm.id)}
                    >
                      {t(M.preview)}
                    </button>
                    {isRenaming ? null : (
                      <button
                        type="button"
                        data-data-tmpl-rename
                        onClick={() => setRenaming({ id: tm.id, to: tm.id })}
                      >
                        {t(M.rename)}
                      </button>
                    )}
                    <ConfirmButton
                      label={t(M.delete)}
                      confirmLabel={t(M.confirmDelete)}
                      data-data-tmpl-delete
                      disabled={entry.usedBy.length > 0}
                      title={
                        entry.usedBy.length > 0 ? t(M.deleteInUse) : undefined
                      }
                      onConfirm={() => void onDelete(entry)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {current ? (
          <TemplatePreviewSection
            key={current.template.id}
            entry={current}
            queries={queries}
          />
        ) : null}
      </div>
    );
  }

  function TemplatePreviewSection(props: {
    entry: TemplateEntry;
    queries: string[];
  }): ReactElement {
    const { entry, queries } = props;
    const { t } = useStrings();
    const live = useLive(session, onDidChangeOf);
    // The query of the first flow using the template, else the first query.
    const flowQuery = entry.usedBy
      .map((id) => live.recordFlow(id)?.query)
      .find((q): q is string => !!q);
    const [query, setQuery] = useState<string | null>(null);
    const [record, setRecord] = useState(1);
    const [preview, setPreview] = useState<
      TemplatePreview | { error: string } | null
    >(null);
    const chosen = query ?? flowQuery ?? queries[0] ?? null;

    // The preview follows the session (a refresh, a renamed field) and the
    // stepper; the engine fills it, nothing is written.
    useEffect(() => {
      if (!chosen) return;
      let current = true;
      void live.previewTemplate(entry.template.id, chosen, record).then((p) => {
        if (current) setPreview(p);
      });
      return () => {
        current = false;
      };
    }, [live, entry, chosen, record]);

    const total = preview && "total" in preview ? preview.total : 0;
    return (
      <section
        data-data-tmpl-preview-of={entry.template.id}
        style={{ display: "flex", flexDirection: "column", gap: space[2] }}
      >
        <strong>{t(M.previewOf, { name: entry.template.id })}</strong>
        {chosen === null ? (
          <p style={note}>{t(M.noQuery)}</p>
        ) : (
          <>
            <div style={row}>
              <label style={row}>
                {t(M.previewQuery)}
                <select
                  data-data-tmpl-preview-query
                  value={chosen}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setRecord(1);
                  }}
                >
                  {queries.map((q) => (
                    <option key={q} value={q}>
                      {q}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={row}>
              <button
                type="button"
                aria-label={t(M.previous)}
                title={t(M.previous)}
                data-data-tmpl-prev
                disabled={record <= 1}
                onClick={() => setRecord(Math.max(1, record - 1))}
              >
                ‹
              </button>
              <span>
                {t(M.record)}{" "}
                <span style={mono} data-data-tmpl-record>
                  {preview && "record" in preview ? preview.record : record}
                </span>{" "}
                {total > 0 ? t(M.ofTotal, { total }) : null}
              </span>
              <button
                type="button"
                aria-label={t(M.next)}
                title={t(M.next)}
                data-data-tmpl-next
                disabled={total > 0 && record >= total}
                onClick={() => setRecord(record + 1)}
              >
                ›
              </button>
            </div>
            {preview && "error" in preview ? (
              <>
                <Refusal
                  text={preview.error}
                  attr="data-data-tmpl-preview-error"
                />
                <button
                  type="button"
                  style={{ alignSelf: "flex-start" }}
                  data-data-tmpl-refresh
                  onClick={() => void session.refreshData()}
                >
                  {t(M.refreshData)}
                </button>
              </>
            ) : preview ? (
              <ul style={well} data-data-tmpl-preview>
                {preview.lines.map((l, i) => (
                  <li
                    key={i}
                    style={l.error ? { color: status.error } : undefined}
                    title={l.error}
                  >
                    {l.text}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>
    );
  }

  return TemplatesPanel;
}
