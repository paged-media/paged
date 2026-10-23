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

// The Bindings panel's "Template fields" section (ADR 560): the template's
// own text, picture and visibility fields, each bound to an expression over
// the picked query, and the button that makes the catalogue — the template's
// page once per record (or group), its fields filled from the record.

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import { color, font, space } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";

import type { CatalogueMode, TemplateFieldTarget } from "../catalogue";
import { CATALOGUE as M } from "../messages";
import type { DataSourceSession } from "../session";

const row: CSSProperties = {
  display: "flex",
  gap: space[2],
  flexWrap: "wrap",
  alignItems: "center",
};

const note: CSSProperties = {
  color: color.mutedFg,
  fontSize: "11px",
  lineHeight: 1.5,
};

const mono: CSSProperties = { fontFamily: font.mono };

export function TemplateFieldsSection(props: {
  session: DataSourceSession;
  /** The query the panel's "Records from" names (defining it if needed). */
  pickQuery: () => string | null;
  /** Changes whenever the session does, so the fields are read again. */
  version: unknown;
}): ReactElement {
  const { session, pickQuery, version } = props;
  const { t } = useStrings();
  const [targets, setTargets] = useState<TemplateFieldTarget[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [inverted, setInverted] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<CatalogueMode>("perRecord");
  const [by, setBy] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void session
      .templateFieldTargets()
      .then((list) => {
        if (live) setTargets(list);
      })
      .catch(() => {
        if (live) setTargets([]);
      });
    return () => {
      live = false;
    };
  }, [session, version]);

  async function bind(target: TemplateFieldTarget): Promise<void> {
    const query = pickQuery();
    if (!query) return;
    const expr = drafts[target.name] ?? target.binding?.expr ?? "";
    const r = await session.bindTemplateField({
      field: target.name,
      query,
      expr,
      ...((inverted[target.name] ?? target.binding?.invert)
        ? { invert: true }
        : {}),
    });
    setMessage(r.ok ? t(M.bound, { field: target.name, expr }) : r.reason);
  }

  async function run(): Promise<void> {
    const query = pickQuery();
    const r = await session.runCatalogue({
      ...(query ? { query } : {}),
      mode,
      ...(mode === "perGroup"
        ? {
            by: by
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
    });
    setMessage(r.message);
  }

  return (
    <div data-template-fields>
      <div style={row}>
        <strong title={t(M.sectionTitle)}>{t(M.section)}</strong>
      </div>
      {targets.length === 0 ? (
        <p style={note}>{t(M.noFields)}</p>
      ) : (
        <>
          {targets.map((target) => (
            <div
              key={target.name}
              style={row}
              data-template-field={target.name}
            >
              <span style={mono} title={target.kind}>
                {target.name}
              </span>
              <input
                aria-label={t(M.expr)}
                data-template-field-expr
                placeholder={t(M.expr)}
                value={drafts[target.name] ?? target.binding?.expr ?? ""}
                onChange={(e) =>
                  setDrafts({ ...drafts, [target.name]: e.target.value })
                }
                style={{ ...mono, width: 120 }}
              />
              {target.kind === "visibility" && (
                <label>
                  <input
                    type="checkbox"
                    checked={
                      inverted[target.name] ?? target.binding?.invert ?? false
                    }
                    onChange={(e) =>
                      setInverted({
                        ...inverted,
                        [target.name]: e.target.checked,
                      })
                    }
                  />{" "}
                  {t(M.invert)}
                </label>
              )}
              <button
                type="button"
                data-template-field-bind
                onClick={() => {
                  void bind(target);
                }}
              >
                {t(M.bind)}
              </button>
              {target.binding && (
                <button
                  type="button"
                  data-template-field-unbind
                  onClick={() => {
                    session.unbindTemplateField(target.name);
                  }}
                >
                  {t(M.unbind)}
                </button>
              )}
            </div>
          ))}
          <div style={row}>
            <select
              data-catalogue-mode
              value={mode}
              onChange={(e) => setMode(e.target.value as CatalogueMode)}
            >
              <option value="perRecord">{t(M.perRecord)}</option>
              <option value="perGroup">{t(M.perGroup)}</option>
            </select>
            {mode === "perGroup" && (
              <input
                data-catalogue-by
                value={by}
                onChange={(e) => setBy(e.target.value)}
                style={{ ...mono, width: 100 }}
              />
            )}
            <button
              type="button"
              data-catalogue-run
              title={t(M.runTitle)}
              onClick={() => {
                void run();
              }}
            >
              {t(M.run)}
            </button>
          </div>
        </>
      )}
      {message && (
        <p style={note} data-catalogue-msg>
          {message}
        </p>
      )}
    </div>
  );
}
