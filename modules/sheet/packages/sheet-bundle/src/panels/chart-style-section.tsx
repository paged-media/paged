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

// Sheet ADR 525 — the "Chart style" section of the Workbook panel: a
// chart's roles (or the workbook default's) bound to the layout document's
// swatches, paragraph and character styles and colour groups. Every write
// goes through the object model (`host.objects`): one undo step, the chart
// ops journalled with the workbook version, the placed charts redrawn by
// the session's refresh. The rules (what a default fills, what an override
// is) are Rust's; this section reads and writes ids.

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { Address, BundleHost, ObjectOp } from "@paged-media/plugin-api";
import { useStrings } from "@paged-media/strings";

import {
  CHART_ROLES,
  chartStyleChoices,
  idsOf,
  isColorRole,
  type ChartStyleChoices,
  type ChartStyleIds,
  type RoleIds,
} from "../chart-style";
import { CHART_STYLE as M } from "../messages";
import { addressOf, WORKBOOK_ADDRESS } from "../object-model";
import type { WorkbookSession } from "../session";

export interface ChartStyleSectionStyles {
  body: CSSProperties;
  input: CSSProperties;
  button: CSSProperties;
  row: CSSProperties;
  note: CSSProperties;
}

const ROLE_LABELS: Record<string, keyof typeof M> = {
  chartArea: "chartArea",
  plotArea: "plotArea",
  axisLine: "axisLine",
  gridlines: "gridlines",
  text: "text",
  title: "title2",
  axisTitle: "axisTitle",
  tickLabels: "tickLabels",
  legend: "legend",
  dataLabels: "dataLabels",
};

const DEFAULT_TARGET = "default";

const EMPTY_CHOICES: ChartStyleChoices = {
  swatches: [],
  paragraphStyles: [],
  characterStyles: [],
  colorGroups: [],
};

/** The document's choices, re-read when its styles may have changed. */
function useChoices(
  host: BundleHost,
  session: WorkbookSession,
  revision: number,
): ChartStyleChoices {
  const [choices, setChoices] = useState<ChartStyleChoices>(EMPTY_CHOICES);
  useEffect(() => {
    let live = true;
    void chartStyleChoices(host, session).then((c) => {
      if (live) setChoices(c);
    });
    return () => {
      live = false;
    };
  }, [host, session, revision]);
  return choices;
}

const chip = (rgb: string | null): CSSProperties => ({
  display: "inline-block",
  flex: "0 0 auto",
  width: 12,
  height: 12,
  borderRadius: 2,
  border: "1px solid var(--pg-border, #c9c9c4)",
  background:
    rgb ??
    "linear-gradient(to top right, transparent 45%, #d33 45%, #d33 55%, transparent 55%)",
  verticalAlign: "middle",
});

/** A swatch picker: the document's swatches with their display colour. */
function SwatchPicker(props: {
  role: string;
  value: string | undefined;
  fallback: string | undefined;
  choices: ChartStyleChoices;
  styles: ChartStyleSectionStyles;
  label: string;
  onPick: (id: string | null) => void;
}): ReactElement {
  const { role, value, fallback, choices, styles, label, onPick } = props;
  const { t } = useStrings();
  const [open, setOpen] = useState(false);
  const shownId = value ?? fallback;
  const sw = choices.swatches.find((x) => x.id === shownId);
  const name = value
    ? (sw?.name ?? value)
    : fallback
      ? t(M.fromDefault, { name: sw?.name ?? fallback })
      : t(M.none);
  const pick = (id: string | null) => {
    setOpen(false);
    onPick(id);
  };
  return (
    <span style={{ position: "relative", display: "inline-flex", flex: 1 }}>
      <button
        type="button"
        data-chart-style-swatch={role}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={name}
        style={{
          ...styles.button,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          flex: 1,
          minWidth: 0,
          opacity: value ? 1 : 0.8,
        }}
        onClick={() => setOpen(!open)}
      >
        <span style={chip(sw?.rgbHex ?? null)} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={label}
          data-chart-style-swatches={role}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 2,
            maxHeight: 220,
            overflowY: "auto",
            padding: 4,
            background: "var(--pg-panel-bg, var(--pg-bg, #fff))",
            border: "1px solid var(--pg-border, #c9c9c4)",
            borderRadius: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,.18)",
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        >
          <button
            type="button"
            role="option"
            aria-selected={!value}
            data-swatch=""
            style={optionStyle(styles)}
            onClick={() => pick(null)}
          >
            <span style={chip(null)} />
            {fallback ? t(M.useDefault) : t(M.none)}
          </button>
          {choices.swatches.map((x) => (
            <button
              key={x.id}
              type="button"
              role="option"
              aria-selected={value === x.id}
              data-swatch={x.id}
              title={x.rgbHex}
              style={optionStyle(styles)}
              onClick={() => pick(x.id)}
            >
              <span style={chip(x.rgbHex)} />
              {x.name}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

const optionStyle = (styles: ChartStyleSectionStyles): CSSProperties => ({
  ...styles.body,
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "3px 4px",
  border: "none",
  background: "none",
  textAlign: "left",
  cursor: "pointer",
});

/** The section. */
export function ChartStyleSection(props: {
  host: BundleHost;
  session: WorkbookSession;
  styles: ChartStyleSectionStyles;
  /** The panel's render value: a new one after every session change, so
   *  the engine is read again only then (never on a keystroke elsewhere). */
  view: unknown;
}): ReactElement | null {
  const { host, session, styles, view } = props;
  const { t } = useStrings();
  const choices = useChoices(host, session, session.documentStyleRevision());
  const [target, setTarget] = useState<string>(DEFAULT_TARGET);
  const [msg, setMsg] = useState<string | null>(null);

  const read = useMemo(() => {
    void view;
    const engine = session.state().engine;
    if (!engine?.chartStyle) return null;
    return { specs: engine.chartSpecs?.() ?? [], wb: engine.chartStyle() };
  }, [session, view]);
  if (!read) return null;
  const { specs, wb } = read;
  const defaults = idsOf(wb?.roles, wb?.palette);
  const chart =
    target === DEFAULT_TARGET
      ? null
      : (specs.find((c) => String(c.index) === target) ?? null);
  const current: ChartStyleIds = chart
    ? idsOf(chart.roles, chart.seriesPalette)
    : defaults;

  const run = async (ops: ObjectOp[]): Promise<void> => {
    try {
      const r =
        ops.length === 1 && ops[0]!.op === "set"
          ? await host.objects.set(
              ops[0]!.address,
              ops[0]!.path,
              ops[0]!.value,
              { label: t(M.title) },
            )
          : await host.objects.batch(ops, { label: t(M.title) });
      setMsg(r.applied ? t(M.updated) : (r.reason ?? t(M.failed)));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const chartAddress = (index: number): Address =>
    addressOf("chart", String(index));

  /** Write `next` for the target: a chart's overrides, or the default. */
  const write = (next: ChartStyleIds) => {
    if (chart) {
      const ops: ObjectOp[] = [];
      if (JSON.stringify(next.roles) !== JSON.stringify(current.roles))
        ops.push({
          op: "set",
          address: chartAddress(chart.index),
          path: "roles",
          value: next.roles,
        });
      if (
        (next.seriesColorGroup ?? null) !== (current.seriesColorGroup ?? null)
      )
        ops.push({
          op: "set",
          address: chartAddress(chart.index),
          path: "seriesColorGroup",
          value: next.seriesColorGroup ?? null,
        });
      if (ops.length > 0) void run(ops);
      return;
    }
    const empty =
      Object.keys(next.roles).length === 0 && !next.seriesColorGroup;
    void run([
      {
        op: "set",
        address: WORKBOOK_ADDRESS,
        path: "chartStyle",
        value: empty ? null : next,
      },
    ]);
  };

  const setRole = (role: string, patch: RoleIds) => {
    const r: RoleIds = { ...(current.roles[role] ?? {}), ...patch };
    for (const k of Object.keys(r) as (keyof RoleIds)[]) if (!r[k]) delete r[k];
    const roles = { ...current.roles };
    if (Object.keys(r).length > 0) roles[role] = r;
    else delete roles[role];
    write({ ...current, roles });
  };

  const useAsDefault = () => {
    if (!chart) return;
    void run([
      {
        op: "set",
        address: WORKBOOK_ADDRESS,
        path: "chartStyle",
        value: current,
      },
      {
        op: "set",
        address: chartAddress(chart.index),
        path: "roles",
        value: {},
      },
      {
        op: "set",
        address: chartAddress(chart.index),
        path: "seriesColorGroup",
        value: null,
      },
    ]);
  };

  const reset = () => {
    if (!chart) return;
    void run([
      {
        op: "set",
        address: chartAddress(chart.index),
        path: "roles",
        value: {},
      },
      {
        op: "set",
        address: chartAddress(chart.index),
        path: "seriesColorGroup",
        value: null,
      },
    ]);
  };

  const labelOf = (role: string) => t(M[ROLE_LABELS[role]!]);
  const fallback = (role: string, key: keyof RoleIds) =>
    chart ? defaults.roles[role]?.[key] : undefined;
  const styleName = (
    list: { id: string; name: string }[],
    id: string | undefined,
  ) => list.find((x) => x.id === id)?.name ?? id ?? "";
  const styleSelect = (
    role: string,
    key: "paragraphStyle" | "characterStyle",
    list: { id: string; name: string }[],
  ) => {
    const fb = fallback(role, key);
    return (
      <select
        data-chart-style-select={`${role}.${key}`}
        aria-label={`${labelOf(role)}: ${t(key === "paragraphStyle" ? M.paragraphStyle : M.characterStyle)}`}
        value={current.roles[role]?.[key] ?? ""}
        style={{ ...styles.input, flex: 1, minWidth: 0 }}
        onChange={(e) => setRole(role, { [key]: e.currentTarget.value })}
      >
        <option value="">
          {fb
            ? t(M.fromDefault, { name: styleName(list, fb) })
            : t(
                key === "paragraphStyle"
                  ? M.noParagraphStyle
                  : M.noCharacterStyle,
              )}
        </option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    );
  };

  const groupFallback = chart ? defaults.seriesColorGroup : null;
  const groupName = (id: string | null | undefined) =>
    choices.colorGroups.find((g) => g.id === id)?.name ?? id ?? "";
  const rowStyle: CSSProperties = {
    ...styles.row,
    alignItems: "center",
    flexWrap: "nowrap",
  };
  const labelStyle: CSSProperties = {
    ...styles.body,
    flex: "0 0 96px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  return (
    <div data-chart-style-section>
      <div style={{ ...rowStyle, marginTop: 0 }}>
        <select
          data-chart-style-target
          aria-label={t(M.target)}
          value={chart ? String(chart.index) : DEFAULT_TARGET}
          style={{ ...styles.input, flex: 1 }}
          onChange={(e) => {
            setTarget(e.currentTarget.value);
            setMsg(null);
          }}
        >
          <option value={DEFAULT_TARGET}>{t(M.workbookDefault)}</option>
          {specs.map((c) => (
            <option key={c.index} value={String(c.index)}>
              {c.title || t(M.chartN, { n: c.index + 1 })}
            </option>
          ))}
        </select>
      </div>
      {CHART_ROLES.map((role) => (
        <div key={role} data-chart-style-role={role} style={rowStyle}>
          <span style={labelStyle} title={labelOf(role)}>
            {labelOf(role)}
          </span>
          {isColorRole(role) ? null : (
            <>
              {styleSelect(role, "paragraphStyle", choices.paragraphStyles)}
              {styleSelect(role, "characterStyle", choices.characterStyles)}
            </>
          )}
          <SwatchPicker
            role={role}
            value={current.roles[role]?.swatch}
            fallback={fallback(role, "swatch")}
            choices={choices}
            styles={styles}
            label={`${labelOf(role)}: ${t(M.swatch)}`}
            onPick={(id) => setRole(role, { swatch: id ?? "" })}
          />
        </div>
      ))}
      <div style={rowStyle}>
        <span style={labelStyle}>{t(M.seriesColors)}</span>
        <select
          data-chart-style-group
          aria-label={t(M.seriesColors)}
          value={current.seriesColorGroup ?? ""}
          style={{ ...styles.input, flex: 1, minWidth: 0 }}
          onChange={(e) =>
            write({
              ...current,
              seriesColorGroup: e.currentTarget.value || null,
            })
          }
        >
          <option value="">
            {groupFallback
              ? t(M.fromDefault, { name: groupName(groupFallback) })
              : t(M.themeColors)}
          </option>
          {choices.colorGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      {chart ? (
        <div style={rowStyle}>
          <button
            type="button"
            data-chart-style-use-default
            style={styles.button}
            onClick={useAsDefault}
          >
            {t(M.useAsDefault)}
          </button>
          <button
            type="button"
            data-chart-style-reset
            style={styles.button}
            onClick={reset}
          >
            {t(M.resetToDefault)}
          </button>
        </div>
      ) : null}
      {msg ? (
        <p
          data-chart-style-msg
          role="status"
          style={{ ...styles.body, margin: "4px 0 0" }}
        >
          {msg}
        </p>
      ) : null}
      {choices.swatches.length === 0 ? (
        <p data-chart-style-empty style={styles.note}>
          {t(M.noDocumentStyles)}
        </p>
      ) : (
        <p style={styles.note}>{t(M.note)}</p>
      )}
    </div>
  );
}
