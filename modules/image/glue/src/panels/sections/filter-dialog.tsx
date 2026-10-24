// THE FILTER DIALOG (WP5.2) — one component for every one-shot filter.
// It draws the filter's parameter schema (`filters.ts`): a slider per
// range, an angle dial, a choice, a switch, a colour. The canvas shows
// the result live (the session's preview: a resampled proxy while a
// slider moves, full resolution when it rests), with Preview and a
// before/after toggle; OK keeps the filter as ONE undo step, Cancel puts
// the image back.

import type { FilterDef, FilterValue, ParamSpec } from "../../filters";
import type { FilterDialogState } from "../../session";
import { defineMessages, t } from "@paged-media/strings";
import { color, font, space } from "@paged-media/panel-kit";

import { mono, note, row } from "./styles";

const M = defineMessages("image.filterDialog", {
  ok: "OK",
  cancel: "Cancel",
  preview: "Preview",
  before: "Before",
  after: "After",
  beforeTitle: "Show the image without the filter while the dialog stays open",
  note:
    "The canvas previews the filter; while a slider moves it shows a reduced " +
    "copy, and the full image follows when it rests. OK keeps the filter as " +
    "one undo step, in the active layer and inside the selection; Cancel " +
    "leaves the image as it was.",
  gpuOnly: "Filters run on the GPU; without WebGPU the dialog cannot apply.",
});

/** Hex `#rrggbb` ↔ straight RGB in [0, 1]. */
const toHex = (c: readonly [number, number, number]) =>
  "#" +
  c
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const fromHex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

/** Degrees from a pointer position on the dial (0° = right, counter-
 *  clockwise positive, as Photoshop's angle wheels read). */
export function dialAngle(dx: number, dy: number): number {
  // `0 - dy`, not `-dy`: a −0 would turn straight left into −180°, and
  // `+ 0` turns a −0 result (straight right) into 0.
  return Math.round((Math.atan2(0 - dy, dx) * 180) / Math.PI) + 0;
}

function AngleDial({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const r = 14;
  const rad = (value * Math.PI) / 180;
  const set = (e: {
    clientX: number;
    clientY: number;
    currentTarget: Element;
  }) => {
    const box = e.currentTarget.getBoundingClientRect();
    onChange(
      dialAngle(
        e.clientX - (box.left + box.width / 2),
        e.clientY - (box.top + box.height / 2),
      ),
    );
  };
  return (
    <svg
      width={2 * r + 4}
      height={2 * r + 4}
      viewBox={`${-r - 2} ${-r - 2} ${2 * r + 4} ${2 * r + 4}`}
      role="slider"
      aria-valuemin={-180}
      aria-valuemax={180}
      aria-valuenow={value}
      aria-labelledby={id}
      data-filter-dial
      style={{ cursor: disabled ? "default" : "pointer", flex: "none" }}
      onPointerDown={(e) => {
        if (disabled) return;
        set(e);
      }}
    >
      <circle r={r} fill="none" stroke={color.border} strokeWidth={1.5} />
      <line
        x1={0}
        y1={0}
        x2={r * Math.cos(rad)}
        y2={-r * Math.sin(rad)}
        stroke="currentColor"
        strokeWidth={2}
      />
    </svg>
  );
}

function readout(p: ParamSpec, v: number): string {
  if (p.kind === "angle") return `${v}°`;
  if (p.kind !== "range") return String(v);
  if (p.percent) return `${Math.round(v * 100)} %`;
  const digits = p.step >= 1 ? 0 : p.step >= 0.1 ? 1 : 2;
  return `${v.toFixed(digits)}${p.px ? " px" : ""}`;
}

function Param({
  filterId,
  p,
  value,
  disabled,
  onChange,
}: {
  filterId: string;
  p: ParamSpec;
  value: FilterValue;
  disabled: boolean;
  onChange: (v: FilterValue) => void;
}) {
  const id = `pg-filter-${filterId}-${p.key}`;
  const label = (
    <label htmlFor={id} id={`${id}-label`}>
      {t(p.label)}
    </label>
  );
  switch (p.kind) {
    case "range":
    case "angle": {
      const v = typeof value === "number" ? value : p.default;
      const [min, max, step] =
        p.kind === "angle" ? [-180, 180, 1] : [p.min, p.max, p.step];
      return (
        <div style={row}>
          {label}
          {p.kind === "angle" && (
            <AngleDial
              id={`${id}-label`}
              value={v}
              disabled={disabled}
              onChange={onChange}
            />
          )}
          <input
            id={id}
            type="range"
            data-filter-param={p.key}
            min={min}
            max={max}
            step={step}
            value={v}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span style={{ ...mono, minWidth: "4.5em", textAlign: "right" }}>
            {readout(p, v)}
          </span>
        </div>
      );
    }
    case "select":
      return (
        <div style={row}>
          {label}
          <select
            id={id}
            data-filter-param={p.key}
            value={typeof value === "number" ? value : p.default}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
          >
            {p.options.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </select>
        </div>
      );
    case "toggle":
      return (
        <div style={row}>
          {label}
          <input
            id={id}
            type="checkbox"
            data-filter-param={p.key}
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
        </div>
      );
    case "color": {
      const c = Array.isArray(value)
        ? (value as readonly [number, number, number])
        : p.default;
      return (
        <div style={row}>
          {label}
          <input
            id={id}
            type="color"
            data-filter-param={p.key}
            value={toHex(c)}
            disabled={disabled}
            onChange={(e) => onChange(fromHex(e.target.value))}
          />
        </div>
      );
    }
  }
}

export function FilterDialog({
  def,
  dialog,
  gpu,
  busy,
  onChange,
  onPreview,
  onBefore,
  onOk,
  onCancel,
}: {
  def: FilterDef;
  dialog: FilterDialogState;
  gpu: boolean;
  busy: boolean;
  onChange: (patch: Record<string, FilterValue>) => void;
  onPreview: (on: boolean) => void;
  onBefore: (before: boolean) => void;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      role="dialog"
      aria-label={t(def.label)}
      data-filter-dialog={def.id}
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: 4,
        padding: space[2],
        margin: `${space[2]} 0`,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: space[1] }}>
        {t(def.label)}
      </div>
      {def.params.map((p) => (
        <Param
          key={p.key}
          filterId={def.id}
          p={p}
          value={dialog.values[p.key] ?? p.default}
          disabled={busy}
          onChange={(v) => onChange({ [p.key]: v })}
        />
      ))}
      <div style={{ ...row, borderBottom: "none", flexWrap: "wrap" }}>
        <label style={{ font: `12px ${font.sans}` }}>
          <input
            type="checkbox"
            data-filter-preview
            checked={dialog.preview}
            onChange={(e) => onPreview(e.target.checked)}
          />{" "}
          {t(M.preview)}
        </label>
        <button
          type="button"
          data-filter-before
          aria-pressed={dialog.before}
          title={t(M.beforeTitle)}
          disabled={!dialog.preview}
          onClick={() => onBefore(!dialog.before)}
        >
          {dialog.before ? t(M.before) : t(M.after)}
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" data-filter-cancel onClick={onCancel}>
          {t(M.cancel)}
        </button>
        <button
          type="button"
          data-filter-ok
          disabled={busy || !gpu}
          onClick={onOk}
        >
          {t(M.ok)}
        </button>
      </div>
      <div style={note}>{gpu ? t(M.note) : t(M.gpuOnly)}</div>
    </section>
  );
}
