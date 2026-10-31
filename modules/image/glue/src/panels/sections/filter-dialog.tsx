// THE FILTER DIALOG (WP5.2) — one component for every one-shot filter.
// It draws the filter's parameter schema (`filters.ts`): a slider per
// range, an angle dial, a choice, a switch, a colour. The canvas shows
// the result live (the session's preview: a resampled proxy while a
// slider moves, full resolution when it rests), with Preview and a
// before/after toggle; OK keeps the filter as ONE undo step, Cancel puts
// the image back.

import type { FilterDef, FilterValue, ParamSpec } from "../../filters";
import type { FilterDialogState } from "../../session";
import { GalleryWorkspace } from "./filter-gallery-workspace";
import { defineMessages, t } from "@paged-media/strings";
import { color, font, space } from "@paged-media/panel-kit";

import type { ReactNode } from "react";

import { kicker, mono, note, row } from "./styles";

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
  thisImage: "This image (composite)",
  aFile: "A file…",
  pinBlur: "Pin {n}",
  removePin: "Remove pin {n}",
  points: "{count, plural, one {# point} other {# points}}",
  addPoint: "Add point",
  reset: "Reset",
  removePoint: "Remove last point",
  warpOnCanvas:
    "Drag a point of the mesh on the canvas to bend it freely (the warp " +
    "becomes Custom).",
  puppetOnCanvas:
    "Click the image to add a pin, drag a pin to bend the layer around " +
    "the others, Alt-click a pin to remove it.",
  liquifyOnCanvas:
    "Drag on the image with the chosen tool and brush; Freeze mask " +
    "protects an area from the other tools. Reset restores the image.",
  onCanvas:
    "Drag the pins and handles on the canvas; with Field blur on, a click " +
    "on the image adds a pin and Alt-click removes one.",
});

/** Is `p` shown at these values (its `showIf` condition)? */
export function paramShown(
  p: ParamSpec,
  values: Readonly<Record<string, FilterValue>>,
): boolean {
  if (!p.showIf) return true;
  const v = values[p.showIf.key];
  return v === p.showIf.equals;
}

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
      const c: readonly [number, number, number] =
        Array.isArray(value) && value.length === 3
          ? [value[0]!, value[1]!, value[2]!]
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
    case "points":
      return (
        <PointsParam
          id={id}
          p={p}
          value={Array.isArray(value) ? value : p.default}
          label={label}
          onChange={onChange}
        />
      );
    case "image":
      return null;
    case "data": {
      // Geometry made on the canvas (WP5.6): its count and a reset.
      const list = Array.isArray(value) ? value : p.default;
      if (!p.count || !p.countLabel) return null;
      return (
        <div style={row}>
          {label}
          <span id={id} data-filter-data={p.key} style={mono}>
            {t(p.countLabel, { count: p.count(list) })}
          </span>
          <button
            type="button"
            data-filter-data-reset={p.key}
            disabled={list.length === 0}
            onClick={() => onChange([...p.default])}
          >
            {t(M.reset)}
          </button>
        </div>
      );
    }
  }
}

/** On-canvas points: the count, and for value-carrying points (Field
 *  Blur's pins) a slider and a remove button per point. Their positions
 *  are edited on the canvas. */
function PointsParam({
  id,
  p,
  value,
  label,
  onChange,
}: {
  id: string;
  p: Extract<ParamSpec, { kind: "points" }>;
  value: readonly number[];
  label: ReactNode;
  onChange: (v: FilterValue) => void;
}) {
  const count = Math.floor(value.length / p.stride);
  const rows =
    p.stride === 3
      ? Array.from({ length: count }, (_, i) => {
          const at = i * 3 + 2;
          return (
            <div key={i} style={row}>
              <label htmlFor={`${id}-${i}`}>{t(M.pinBlur, { n: i + 1 })}</label>
              <input
                id={`${id}-${i}`}
                type="range"
                data-filter-point={`${p.key}:${i}`}
                min={p.min}
                max={p.max}
                step={1}
                value={value[at] ?? 0}
                onChange={(e) => {
                  const next = [...value];
                  next[at] = Number(e.target.value);
                  onChange(next);
                }}
              />
              <span style={{ ...mono, minWidth: "4.5em", textAlign: "right" }}>
                {Math.round(value[at] ?? 0)} px
              </span>
              <button
                type="button"
                aria-label={t(M.removePin, { n: i + 1 })}
                data-filter-point-remove={`${p.key}:${i}`}
                disabled={count <= 1}
                onClick={() => {
                  const next = [...value];
                  next.splice(i * 3, 3);
                  onChange(next);
                }}
              >
                ×
              </button>
            </div>
          );
        })
      : [];
  return (
    <>
      <div style={row}>
        {label}
        <span data-filter-points={p.key} style={mono}>
          {t(M.points, { count })}
        </span>
        {p.stride === 2 && (
          <span>
            <button
              type="button"
              data-filter-point-add={p.key}
              onClick={() => {
                // A new point beyond the last, toward the centre.
                const last = value.slice(-2);
                const x = Math.min(1, (last[0] ?? 0.5) + 0.1);
                onChange([...value, x, last[1] ?? 0.5]);
              }}
            >
              {t(M.addPoint)}
            </button>{" "}
            <button
              type="button"
              data-filter-point-drop={p.key}
              disabled={count <= 2}
              onClick={() => onChange(value.slice(0, -2))}
            >
              {t(M.removePoint)}
            </button>
          </span>
        )}
      </div>
      {rows}
    </>
  );
}

/** An `image` parameter: this image's composite, or a chosen file. */
function ImageParam({
  filterId,
  p,
  value,
  file,
  onChoose,
}: {
  filterId: string;
  p: ParamSpec;
  value: FilterValue;
  file: string | undefined;
  onChoose: (choice: 0 | 1) => void;
}) {
  const id = `pg-filter-${filterId}-${p.key}`;
  return (
    <div style={row}>
      <label htmlFor={id}>{t(p.label)}</label>
      <select
        id={id}
        data-filter-param={p.key}
        value={value === 1 ? 1 : 0}
        onChange={(e) => onChoose(Number(e.target.value) === 1 ? 1 : 0)}
      >
        <option value={0}>{t(M.thisImage)}</option>
        <option value={1}>{file ?? t(M.aFile)}</option>
      </select>
    </div>
  );
}

/** The parameters, under their section headings and sub-groups, those
 *  whose condition is off left out. */
function Params({
  def,
  dialog,
  onChange,
  onChooseImage,
}: {
  def: FilterDef;
  dialog: FilterDialogState;
  onChange: (patch: Record<string, FilterValue>) => void;
  onChooseImage: (key: string, choice: 0 | 1) => void;
}) {
  const out: ReactNode[] = [];
  let section: string | undefined;
  let group: string | undefined;
  for (const p of def.params) {
    if (!paramShown(p, dialog.values)) continue;
    if (p.section !== section) {
      section = p.section;
      group = undefined;
      if (section)
        out.push(
          <div
            key={`s:${section}:${p.key}`}
            data-filter-section={section}
            style={{ ...kicker, marginTop: space[2] }}
          >
            {t(section)}
          </div>,
        );
    }
    if (p.group !== group) {
      group = p.group;
      if (group)
        out.push(
          <div
            key={`g:${group}:${p.key}`}
            style={{ fontWeight: 600, marginTop: space[1] }}
          >
            {t(group)}
          </div>,
        );
    }
    out.push(
      p.kind === "image" ? (
        <ImageParam
          key={p.key}
          filterId={def.id}
          p={p}
          value={dialog.values[p.key] ?? p.default}
          file={dialog.files[p.key]}
          onChoose={(c) => onChooseImage(p.key, c)}
        />
      ) : (
        <Param
          key={p.key}
          filterId={def.id}
          p={p}
          value={dialog.values[p.key] ?? p.default}
          // Never while a pass runs: a drag must not be cut off by the
          // preview it causes (the session coalesces, latest wins).
          disabled={false}
          onChange={(v) => onChange({ [p.key]: v })}
        />
      ),
    );
  }
  return <>{out}</>;
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
  onChooseImage = () => {},
  effects = [],
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
  /** An `image` parameter's source changed (0 composite, 1 a file). */
  onChooseImage?: (key: string, choice: 0 | 1) => void;
  /** The Filter Gallery workspace's effects (its stack's choices). */
  effects?: readonly FilterDef[];
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
      {def.id === "filterGallery" ? (
        <GalleryWorkspace
          effects={effects}
          values={dialog.values}
          onValues={onChange}
          renderParams={(layerDef, values, set) => (
            <Params
              def={layerDef}
              dialog={{ ...dialog, values }}
              onChange={set}
              onChooseImage={onChooseImage}
            />
          )}
        />
      ) : (
        <Params
          def={def}
          dialog={dialog}
          onChange={onChange}
          onChooseImage={onChooseImage}
        />
      )}
      {def.id === "blurGallery" && <div style={note}>{t(M.onCanvas)}</div>}
      {def.id === "warp" && <div style={note}>{t(M.warpOnCanvas)}</div>}
      {def.id === "puppetWarp" && <div style={note}>{t(M.puppetOnCanvas)}</div>}
      {def.id === "liquify" && <div style={note}>{t(M.liquifyOnCanvas)}</div>}
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
