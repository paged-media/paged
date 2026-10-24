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

// The pagination inspector of a record flow: the options the engine's
// paginator implements (data-core `FlowOpts`: group by, repeated and
// continued group headers, a group footer with a count and an aggregate; and
// the template's line height, which is a record's height per line) as inline
// controls, each written at once, and beside them what the paginator makes of
// the flow over the start page's margin box, one frame per page, as lowering
// places it. Nothing is written to the document here.

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { BundleHost } from "@paged-media/plugin-api";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import {
  Refusal,
  StatusLine,
  color,
  font,
  radius,
  space,
} from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";

import type {
  FlowOptions,
  GroupFooterJson,
  PaginationSummary,
  RecordFlowRecipe,
  TemplateEntry,
} from "../record-templates";
import type { DataSourceSession } from "../session";
import { PAGINATION as M } from "../messages";

const BINDINGS_PANEL_ID = "media.paged.data.panel.bindings";

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

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space[2],
  flexWrap: "wrap",
};

const group: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space[2],
  padding: space[2],
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
};

const mono: CSSProperties = { fontFamily: font.mono };

const AGGS: { value: NonNullable<GroupFooterJson["agg"]>; label: string }[] = [
  { value: "sum", label: M.aggSum },
  { value: "avg", label: M.aggAvg },
  { value: "min", label: M.aggMin },
  { value: "max", label: M.aggMax },
];

const splitFields = (text: string): string[] =>
  text
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");

export function makePaginationPanel(
  host: BundleHost,
  session: DataSourceSession,
): () => ReactElement {
  // A declaration, so the React Compiler sees the component (editor ADR 229).
  function PaginationPanel(): ReactElement {
    const live = useLive(session, onDidChangeOf);
    const { t } = useStrings();
    const flows = live
      .listBindings()
      .filter((b) => b.kind === "recordFlow")
      .map((b) => b.id);
    const library = live.templateLibrary();
    const [picked, setPicked] = useState<string | null>(null);
    const flowId =
      picked !== null && flows.includes(picked) ? picked : (flows[0] ?? null);
    const recipe = flowId ? live.recordFlow(flowId) : null;

    if (library === null) {
      return (
        <div style={wrap} data-data-flow-idle>
          <p style={note}>{t(M.engineIdle)}</p>
        </div>
      );
    }
    if (flowId === null || recipe === null) {
      return (
        <div style={wrap} data-data-flow-empty>
          <p style={note}>{t(M.noFlow)}</p>
          <button
            type="button"
            style={{ alignSelf: "flex-start" }}
            data-data-flow-open-bindings
            onClick={() => host.shell.openPanel(BINDINGS_PANEL_ID)}
          >
            {t(M.openBindings)}
          </button>
        </div>
      );
    }

    return (
      <div style={wrap}>
        <p style={note}>{t(M.intro)}</p>
        <label style={row}>
          {t(M.flow)}
          <select
            data-data-flow-pick
            value={flowId}
            onChange={(e) => setPicked(e.target.value)}
          >
            {flows.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <FlowInspector
          key={`${flowId}\u0000${JSON.stringify(recipe)}`}
          flowId={flowId}
          recipe={recipe}
          library={library}
        />
      </div>
    );
  }

  /** The controls of one flow, keyed on its recipe: a change written
   *  elsewhere (undo, a reopened document) starts them again from it. */
  function FlowInspector(props: {
    flowId: string;
    recipe: RecordFlowRecipe;
    library: TemplateEntry[];
  }): ReactElement {
    const { flowId, recipe, library } = props;
    const { t } = useStrings();
    const live = useLive(session, onDidChangeOf);
    const opts = recipe.options;
    const template = library.find((e) => e.template.id === recipe.template);
    const [groupText, setGroupText] = useState(opts.groupBy.join(", "));
    const [footerLabel, setFooterLabel] = useState(opts.footer?.label ?? "");
    const [footerField, setFooterField] = useState(opts.footer?.sumField ?? "");
    const [lineHeight, setLineHeight] = useState(
      String(template?.template.lineHeightPt ?? ""),
    );
    const [error, setError] = useState<string | null>(null);
    // `undefined` until the first pagination answers.
    const [summary, setSummary] = useState<
      | PaginationSummary
      | { needsData: true }
      | { error: string }
      | null
      | undefined
    >(undefined);

    // The summary follows the session: every option written below, a data
    // refresh, a template's new line height. The engine paginates; nothing
    // is placed.
    useEffect(() => {
      let current = true;
      void live.paginationSummary(flowId).then((s) => {
        if (current) setSummary(s);
      });
      return () => {
        current = false;
      };
    }, [live, flowId]);

    async function write(
      next: Partial<FlowOptions>,
      tmpl = recipe.template,
    ): Promise<void> {
      setError(await session.setRecordFlow(flowId, tmpl, { ...opts, ...next }));
    }

    function footerFrom(
      label: string,
      field: string,
      agg: GroupFooterJson["agg"],
    ): GroupFooterJson {
      return {
        label,
        sumField: field.trim() === "" ? null : field.trim(),
        agg: agg ?? "sum",
      };
    }

    async function onLineHeight(): Promise<void> {
      if (!template) return;
      const pt = Number(lineHeight);
      if (pt === template.template.lineHeightPt) return;
      setError(await session.setTemplateLineHeight(template.template.id, pt));
    }

    const grouped = opts.groupBy.length > 0;
    return (
      <>
        <div style={group}>
          <label style={row}>
            {t(M.template)}
            <select
              data-data-flow-template
              value={recipe.template}
              onChange={(e) => void write({}, e.target.value)}
            >
              {library.map((e) => (
                <option key={e.template.id} value={e.template.id}>
                  {e.template.id}
                </option>
              ))}
            </select>
          </label>
          <label style={row}>
            {t(M.lineHeight)}
            <input
              type="number"
              min={1}
              step={0.5}
              style={{ width: 64 }}
              data-data-flow-line-height
              value={lineHeight}
              onChange={(e) => setLineHeight(e.target.value)}
              onBlur={() => void onLineHeight()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onLineHeight();
              }}
            />
          </label>
          {template && template.usedBy.length > 1 ? (
            <p style={note}>
              {t(M.lineHeightShared, { count: template.usedBy.length })}
            </p>
          ) : null}
        </div>

        <div style={group}>
          <label style={row}>
            {t(M.groupBy)}
            <input
              type="text"
              style={mono}
              data-data-flow-group
              value={groupText}
              placeholder={t(M.groupByPlaceholder)}
              onChange={(e) => setGroupText(e.target.value)}
              onBlur={() => void write({ groupBy: splitFields(groupText) })}
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  void write({ groupBy: splitFields(groupText) });
              }}
            />
          </label>
          <p style={note}>{t(M.groupByNote)}</p>
          <label style={row}>
            <input
              type="checkbox"
              data-data-flow-repeat
              checked={opts.repeatHeader}
              disabled={!grouped}
              onChange={(e) =>
                void write({
                  repeatHeader: e.target.checked,
                  continuedMarker: e.target.checked && opts.continuedMarker,
                })
              }
            />
            {t(M.repeatHeader)}
          </label>
          <label style={row}>
            <input
              type="checkbox"
              data-data-flow-continued
              checked={opts.continuedMarker}
              disabled={!grouped || !opts.repeatHeader}
              onChange={(e) =>
                void write({ continuedMarker: e.target.checked })
              }
            />
            {t(M.continuedMarker)}
          </label>
          <label style={row}>
            <input
              type="checkbox"
              data-data-flow-footer
              checked={!!opts.footer}
              disabled={!grouped}
              onChange={(e) =>
                void write({
                  footer: e.target.checked
                    ? footerFrom(
                        footerLabel || "{count}",
                        footerField,
                        opts.footer?.agg,
                      )
                    : null,
                })
              }
            />
            {t(M.footer)}
          </label>
          {opts.footer ? (
            <>
              <label style={row}>
                {t(M.footerLabel)}
                <input
                  type="text"
                  data-data-flow-footer-label
                  value={footerLabel}
                  onChange={(e) => setFooterLabel(e.target.value)}
                  onBlur={() =>
                    void write({
                      footer: footerFrom(
                        footerLabel,
                        footerField,
                        opts.footer?.agg,
                      ),
                    })
                  }
                />
              </label>
              <p style={note}>{t(M.footerLabelNote)}</p>
              <div style={row}>
                <label style={row}>
                  {t(M.footerField)}
                  <input
                    type="text"
                    style={{ ...mono, width: 96 }}
                    data-data-flow-footer-field
                    value={footerField}
                    onChange={(e) => setFooterField(e.target.value)}
                    onBlur={() =>
                      void write({
                        footer: footerFrom(
                          footerLabel,
                          footerField,
                          opts.footer?.agg,
                        ),
                      })
                    }
                  />
                </label>
                <label style={row}>
                  {t(M.footerAgg)}
                  <select
                    data-data-flow-footer-agg
                    value={opts.footer.agg ?? "sum"}
                    disabled={footerField.trim() === ""}
                    onChange={(e) =>
                      void write({
                        footer: footerFrom(
                          footerLabel,
                          footerField,
                          e.target.value as GroupFooterJson["agg"],
                        ),
                      })
                    }
                  >
                    {AGGS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {t(a.label)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          ) : null}
        </div>
        <Refusal text={error} attr="data-data-flow-error" />

        <section
          data-data-flow-summary
          style={{ display: "flex", flexDirection: "column", gap: space[1] }}
        >
          <strong>{t(M.summary)}</strong>
          <Summary summary={summary} />
        </section>
      </>
    );
  }

  function Summary(props: {
    summary:
      | PaginationSummary
      | { needsData: true }
      | { error: string }
      | null
      | undefined;
  }): ReactElement | null {
    const { summary } = props;
    const { t } = useStrings();
    if (summary === undefined) return null;
    if (summary === null) return <p style={note}>{t(M.noPage)}</p>;
    if ("error" in summary)
      return (
        <Refusal text={summary.error} attr="data-data-flow-summary-error" />
      );
    if ("needsData" in summary)
      return (
        <>
          <p style={note} data-data-flow-needs-data>
            {t(M.needsData)}
          </p>
          <button
            type="button"
            style={{ alignSelf: "flex-start" }}
            data-data-flow-refresh
            onClick={() => void session.refreshData()}
          >
            {t(M.refreshData)}
          </button>
        </>
      );
    const continued = summary.pages.reduce((n, p) => n + p.continued, 0);
    const tall = summary.tallestRecordPt > summary.frameHeightPt;
    return (
      <>
        <span data-data-flow-placed>
          {t(M.placed, {
            placed: summary.placed,
            total: summary.total,
            pages: summary.pages.length,
          })}
        </span>
        <span style={mono} data-data-flow-per-page>
          {t(M.perPage, {
            counts: summary.pages.map((p) => p.records).join(", "),
          })}
        </span>
        <span style={note}>
          {t(M.frameHeight, { height: round(summary.frameHeightPt) })}
        </span>
        {continued > 0 ? (
          <span style={note} data-data-flow-continued-count>
            {t(M.continued, { count: continued })}
          </span>
        ) : null}
        {summary.overflow ? (
          <StatusLine tone="error" attr="data-data-flow-overflow">
            {t(M.overflow, { count: summary.total - summary.placed })}
          </StatusLine>
        ) : null}
        {tall ? (
          <StatusLine tone="warn" attr="data-data-flow-tall">
            {t(M.tallRecord, {
              height: round(summary.tallestRecordPt),
              frame: round(summary.frameHeightPt),
            })}
          </StatusLine>
        ) : null}
      </>
    );
  }

  return PaginationPanel;
}

const round = (pt: number): number => Math.round(pt * 10) / 10;
