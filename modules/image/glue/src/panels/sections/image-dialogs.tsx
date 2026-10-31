// IMAGE ▸ Image Size…, Trim… and Image Rotation ▸ Arbitrary… — the
// dialogs that sit on top of the Image panel (WP5.1). Every one runs over
// the whole layer stack as one undo step (session `resizeTo`, `trim`,
// `rotateCanvas`).

import { useState } from "react";

import type { ResampleFilter, TrimBy } from "../../engine";
import type { IndexedPalette } from "../../mode-engine";
import { defineMessages, t } from "@paged-media/strings";
import { color, font, space } from "@paged-media/panel-kit";

import { mono, note, row } from "./styles";

const M = defineMessages("image.dialogs", {
  imageSize: "Image size",
  pixelDimensions: "Pixel dimensions",
  width: "Width",
  height: "Height",
  documentSize: "Document size",
  resolution: "Resolution",
  ppi: "pixels/inch",
  unit: "Unit",
  inches: "Inches",
  centimetres: "Centimetres",
  millimetres: "Millimetres",
  constrain: "Constrain proportions",
  resample: "Resample",
  nearest: "Nearest neighbour (hard edges)",
  mitchell: "Mitchell (smooth)",
  lanczos: "Lanczos 3 (sharper)",
  resampleGpuOnly:
    "Resampling runs on the GPU; without WebGPU only the resolution can change.",
  sizeNote:
    "With Resample on, every layer and mask is resampled to the new pixel " +
    "size as one undo step. With it off, the pixels stay and only the " +
    "resolution changes, so the printed size follows. PNG and JPEG exports " +
    "carry the resolution.",
  ok: "OK",
  cancel: "Cancel",
  trim: "Trim",
  basedOn: "Based on",
  transparent: "Transparent pixels",
  topLeft: "Top-left pixel colour",
  bottomRight: "Bottom-right pixel colour",
  trimNote:
    "Trims away rows and columns of the chosen kind from every side, over " +
    "every layer — an exact crop, one undo step.",
  rotate: "Rotate canvas",
  angle: "Angle",
  clockwise: "° clockwise",
  counterClockwise: "° counter-clockwise",
  rotateNote:
    "Turns every layer and mask about the centre; the canvas grows to hold " +
    "the corners, which are transparent. Quarter turns are exact; any other " +
    "angle is resampled on the GPU. One undo step.",
  indexedColor: "Indexed colour",
  palette: "Palette",
  paletteExact: "Exact",
  paletteWeb: "Web",
  paletteAdaptive: "Local (adaptive)",
  colours: "Colours",
  indexedNote:
    "Flattens the image and gives every pixel the nearest colour of the " +
    "palette, without dither, at 8 bits per channel — one undo step. Exact " +
    "takes the image's own colours (at most 256); Web the 216 Web colours.",
});

const dialogStyle = {
  border: `1px solid ${color.border}`,
  borderRadius: 4,
  padding: space[2],
  margin: `${space[2]} 0`,
} as const;

const title = { fontWeight: 600, marginBottom: space[1] } as const;

const numberStyle = { width: 72, font: `11px ${font.mono}` } as const;

function Buttons({
  okDisabled,
  okAttr,
  onOk,
  onCancel,
}: {
  okDisabled: boolean;
  okAttr: Record<string, string>;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ ...row, borderBottom: "none", justifyContent: "flex-end" }}>
      <button type="button" data-dialog-cancel onClick={onCancel}>
        {t(M.cancel)}
      </button>
      <button type="button" {...okAttr} disabled={okDisabled} onClick={onOk}>
        {t(M.ok)}
      </button>
    </div>
  );
}

export type SizeUnit = "in" | "cm" | "mm";
const PER_INCH: Record<SizeUnit, number> = { in: 1, cm: 2.54, mm: 25.4 };

/** px ↔ printed length at `ppi` in `unit`. */
export const pxToLength = (px: number, ppi: number, unit: SizeUnit) =>
  (px / ppi) * PER_INCH[unit];
export const lengthToPx = (len: number, ppi: number, unit: SizeUnit) =>
  Math.max(1, Math.round((len / PER_INCH[unit]) * ppi));

export function ImageSizeDialog({
  width,
  height,
  ppi,
  gpu,
  busy,
  onResample,
  onResolution,
  onCancel,
}: {
  width: number;
  height: number;
  /** The declared resolution (null = none; shown as 72). */
  ppi: number | null;
  gpu: boolean;
  busy: boolean;
  onResample: (
    w: number,
    h: number,
    filter: ResampleFilter,
    ppi: number,
  ) => void;
  onResolution: (ppi: number) => void;
  onCancel: () => void;
}) {
  const [w, setW] = useState(width);
  const [h, setH] = useState(height);
  const [res, setRes] = useState(ppi ?? 72);
  const [unit, setUnit] = useState<SizeUnit>("cm");
  const [constrain, setConstrain] = useState(true);
  const [resample, setResample] = useState(true);
  const [filter, setFilter] = useState<ResampleFilter>("lanczos3");
  const aspect = width / Math.max(1, height);

  const setPxW = (v: number) => {
    const nw = Math.max(1, Math.round(v) | 0);
    setW(nw);
    if (constrain) setH(Math.max(1, Math.round(nw / aspect)));
  };
  const setPxH = (v: number) => {
    const nh = Math.max(1, Math.round(v) | 0);
    setH(nh);
    if (constrain) setW(Math.max(1, Math.round(nh * aspect)));
  };
  // A printed length: with Resample the pixels follow it at this
  // resolution; without, the RESOLUTION follows it at these pixels.
  const setLenW = (len: number) => {
    if (!(len > 0)) return;
    if (resample) setPxW(lengthToPx(len, res, unit));
    else setRes((w / len) * PER_INCH[unit]);
  };
  const setLenH = (len: number) => {
    if (!(len > 0)) return;
    if (resample) setPxH(lengthToPx(len, res, unit));
    else setRes((h / len) * PER_INCH[unit]);
  };
  const changed = w !== width || h !== height;
  const okDisabled = busy || (resample && changed && !gpu);

  return (
    <section
      role="dialog"
      aria-label={t(M.imageSize)}
      data-image-size-dialog
      style={dialogStyle}
    >
      <div style={title}>{t(M.imageSize)}</div>
      <div style={{ ...note, marginTop: 0 }}>{t(M.pixelDimensions)}</div>
      <div style={row}>
        <label htmlFor="pg-image-size-w">{t(M.width)}</label>
        <input
          id="pg-image-size-w"
          type="number"
          min={1}
          data-image-resize-w
          value={w}
          disabled={!resample}
          style={numberStyle}
          onChange={(e) => setPxW(Number(e.target.value))}
        />
        <span style={mono}>px</span>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-size-h">{t(M.height)}</label>
        <input
          id="pg-image-size-h"
          type="number"
          min={1}
          data-image-resize-h
          value={h}
          disabled={!resample}
          style={numberStyle}
          onChange={(e) => setPxH(Number(e.target.value))}
        />
        <span style={mono}>px</span>
      </div>
      <div style={{ ...note, marginTop: space[1] }}>{t(M.documentSize)}</div>
      <div style={row}>
        <label htmlFor="pg-image-size-lw">{t(M.width)}</label>
        <input
          id="pg-image-size-lw"
          type="number"
          step={0.01}
          data-image-size-length-w
          value={Number(pxToLength(w, res, unit).toFixed(2))}
          style={numberStyle}
          onChange={(e) => setLenW(Number(e.target.value))}
        />
        <select
          aria-label={t(M.unit)}
          data-image-size-unit
          value={unit}
          onChange={(e) => setUnit(e.target.value as SizeUnit)}
        >
          <option value="cm">{t(M.centimetres)}</option>
          <option value="mm">{t(M.millimetres)}</option>
          <option value="in">{t(M.inches)}</option>
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-size-lh">{t(M.height)}</label>
        <input
          id="pg-image-size-lh"
          type="number"
          step={0.01}
          data-image-size-length-h
          value={Number(pxToLength(h, res, unit).toFixed(2))}
          style={numberStyle}
          onChange={(e) => setLenH(Number(e.target.value))}
        />
      </div>
      <div style={row}>
        <label htmlFor="pg-image-size-ppi">{t(M.resolution)}</label>
        <input
          id="pg-image-size-ppi"
          type="number"
          min={1}
          step={1}
          data-image-size-ppi
          value={Number(res.toFixed(2))}
          style={numberStyle}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v > 0) setRes(v);
          }}
        />
        <span style={mono}>{t(M.ppi)}</span>
      </div>
      <div style={row}>
        <label>
          <input
            type="checkbox"
            data-image-size-constrain
            checked={constrain}
            onChange={(e) => {
              setConstrain(e.target.checked);
              if (e.target.checked) setH(Math.max(1, Math.round(w / aspect)));
            }}
          />{" "}
          {t(M.constrain)}
        </label>
      </div>
      <div style={row}>
        <label>
          <input
            type="checkbox"
            data-image-size-resample
            checked={resample}
            onChange={(e) => {
              setResample(e.target.checked);
              if (!e.target.checked) {
                setW(width);
                setH(height);
              }
            }}
          />{" "}
          {t(M.resample)}
        </label>
        <select
          data-image-resize-filter
          value={filter}
          disabled={!resample}
          onChange={(e) => setFilter(e.target.value as ResampleFilter)}
        >
          <option value="lanczos3">{t(M.lanczos)}</option>
          <option value="mitchell">{t(M.mitchell)}</option>
          <option value="nearest">{t(M.nearest)}</option>
        </select>
      </div>
      <Buttons
        okDisabled={okDisabled}
        okAttr={{ "data-image-resize-apply": "" }}
        onOk={() => {
          if (resample && changed) onResample(w, h, filter, res);
          else onResolution(res);
        }}
        onCancel={onCancel}
      />
      <div style={note}>
        {resample && !gpu ? t(M.resampleGpuOnly) : t(M.sizeNote)}
      </div>
    </section>
  );
}

export function TrimDialog({
  busy,
  onTrim,
  onCancel,
}: {
  busy: boolean;
  onTrim: (by: TrimBy) => void;
  onCancel: () => void;
}) {
  const [by, setBy] = useState<TrimBy>("transparent");
  const options: Array<[TrimBy, string]> = [
    ["transparent", M.transparent],
    ["top-left", M.topLeft],
    ["bottom-right", M.bottomRight],
  ];
  return (
    <section
      role="dialog"
      aria-label={t(M.trim)}
      data-image-trim-dialog
      style={dialogStyle}
    >
      <div style={title}>{t(M.trim)}</div>
      <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
        <legend style={{ ...note, marginTop: 0 }}>{t(M.basedOn)}</legend>
        {options.map(([value, label]) => (
          <label key={value} style={{ display: "block" }}>
            <input
              type="radio"
              name="pg-image-trim-by"
              data-image-trim-by={value}
              checked={by === value}
              onChange={() => setBy(value)}
            />{" "}
            {t(label)}
          </label>
        ))}
      </fieldset>
      <Buttons
        okDisabled={busy}
        okAttr={{ "data-image-trim-apply": "" }}
        onOk={() => onTrim(by)}
        onCancel={onCancel}
      />
      <div style={note}>{t(M.trimNote)}</div>
    </section>
  );
}

export function RotateDialog({
  gpu,
  busy,
  onRotate,
  onCancel,
}: {
  gpu: boolean;
  busy: boolean;
  onRotate: (degrees: number) => void;
  onCancel: () => void;
}) {
  const [angle, setAngle] = useState(15);
  const [cw, setCw] = useState(true);
  const quarter = Math.abs(angle) % 90 === 0;
  return (
    <section
      role="dialog"
      aria-label={t(M.rotate)}
      data-image-rotate-dialog
      style={dialogStyle}
    >
      <div style={title}>{t(M.rotate)}</div>
      <div style={row}>
        <label htmlFor="pg-image-rotate-angle">{t(M.angle)}</label>
        <input
          id="pg-image-rotate-angle"
          type="number"
          min={-359.99}
          max={359.99}
          step={0.1}
          data-image-rotate-angle
          value={angle}
          style={numberStyle}
          onChange={(e) => setAngle(Number(e.target.value))}
        />
      </div>
      <div style={row}>
        <label>
          <input
            type="radio"
            name="pg-image-rotate-dir"
            data-image-rotate-dir="cw"
            checked={cw}
            onChange={() => setCw(true)}
          />
          {t(M.clockwise)}
        </label>
        <label>
          <input
            type="radio"
            name="pg-image-rotate-dir"
            data-image-rotate-dir="ccw"
            checked={!cw}
            onChange={() => setCw(false)}
          />
          {t(M.counterClockwise)}
        </label>
      </div>
      <Buttons
        okDisabled={busy || !Number.isFinite(angle) || (!gpu && !quarter)}
        okAttr={{ "data-image-rotate-apply": "" }}
        onOk={() => onRotate(cw ? angle : -angle)}
        onCancel={onCancel}
      />
      <div style={note}>{t(M.rotateNote)}</div>
    </section>
  );
}

export function IndexedColorDialog({
  busy,
  onApply,
  onCancel,
}: {
  busy: boolean;
  onApply: (palette: IndexedPalette, colours: number) => void;
  onCancel: () => void;
}) {
  const [palette, setPalette] = useState<IndexedPalette>("adaptive");
  const [colours, setColours] = useState(256);
  const options: Array<[IndexedPalette, string]> = [
    ["exact", M.paletteExact],
    ["web", M.paletteWeb],
    ["adaptive", M.paletteAdaptive],
  ];
  return (
    <section
      role="dialog"
      aria-label={t(M.indexedColor)}
      data-image-indexed-dialog
      style={dialogStyle}
    >
      <div style={title}>{t(M.indexedColor)}</div>
      <div style={row}>
        <label htmlFor="pg-image-indexed-palette">{t(M.palette)}</label>
        <select
          id="pg-image-indexed-palette"
          data-image-indexed-palette
          value={palette}
          onChange={(e) => setPalette(e.target.value as IndexedPalette)}
        >
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
      </div>
      <div style={row}>
        <label htmlFor="pg-image-indexed-colours">{t(M.colours)}</label>
        <input
          id="pg-image-indexed-colours"
          data-image-indexed-colours
          type="number"
          min={2}
          max={256}
          value={colours}
          disabled={palette !== "adaptive"}
          style={numberStyle}
          onChange={(e) =>
            setColours(Math.max(2, Math.min(256, Number(e.target.value) || 2)))
          }
        />
      </div>
      <Buttons
        okDisabled={busy}
        okAttr={{ "data-image-indexed-apply": "" }}
        onOk={() => onApply(palette, colours)}
        onCancel={onCancel}
      />
      <div style={note}>{t(M.indexedNote)}</div>
    </section>
  );
}
