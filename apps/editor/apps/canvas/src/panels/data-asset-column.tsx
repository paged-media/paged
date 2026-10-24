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

// The Data panel's picture columns (editor ADR 291; data ADR 563): a query's
// field whose values name pictures is declared an asset column, with the
// base a relative reference resolves against and the chain of actions
// (`actions@1`, extensions ADR 344) each picture goes through before it is
// placed. The editor lists the actions every bundle registered that take an
// asset and give one, so a chain it builds is one the data service can run;
// an action that is no longer registered stays in the chain, said so.
//
// Shown only when the service offers `assetColumns` and `setAssetColumn`;
// a save is the service's (it refuses an unknown query or field, and saves
// the column with the document).

import { useEffect, useState, type CSSProperties } from "react";

import type {
  ActionInfo,
  ActionStep,
  DataAssetColumn,
  DataService,
  DataTableInfo,
} from "@paged-media/plugin-api";
import { color, font, radius, space, status } from "@paged-media/panel-kit";
import { useRegisteredActions, useDataRevision } from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

const M = defineMessages("app.dataPanel.assets", {
  open: "Picture column…",
  openTitle:
    "Declare a field a picture column: its pictures are fetched, prepared by a chain of actions and placed in the document. Right-click a field header to open it for that field.",
  marker: "picture",
  markerTitle:
    "A picture column: {count, plural, =0 {placed as fetched} one {# action} other {# actions}}",
  title: "Picture column",
  field: "Field",
  base: "Base URL",
  basePlaceholder: "https://media.example.com/",
  baseHint: "What a relative reference resolves against",
  chain: "Actions",
  noSteps: "No actions: the pictures are placed as they are fetched.",
  noActions: "No module has registered an action that prepares pictures.",
  addStep: "Add",
  addPick: "Add an action…",
  missing: "{id} is not registered now",
  params: "Parameters (JSON)",
  badJson: "The parameters of {title} are not a JSON object",
  up: "Move up",
  down: "Move down",
  remove: "Remove",
  save: "Save",
  saving: "Saving…",
  clear: "Stop using it as a picture column",
  close: "Close",
  failed: "Not saved: {reason}",
});

const small: CSSProperties = { font: `11px ${font.sans}`, color: color.fg };
const muted: CSSProperties = {
  font: `11px ${font.sans}`,
  color: color.mutedFg,
};
const control: CSSProperties = {
  ...small,
  height: 22,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  background: color.bg,
  padding: "0 4px",
};
const button: CSSProperties = {
  ...small,
  height: 22,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  background: color.bg,
  padding: "0 8px",
  cursor: "pointer",
};

/** The asset columns of a query table, by field; null when the service does
 *  not offer them or the table is not a query. */
export function useAssetColumns(
  service: DataService,
  table: DataTableInfo,
): ReadonlyMap<string, DataAssetColumn> | null {
  const revision = useDataRevision();
  const offered =
    table.kind === "query" &&
    typeof service.assetColumns === "function" &&
    typeof service.setAssetColumn === "function";
  const [columns, setColumns] = useState<ReadonlyMap<string, DataAssetColumn>>(
    new Map(),
  );
  useEffect(() => {
    if (!offered) return;
    let live = true;
    service.assetColumns!().then(
      (all) => {
        if (!live) return;
        setColumns(
          new Map(
            all.filter((c) => c.query === table.name).map((c) => [c.field, c]),
          ),
        );
      },
      () => live && setColumns(new Map()),
    );
    return () => {
      live = false;
    };
  }, [service, table.name, offered, revision]);
  return offered ? columns : null;
}

/** The toolbar's toggle of the picture column editor. */
export function PictureColumnToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle(): void;
}) {
  const { t } = useStrings();
  return (
    <button
      type="button"
      style={button}
      data-data-picture-toggle=""
      aria-expanded={open}
      title={t(M.openTitle)}
      onClick={onToggle}
    >
      {t(M.open)}
    </button>
  );
}

/** The header's mark of an asset column. */
export function AssetColumnMarker({ column }: { column: DataAssetColumn }) {
  const { t } = useStrings();
  return (
    <span
      data-data-asset-marker=""
      title={t(M.markerTitle, { count: column.chain?.length ?? 0 })}
      style={{
        ...muted,
        marginLeft: 4,
        padding: "0 3px",
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
      }}
    >
      {t(M.marker)}
    </span>
  );
}

interface StepDraft {
  key: number;
  action: string;
  /** Values over the action's defaults (a registered action's fields). */
  values: Record<string, unknown>;
  /** The parameters as JSON (an action with no defaults, or not registered). */
  json: string;
}

function draftsOf(column: DataAssetColumn | undefined): StepDraft[] {
  return (column?.chain ?? []).map((s, i) => ({
    key: i,
    action: s.action,
    values: { ...(s.params ?? {}) },
    json: s.params ? JSON.stringify(s.params) : "",
  }));
}

/** A step's parameters as saved: the values that differ from the action's
 *  defaults, or the JSON object; an error message when it is not one. */
function paramsOf(
  d: StepDraft,
  info: ActionInfo | undefined,
): Record<string, unknown> | string | undefined {
  if (info && Object.keys(info.params).length > 0) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d.values))
      if (JSON.stringify(v) !== JSON.stringify(info.params[k])) out[k] = v;
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (d.json.trim() === "") return undefined;
  try {
    const v = JSON.parse(d.json) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  return "";
}

function ParamField({
  name,
  value,
  fallback,
  onChange,
}: {
  name: string;
  value: unknown;
  fallback: unknown;
  onChange(v: unknown): void;
}) {
  const v = value === undefined ? fallback : value;
  const label = (
    <span style={{ ...muted, fontFamily: font.mono, minWidth: 64 }}>
      {name}
    </span>
  );
  if (typeof fallback === "boolean")
    return (
      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
        {label}
        <input
          type="checkbox"
          data-asset-param={name}
          checked={v === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    );
  if (typeof fallback === "number")
    return (
      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
        {label}
        <input
          type="number"
          data-asset-param={name}
          style={{ ...control, width: 80 }}
          value={typeof v === "number" ? v : Number(v)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
    );
  return (
    <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {label}
      <input
        data-asset-param={name}
        style={{ ...control, flex: 1 }}
        value={typeof v === "string" ? v : JSON.stringify(v)}
        onChange={(e) => {
          if (typeof fallback === "string") return onChange(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
          } catch {
            onChange(e.target.value);
          }
        }}
      />
    </label>
  );
}

/** The picture column editor of one query field. */
export function AssetColumnEditor({
  service,
  table,
  field,
  column,
  onField,
  onClose,
}: {
  service: DataService;
  table: DataTableInfo;
  field: string;
  column: DataAssetColumn | undefined;
  onField(field: string): void;
  onClose(): void;
}) {
  const { t } = useStrings();
  const all = useRegisteredActions("asset");
  const usable = all.filter((a) => a.output === "asset" && !a.headlessOnly);
  const [base, setBase] = useState(column?.base ?? "");
  const [steps, setSteps] = useState<StepDraft[]>(() => draftsOf(column));
  const [nextKey, setNextKey] = useState(steps.length);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const infoOf = (id: string) => all.find((a) => a.id === id);

  const patch = (key: number, next: Partial<StepDraft>) =>
    setSteps(steps.map((s) => (s.key === key ? { ...s, ...next } : s)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    setSteps(next);
  };
  const add = () => {
    const info = infoOf(pick);
    if (!info) return;
    setSteps([
      ...steps,
      { key: nextKey, action: info.id, values: { ...info.params }, json: "" },
    ]);
    setNextKey(nextKey + 1);
    setPick("");
  };
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    work().then(
      () => {
        setBusy(false);
        onClose();
      },
      (err: unknown) => {
        setBusy(false);
        setFailure(
          t(M.failed, {
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
      },
    );
  };
  const save = () => {
    const chain: ActionStep[] = [];
    for (const s of steps) {
      const info = infoOf(s.action);
      const params = paramsOf(s, info);
      if (typeof params === "string") {
        setFailure(t(M.badJson, { title: info?.title ?? s.action }));
        return;
      }
      chain.push(params ? { action: s.action, params } : { action: s.action });
    }
    const def = {
      ...(chain.length > 0 ? { chain } : {}),
      ...(base.trim() ? { base: base.trim() } : {}),
    };
    run(() => service.setAssetColumn!(table.name, field, def));
  };

  return (
    <div
      data-data-asset-editor={field}
      role="group"
      aria-label={t(M.title)}
      style={{
        display: "grid",
        gap: space[1],
        margin: `0 ${space[2]} ${space[1]}`,
        padding: space[2],
        border: `1px solid ${color.border}`,
        borderRadius: radius.sm,
        background: color.bg,
      }}
    >
      <div style={{ display: "flex", gap: space[2], alignItems: "center" }}>
        <span style={{ ...small, fontWeight: 600 }}>{t(M.title)}</span>
        <label
          style={{ ...muted, display: "flex", gap: 4, alignItems: "center" }}
        >
          {t(M.field)}
          <select
            data-asset-field=""
            style={control}
            value={field}
            onChange={(e) => onField(e.target.value)}
          >
            {table.schema.fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={button}
          aria-label={t(M.close)}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <label
        style={{ ...muted, display: "flex", gap: 4, alignItems: "center" }}
        title={t(M.baseHint)}
      >
        {t(M.base)}
        <input
          data-asset-base=""
          style={{ ...control, flex: 1 }}
          placeholder={t(M.basePlaceholder)}
          value={base}
          onChange={(e) => setBase(e.target.value)}
        />
      </label>
      <span style={muted}>{t(M.chain)}</span>
      {steps.length === 0 && <span style={muted}>{t(M.noSteps)}</span>}
      <ol
        style={{ margin: 0, paddingLeft: 18, display: "grid", gap: space[1] }}
      >
        {steps.map((s, i) => {
          const info = infoOf(s.action);
          const typed = !!info && Object.keys(info.params).length > 0;
          return (
            <li key={s.key} data-asset-step={s.action} style={small}>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span style={{ flex: 1 }}>
                  {info?.title ?? s.action}
                  {!info && (
                    <span style={{ ...muted, color: status.warn }}>
                      {" "}
                      {t(M.missing, { id: s.action })}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  style={button}
                  aria-label={t(M.up)}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  style={button}
                  aria-label={t(M.down)}
                  disabled={i === steps.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  style={button}
                  aria-label={t(M.remove)}
                  onClick={() => setSteps(steps.filter((x) => x.key !== s.key))}
                >
                  ×
                </button>
              </div>
              {typed ? (
                <div style={{ display: "grid", gap: 2, marginTop: 2 }}>
                  {Object.keys(info.params).map((k) => (
                    <ParamField
                      key={k}
                      name={k}
                      value={s.values[k]}
                      fallback={info.params[k]}
                      onChange={(v) =>
                        patch(s.key, { values: { ...s.values, [k]: v } })
                      }
                    />
                  ))}
                </div>
              ) : (
                <input
                  data-asset-json=""
                  aria-label={t(M.params)}
                  placeholder={t(M.params)}
                  style={{ ...control, width: "100%", marginTop: 2 }}
                  value={s.json}
                  onChange={(e) => patch(s.key, { json: e.target.value })}
                />
              )}
            </li>
          );
        })}
      </ol>
      {usable.length === 0 ? (
        <span style={muted}>{t(M.noActions)}</span>
      ) : (
        <div style={{ display: "flex", gap: 4 }}>
          <select
            data-asset-pick=""
            style={{ ...control, flex: 1 }}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">{t(M.addPick)}</option>
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            style={button}
            data-asset-add=""
            disabled={!pick}
            onClick={add}
          >
            {t(M.addStep)}
          </button>
        </div>
      )}
      {failure && (
        <p
          data-asset-failure=""
          style={{ ...small, color: status.error, margin: 0 }}
        >
          {failure}
        </p>
      )}
      <div style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          style={{ ...button, fontWeight: 600 }}
          data-asset-save=""
          disabled={busy}
          onClick={save}
        >
          {busy ? t(M.saving) : t(M.save)}
        </button>
        {column && (
          <button
            type="button"
            style={button}
            data-asset-clear=""
            disabled={busy}
            onClick={() =>
              run(() => service.setAssetColumn!(table.name, field, null))
            }
          >
            {t(M.clear)}
          </button>
        )}
      </div>
    </div>
  );
}
