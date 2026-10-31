// SELECTION AND MASKING in the Image panel (image ADR 470, WP5.5): the
// selection toolbar (Color Range, Select and Mask, Quick Mask, Grow,
// Similar, Focus Area), the dialogs that sit on top of the panel (Color
// Range, Focus Area, Load Selection), the Select and Mask workspace, and
// the Channels and Paths sections (alpha and spot channels, per-channel
// view, stored paths).
//
// Each piece is PURE (props in, elements out) so the DOM specs can drive
// it; `MaskingSections` wires them to the session's masking controller.

import { useEffect, useRef, useState } from "react";

import { onDidChangeOf, useLive } from "@paged-media/react-live";
import { defineMessages, t } from "@paged-media/strings";
import { color, font, space } from "@paged-media/panel-kit";

import type {
  ColorRangeOptions,
  ColorRangeSelect,
  DisplayView,
  MaskingInfo,
  MaskMode,
  MatteView,
  RefineOptions,
  RefineOutput,
} from "../../masking-engine";
import type { MaskingUiState } from "../../masking-session";
import type { VectorUiState } from "../../vector-session";
import type { ImageSession } from "../../session";
import { Section } from "./disclosure";
import { mono, note, row } from "./styles";

const M = defineMessages("image.maskingPanel", {
  selection: "Selection",
  colorRange: "Color Range…",
  selectAndMask: "Select and Mask…",
  quickMask: "Quick Mask",
  quickMaskOn: "Quick Mask (on)",
  grow: "Grow",
  similar: "Similar",
  focusArea: "Focus Area…",
  select: "Select",
  sampled: "Sampled colours",
  reds: "Reds",
  yellows: "Yellows",
  greens: "Greens",
  cyans: "Cyans",
  blues: "Blues",
  magentas: "Magentas",
  highlights: "Highlights",
  midtones: "Midtones",
  shadows: "Shadows",
  skinTones: "Skin tones",
  outOfGamut: "Out of gamut",
  fuzziness: "Fuzziness",
  range: "Range",
  lower: "Lower limit",
  upper: "Upper limit",
  localized: "Localized colour clusters",
  invert: "Invert",
  samples: "{count, plural, one {# sample} other {# samples}}",
  sampleMode: "Click the preview to",
  sampleReplace: "Sample",
  sampleAdd: "Add (+)",
  sampleSubtract: "Subtract (−)",
  canvasPreview: "Selection preview",
  none: "None",
  grayscale: "Grayscale",
  blackMatte: "Black matte",
  whiteMatte: "White matte",
  quickMaskPreview: "Quick Mask",
  ok: "OK",
  cancel: "Cancel",
  colorRangeNote:
    "Sampled colours select by their distance in Lab, so a fuzziness of F " +
    "reaches F/3 Lab units; the presets select by hue, by luminance or by " +
    "the classical skin-tone cluster. The preview is the selection: white " +
    "is selected.",
  outOfGamutNote:
    "Out of gamut needs a soft-proofing CMYK profile, which the image " +
    "module's colour settings do not have yet.",
  focusRange: "In-focus range",
  noise: "Image noise level",
  focusNote:
    "Selects what is sharp: the local variance of the Laplacian, " +
    "thresholded by the in-focus range and cleaned into regions.",
  loadSelection: "Load selection",
  channel: "Channel",
  operation: "Operation",
  replace: "New selection",
  add: "Add to selection",
  subtract: "Subtract from selection",
  intersect: "Intersect with selection",
  refineTitle: "Select and Mask",
  view: "View",
  overlay: "Overlay",
  onBlack: "On black",
  onWhite: "On white",
  blackWhite: "Black & white",
  onLayers: "On layers",
  opacity: "Opacity",
  edgeDetection: "Edge detection radius",
  smartRadius: "Smart radius",
  smooth: "Smooth",
  feather: "Feather",
  contrast: "Contrast",
  shiftEdge: "Shift edge",
  decontaminate: "Decontaminate colours",
  amount: "Amount",
  output: "Output to",
  outSelection: "Selection",
  outLayerMask: "Layer mask",
  outNewLayer: "New layer with layer mask",
  brushSize: "Refine Edge brush size",
  refineNote:
    "Paint with the Refine Edge brush (in the Quick Selection flyout) to " +
    "mark where the edge is re-solved; Alt erases the marks.",
  channels: "Alpha and spot channels",
  composite: "Composite",
  red: "Red",
  green: "Green",
  blue: "Blue",
  alpha: "Alpha",
  luma: "Luminosity",
  viewTitle: "Show {name} on its own",
  paintTitle: "Paint {name} with the brushes",
  loadTitle: "Load {name} as the selection",
  duplicate: "Duplicate",
  delete: "Delete",
  rename: "Name of {name}",
  saveSelection: "Save selection",
  newSpot: "New spot channel",
  solidity: "Solidity",
  spotColour: "Ink colour",
  noChannels: "No saved selections yet.",
  quickMaskChannel: "Quick Mask",
  spotsShown: "Show spot channels on the image",
  channelsNote:
    "A saved selection is a channel: white is selected. Spot channels are " +
    "stored with the session and shown in their ink; PSD export does not " +
    "write channels yet.",
  paths: "Paths",
  noPaths: "No paths yet.",
  makeWorkPath: "Make work path from selection",
  makeSelection: "Make selection",
  pathsNote:
    "Paths are stored with the image session. Edit ▸ Selection to path " +
    "still makes document shapes when you want them on the page.",
});

/** The Paths panel's and the vector mask's words (image ADR 476). */
const VP = defineMessages("image.vectorsPanel", {
  workPath: "work path",
  target: "Edit {name} with the Pen and the path tools",
  fill: "Fill",
  fillTitle: "Fill {name} with the foreground colour",
  stroke: "Stroke",
  strokeTitle: "Stroke {name} with the brush",
  save: "Save path",
  maskFromPath: "Vector mask",
  maskFromPathTitle: "Add {name} to the active layer as its vector mask",
  vectorMask: "Vector mask",
  noVectorMask: "The active layer has no vector mask.",
  vectorMaskOf: "{layer}: {count} subpath(s){state}",
  vectorMaskOff: ", disabled",
  vectorMaskInverted: ", inverted",
  revealAll: "Reveal all",
  hideAll: "Hide all",
  editMask: "Edit with the path tools",
  enable: "Enable",
  disable: "Disable",
  invert: "Invert",
  rasterize: "Rasterize",
  deleteMask: "Delete",
  vectorNote:
    "A vector mask is drawn from its paths, exactly as Photoshop draws it, and " +
    "multiplies with the layer mask. On a fill layer it makes a shape layer.",
});

const SELECTS: Array<[ColorRangeSelect, string]> = [
  ["sampled", M.sampled],
  ["reds", M.reds],
  ["yellows", M.yellows],
  ["greens", M.greens],
  ["cyans", M.cyans],
  ["blues", M.blues],
  ["magentas", M.magentas],
  ["highlights", M.highlights],
  ["midtones", M.midtones],
  ["shadows", M.shadows],
  ["skinTones", M.skinTones],
  ["outOfGamut", M.outOfGamut],
];

const MODES: Array<[MaskMode, string]> = [
  ["replace", M.replace],
  ["add", M.add],
  ["subtract", M.subtract],
  ["intersect", M.intersect],
];

const MATTES: Array<[MatteView, string]> = [
  ["overlay", M.overlay],
  ["onBlack", M.onBlack],
  ["onWhite", M.onWhite],
  ["blackWhite", M.blackWhite],
  ["onLayers", M.onLayers],
];

const box = {
  border: `1px solid ${color.border}`,
  borderRadius: 4,
  padding: space[2],
  margin: `${space[2]} 0`,
} as const;
const title = { fontWeight: 600, marginBottom: space[1] } as const;
const num = { width: 64, font: `11px ${font.mono}` } as const;

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  attr,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  attr: string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={row}>
      <label>
        {label}{" "}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          data-masking-slider={attr}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
      <span style={mono}>
        {value}
        {unit}
      </span>
    </div>
  );
}

function Buttons({
  okAttr,
  onOk,
  onCancel,
  okDisabled = false,
}: {
  okAttr: string;
  onOk: () => void;
  onCancel: () => void;
  okDisabled?: boolean;
}) {
  return (
    <div style={{ ...row, borderBottom: "none", justifyContent: "flex-end" }}>
      <button
        type="button"
        data-masking-cancel={okAttr}
        onClick={() => onCancel()}
      >
        {t(M.cancel)}
      </button>
      <button
        type="button"
        data-masking-ok={okAttr}
        disabled={okDisabled}
        onClick={() => onOk()}
      >
        {t(M.ok)}
      </button>
    </div>
  );
}

/** A coverage field drawn small, white = selected; a click answers the
 *  image pixel under it. */
export function CoverageThumb({
  data,
  width,
  height,
  onPick,
}: {
  data: Uint8Array | null;
  width: number;
  height: number;
  onPick?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scale = Math.min(1, 160 / Math.max(width, height, 1));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  useEffect(() => {
    const ctx = ref.current?.getContext?.("2d");
    if (!ctx || !data || data.length !== width * height) return;
    const img = ctx.createImageData(tw, th);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(width - 1, Math.floor(x / scale));
        const sy = Math.min(height - 1, Math.floor(y / scale));
        const v = data[sy * width + sx];
        const o = (y * tw + x) * 4;
        img.data[o] = v;
        img.data[o + 1] = v;
        img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [data, width, height, tw, th, scale]);
  return (
    <canvas
      ref={ref}
      width={tw}
      height={th}
      data-masking-thumb
      style={{ border: `1px solid ${color.border}`, cursor: "crosshair" }}
      onClick={(e) => {
        if (!onPick) return;
        const r = e.currentTarget.getBoundingClientRect();
        const fx = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
        const fy = r.height > 0 ? (e.clientY - r.top) / r.height : 0;
        onPick(
          Math.min(width - 1, Math.max(0, Math.floor(fx * width))),
          Math.min(height - 1, Math.max(0, Math.floor(fy * height))),
        );
      }}
    />
  );
}

export function ColorRangeDialog({
  opts,
  preview,
  canvasPreview,
  width,
  height,
  onChange,
  onSample,
  onCanvasPreview,
  onOk,
  onCancel,
}: {
  opts: ColorRangeOptions;
  preview: Uint8Array | null;
  canvasPreview: "none" | MatteView;
  width: number;
  height: number;
  onChange: (patch: Partial<ColorRangeOptions>) => void;
  onSample: (x: number, y: number, how: "replace" | "add" | "subtract") => void;
  onCanvasPreview: (mode: "none" | MatteView) => void;
  onOk: () => void;
  onCancel: () => void;
}) {
  const [how, setHow] = useState<"replace" | "add" | "subtract">("replace");
  const tonal =
    opts.select === "highlights" ||
    opts.select === "midtones" ||
    opts.select === "shadows";
  const fuzzy =
    opts.select === "sampled" || opts.select === "skinTones" || tonal;
  return (
    <div style={box} data-masking-dialog="colorRange">
      <div style={title}>{t(M.colorRange)}</div>
      <div style={row}>
        <label>
          {t(M.select)}{" "}
          <select
            data-masking-select
            value={opts.select}
            onChange={(e) =>
              onChange({ select: e.target.value as ColorRangeSelect })
            }
          >
            {SELECTS.map(([v, l]) => (
              <option key={v} value={v} disabled={v === "outOfGamut"}>
                {t(l)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {fuzzy && (
        <Slider
          label={t(M.fuzziness)}
          attr="fuzziness"
          value={opts.fuzziness}
          min={0}
          max={tonal ? 100 : 200}
          unit={tonal ? "%" : ""}
          onChange={(v) => onChange({ fuzziness: v })}
        />
      )}
      {tonal && (
        <div style={row}>
          <label>
            {t(M.lower)}{" "}
            <input
              type="number"
              style={num}
              min={0}
              max={255}
              data-masking-lower
              value={opts.lower}
              onChange={(e) => onChange({ lower: Number(e.target.value) })}
            />
          </label>
          <label>
            {t(M.upper)}{" "}
            <input
              type="number"
              style={num}
              min={0}
              max={255}
              data-masking-upper
              value={opts.upper}
              onChange={(e) => onChange({ upper: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      {opts.select === "sampled" && (
        <>
          <div style={row}>
            <label>
              <input
                type="checkbox"
                data-masking-localized
                checked={opts.localized}
                onChange={(e) => onChange({ localized: e.target.checked })}
              />{" "}
              {t(M.localized)}
            </label>
            <span style={mono}>
              {t(M.samples, { count: opts.samples.length })}
            </span>
          </div>
          {opts.localized && (
            <Slider
              label={t(M.range)}
              attr="range"
              value={opts.range}
              min={1}
              max={100}
              unit="%"
              onChange={(v) => onChange({ range: v })}
            />
          )}
          <div style={row}>
            <span>{t(M.sampleMode)}</span>
            {(
              [
                ["replace", M.sampleReplace],
                ["add", M.sampleAdd],
                ["subtract", M.sampleSubtract],
              ] as const
            ).map(([h, l]) => (
              <button
                key={h}
                type="button"
                data-masking-sample-mode={h}
                aria-pressed={how === h}
                onClick={() => setHow(h)}
              >
                {t(l)}
              </button>
            ))}
          </div>
        </>
      )}
      {opts.select === "outOfGamut" && (
        <div style={note}>{t(M.outOfGamutNote)}</div>
      )}
      <div style={{ ...row, justifyContent: "center" }}>
        <CoverageThumb
          data={preview}
          width={width}
          height={height}
          onPick={(x, y) => onSample(x, y, how)}
        />
      </div>
      <div style={row}>
        <label>
          <input
            type="checkbox"
            data-masking-invert
            checked={opts.invert}
            onChange={(e) => onChange({ invert: e.target.checked })}
          />{" "}
          {t(M.invert)}
        </label>
        <label>
          {t(M.canvasPreview)}{" "}
          <select
            data-masking-canvas-preview
            value={canvasPreview}
            onChange={(e) =>
              onCanvasPreview(e.target.value as "none" | MatteView)
            }
          >
            <option value="none">{t(M.none)}</option>
            <option value="blackWhite">{t(M.grayscale)}</option>
            <option value="onBlack">{t(M.blackMatte)}</option>
            <option value="onWhite">{t(M.whiteMatte)}</option>
            <option value="overlay">{t(M.quickMaskPreview)}</option>
          </select>
        </label>
      </div>
      <div style={note}>{t(M.colorRangeNote)}</div>
      <Buttons
        okAttr="colorRange"
        okDisabled={opts.select === "outOfGamut"}
        onOk={onOk}
        onCancel={onCancel}
      />
    </div>
  );
}

export function FocusAreaDialog({
  range,
  noise,
  preview,
  width,
  height,
  onChange,
  onOk,
  onCancel,
}: {
  range: number;
  noise: number;
  preview: Uint8Array | null;
  width: number;
  height: number;
  onChange: (patch: { range?: number; noise?: number }) => void;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={box} data-masking-dialog="focusArea">
      <div style={title}>{t(M.focusArea)}</div>
      <Slider
        label={t(M.focusRange)}
        attr="focusRange"
        value={Math.round(range * 100)}
        min={0}
        max={100}
        unit="%"
        onChange={(v) => onChange({ range: v / 100 })}
      />
      <Slider
        label={t(M.noise)}
        attr="noise"
        value={Math.round(noise * 100)}
        min={0}
        max={100}
        unit="%"
        onChange={(v) => onChange({ noise: v / 100 })}
      />
      <div style={{ ...row, justifyContent: "center" }}>
        <CoverageThumb data={preview} width={width} height={height} />
      </div>
      <div style={note}>{t(M.focusNote)}</div>
      <Buttons okAttr="focusArea" onOk={onOk} onCancel={onCancel} />
    </div>
  );
}

export function LoadSelectionDialog({
  info,
  channel,
  mode,
  invert,
  onChange,
  onOk,
  onCancel,
}: {
  info: MaskingInfo;
  channel: number;
  mode: MaskMode;
  invert: boolean;
  onChange: (patch: {
    channel?: number;
    mode?: MaskMode;
    invert?: boolean;
  }) => void;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={box} data-masking-dialog="loadSelection">
      <div style={title}>{t(M.loadSelection)}</div>
      <div style={row}>
        <label>
          {t(M.channel)}{" "}
          <select
            data-masking-load-channel
            value={channel}
            onChange={(e) => onChange({ channel: Number(e.target.value) })}
          >
            {info.channels
              .filter((c) => c.kind !== "quickMask")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            data-masking-load-invert
            checked={invert}
            onChange={(e) => onChange({ invert: e.target.checked })}
          />{" "}
          {t(M.invert)}
        </label>
      </div>
      <div>
        {MODES.map(([m, l]) => (
          <label key={m} style={{ display: "block" }}>
            <input
              type="radio"
              name="pg-masking-load-mode"
              data-masking-load-mode={m}
              checked={mode === m}
              onChange={() => onChange({ mode: m })}
            />{" "}
            {t(l)}
          </label>
        ))}
      </div>
      <Buttons okAttr="loadSelection" onOk={onOk} onCancel={onCancel} />
    </div>
  );
}

export function SelectAndMaskWorkspace({
  opts,
  view,
  opacity,
  output,
  brushRadius,
  alpha,
  width,
  height,
  onChange,
  onView,
  onOutput,
  onBrush,
  onOk,
  onCancel,
}: {
  opts: RefineOptions;
  view: MatteView;
  opacity: number;
  output: RefineOutput;
  brushRadius: number;
  alpha: Uint8Array | null;
  width: number;
  height: number;
  onChange: (patch: Partial<RefineOptions>) => void;
  onView: (view: MatteView, opacity?: number) => void;
  onOutput: (output: RefineOutput) => void;
  onBrush: (radius: number) => void;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={box} data-masking-dialog="selectAndMask">
      <div style={title}>{t(M.refineTitle)}</div>
      <div style={row}>
        <label>
          {t(M.view)}{" "}
          <select
            data-masking-view
            value={view}
            onChange={(e) => onView(e.target.value as MatteView)}
          >
            {MATTES.map(([v, l]) => (
              <option key={v} value={v}>
                {t(l)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {view === "overlay" && (
        <Slider
          label={t(M.opacity)}
          attr="opacity"
          value={Math.round(opacity * 100)}
          min={0}
          max={100}
          unit="%"
          onChange={(v) => onView(view, v / 100)}
        />
      )}
      <Slider
        label={t(M.edgeDetection)}
        attr="radius"
        value={opts.radius}
        min={0}
        max={250}
        unit=" px"
        onChange={(v) => onChange({ radius: v })}
      />
      <div style={row}>
        <label>
          <input
            type="checkbox"
            data-masking-smart
            checked={opts.smartRadius}
            onChange={(e) => onChange({ smartRadius: e.target.checked })}
          />{" "}
          {t(M.smartRadius)}
        </label>
      </div>
      <Slider
        label={t(M.smooth)}
        attr="smooth"
        value={opts.smooth}
        min={0}
        max={100}
        onChange={(v) => onChange({ smooth: v })}
      />
      <Slider
        label={t(M.feather)}
        attr="feather"
        value={opts.feather}
        min={0}
        max={250}
        step={0.5}
        unit=" px"
        onChange={(v) => onChange({ feather: v })}
      />
      <Slider
        label={t(M.contrast)}
        attr="contrast"
        value={opts.contrast}
        min={0}
        max={100}
        unit="%"
        onChange={(v) => onChange({ contrast: v })}
      />
      <Slider
        label={t(M.shiftEdge)}
        attr="shiftEdge"
        value={opts.shiftEdge}
        min={-100}
        max={100}
        unit="%"
        onChange={(v) => onChange({ shiftEdge: v })}
      />
      <div style={row}>
        <label>
          <input
            type="checkbox"
            data-masking-decontaminate
            checked={opts.decontaminate}
            onChange={(e) => onChange({ decontaminate: e.target.checked })}
          />{" "}
          {t(M.decontaminate)}
        </label>
      </div>
      {opts.decontaminate && (
        <Slider
          label={t(M.amount)}
          attr="amount"
          value={opts.amount}
          min={0}
          max={100}
          unit="%"
          onChange={(v) => onChange({ amount: v })}
        />
      )}
      <Slider
        label={t(M.brushSize)}
        attr="brush"
        value={brushRadius}
        min={1}
        max={200}
        unit=" px"
        onChange={onBrush}
      />
      <div style={row}>
        <label>
          {t(M.output)}{" "}
          <select
            data-masking-output
            value={output}
            onChange={(e) => onOutput(e.target.value as RefineOutput)}
          >
            <option value="selection">{t(M.outSelection)}</option>
            <option value="layerMask">{t(M.outLayerMask)}</option>
            <option value="newLayerWithMask">{t(M.outNewLayer)}</option>
          </select>
        </label>
      </div>
      <div style={{ ...row, justifyContent: "center" }}>
        <CoverageThumb data={alpha} width={width} height={height} />
      </div>
      <div style={note}>{t(M.refineNote)}</div>
      <Buttons okAttr="selectAndMask" onOk={onOk} onCancel={onCancel} />
    </div>
  );
}

const COMPONENTS = [
  ["red", M.red],
  ["green", M.green],
  ["blue", M.blue],
  ["alpha", M.alpha],
  ["luma", M.luma],
] as const;

export function ChannelsListSection({
  info,
  view,
  disabled,
  hasSelection,
  onView,
  onEdit,
  onLoad,
  onRename,
  onDuplicate,
  onDelete,
  onSave,
  onNewSpot,
  onSpot,
}: {
  info: MaskingInfo;
  view: DisplayView;
  disabled: boolean;
  hasSelection: boolean;
  onView: (view: DisplayView) => void;
  onEdit: (id: number | null) => void;
  onLoad: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
  onSave: () => void;
  onNewSpot: (colour: [number, number, number], solidity: number) => void;
  onSpot: (
    id: number,
    colour: [number, number, number],
    solidity: number,
  ) => void;
}) {
  const [ink, setInk] = useState("#00a0e0");
  const [solidity, setSolidity] = useState(0);
  const rgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16) || 0,
    parseInt(hex.slice(3, 5), 16) || 0,
    parseInt(hex.slice(5, 7), 16) || 0,
  ];
  const hex = (c: [number, number, number]) =>
    "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const viewing = (v: DisplayView) =>
    JSON.stringify(v) === JSON.stringify(view);
  return (
    <Section title={t(M.channels)} data-masking-channels>
      <div style={row}>
        <button
          type="button"
          data-masking-view-component="composite"
          aria-pressed={view.kind === "composite"}
          disabled={disabled}
          onClick={() => onView({ kind: "composite" })}
        >
          {t(M.composite)}
        </button>
        {COMPONENTS.map(([c, l]) => (
          <button
            key={c}
            type="button"
            data-masking-view-component={c}
            aria-pressed={viewing({ kind: "component", channel: c })}
            disabled={disabled}
            onClick={() => onView({ kind: "component", channel: c })}
          >
            {t(l)}
          </button>
        ))}
      </div>
      {info.channels.length === 0 && <div style={note}>{t(M.noChannels)}</div>}
      {info.channels.map((c) => (
        <div key={c.id} style={row} data-masking-channel={c.id}>
          <button
            type="button"
            data-masking-channel-view={c.id}
            aria-pressed={viewing({ kind: "channel", id: c.id })}
            title={t(M.viewTitle, { name: c.name })}
            disabled={disabled}
            onClick={() =>
              onView(
                viewing({ kind: "channel", id: c.id })
                  ? { kind: "composite" }
                  : { kind: "channel", id: c.id },
              )
            }
          >
            👁
          </button>
          {c.kind === "quickMask" ? (
            <span>{t(M.quickMaskChannel)}</span>
          ) : (
            <input
              type="text"
              aria-label={t(M.rename, { name: c.name })}
              data-masking-channel-name={c.id}
              defaultValue={c.name}
              disabled={disabled}
              onBlur={(e) => {
                if (e.target.value !== c.name) onRename(c.id, e.target.value);
              }}
            />
          )}
          {c.kind === "spot" && c.colour && (
            <input
              type="color"
              aria-label={t(M.spotColour)}
              data-masking-spot-colour={c.id}
              value={hex(c.colour)}
              disabled={disabled}
              onChange={(e) =>
                onSpot(c.id, rgb(e.target.value), c.solidity ?? 0)
              }
            />
          )}
          <span style={mono}>{Math.round(c.coverage * 100)}%</span>
          <button
            type="button"
            data-masking-channel-paint={c.id}
            aria-pressed={info.editChannel === c.id}
            title={t(M.paintTitle, { name: c.name })}
            disabled={disabled}
            onClick={() => onEdit(info.editChannel === c.id ? null : c.id)}
          >
            ✎
          </button>
          {c.kind !== "quickMask" && (
            <>
              <button
                type="button"
                data-masking-channel-load={c.id}
                title={t(M.loadTitle, { name: c.name })}
                disabled={disabled}
                onClick={() => onLoad(c.id)}
              >
                ◌
              </button>
              <button
                type="button"
                data-masking-channel-duplicate={c.id}
                title={t(M.duplicate)}
                disabled={disabled}
                onClick={() => onDuplicate(c.id)}
              >
                ⧉
              </button>
              <button
                type="button"
                data-masking-channel-delete={c.id}
                title={t(M.delete)}
                disabled={disabled}
                onClick={() => onDelete(c.id)}
              >
                ✕
              </button>
            </>
          )}
        </div>
      ))}
      <div style={row}>
        <button
          type="button"
          data-masking-save-selection
          disabled={disabled}
          onClick={() => onSave()}
        >
          {t(M.saveSelection)}
        </button>
      </div>
      <div style={row}>
        <input
          type="color"
          aria-label={t(M.spotColour)}
          data-masking-new-spot-colour
          value={ink}
          onChange={(e) => setInk(e.target.value)}
        />
        <label>
          {t(M.solidity)}{" "}
          <input
            type="number"
            style={num}
            min={0}
            max={100}
            data-masking-new-spot-solidity
            value={solidity}
            onChange={(e) => setSolidity(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          data-masking-new-spot
          disabled={disabled || !hasSelection}
          onClick={() => onNewSpot(rgb(ink), solidity / 100)}
        >
          {t(M.newSpot)}
        </button>
      </div>
      {info.channels.some((c) => c.kind === "spot") && (
        <div style={row}>
          <label>
            <input
              type="checkbox"
              data-masking-show-spots
              checked={view.kind === "composite" && !!view.spots}
              onChange={(e) =>
                onView({ kind: "composite", spots: e.target.checked })
              }
            />{" "}
            {t(M.spotsShown)}
          </label>
        </div>
      )}
      <div style={note}>{t(M.channelsNote)}</div>
    </Section>
  );
}

export function PathsSection({
  info,
  disabled,
  hasSelection,
  target = null,
  onMakeWorkPath,
  onMakeSelection,
  onRename,
  onDuplicate,
  onDelete,
  onTarget,
  onFill,
  onStroke,
  onSave,
  onVectorMask,
}: {
  info: MaskingInfo;
  disabled: boolean;
  hasSelection: boolean;
  /** The path the Pen and the path tools edit (ADR 476). */
  target?: number | null;
  onMakeWorkPath: () => void;
  onMakeSelection: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
  onTarget?: (id: number | null) => void;
  onFill?: (id: number) => void;
  onStroke?: (id: number) => void;
  onSave?: () => void;
  onVectorMask?: (id: number) => void;
}) {
  return (
    <Section title={t(M.paths)} data-masking-paths>
      {info.paths.length === 0 && <div style={note}>{t(M.noPaths)}</div>}
      {info.paths.map((p) => (
        <div key={p.id} style={row} data-masking-path={p.id}>
          {onTarget && (
            <input
              type="radio"
              name="image-path-target"
              aria-label={t(VP.target, { name: p.name })}
              data-vector-path-target={p.id}
              checked={target === p.id}
              disabled={disabled}
              onChange={() => onTarget(p.id)}
            />
          )}
          <input
            type="text"
            aria-label={t(M.rename, { name: p.name })}
            data-masking-path-name={p.id}
            defaultValue={p.name}
            disabled={disabled}
            style={p.work ? { fontStyle: "italic" } : undefined}
            onBlur={(e) => {
              if (e.target.value !== p.name) onRename(p.id, e.target.value);
            }}
          />
          {p.work && <span style={note}>{t(VP.workPath)}</span>}
          <span style={mono}>{p.anchors}</span>
          {onFill && (
            <button
              type="button"
              data-vector-path-fill={p.id}
              title={t(VP.fillTitle, { name: p.name })}
              disabled={disabled}
              onClick={() => onFill(p.id)}
            >
              {t(VP.fill)}
            </button>
          )}
          {onStroke && (
            <button
              type="button"
              data-vector-path-stroke={p.id}
              title={t(VP.strokeTitle, { name: p.name })}
              disabled={disabled}
              onClick={() => onStroke(p.id)}
            >
              {t(VP.stroke)}
            </button>
          )}
          {onVectorMask && (
            <button
              type="button"
              data-vector-path-mask={p.id}
              title={t(VP.maskFromPathTitle, { name: p.name })}
              disabled={disabled}
              onClick={() => onVectorMask(p.id)}
            >
              {t(VP.maskFromPath)}
            </button>
          )}
          {p.work && onSave && (
            <button
              type="button"
              data-vector-path-save={p.id}
              disabled={disabled}
              onClick={() => onSave()}
            >
              {t(VP.save)}
            </button>
          )}
          <button
            type="button"
            data-masking-path-select={p.id}
            disabled={disabled}
            onClick={() => onMakeSelection(p.id)}
          >
            {t(M.makeSelection)}
          </button>
          <button
            type="button"
            data-masking-path-duplicate={p.id}
            title={t(M.duplicate)}
            disabled={disabled}
            onClick={() => onDuplicate(p.id)}
          >
            ⧉
          </button>
          <button
            type="button"
            data-masking-path-delete={p.id}
            title={t(M.delete)}
            disabled={disabled}
            onClick={() => onDelete(p.id)}
          >
            ✕
          </button>
        </div>
      ))}
      <div style={row}>
        <button
          type="button"
          data-masking-make-work-path
          disabled={disabled || !hasSelection}
          onClick={() => onMakeWorkPath()}
        >
          {t(M.makeWorkPath)}
        </button>
      </div>
      <div style={note}>{t(M.pathsNote)}</div>
    </Section>
  );
}

/** The active layer's VECTOR MASK (image ADR 476): add one (reveal all,
 *  hide all), edit it with the path tools, switch, invert, rasterize or
 *  delete it. */
export function VectorMaskSection({
  layer,
  editing,
  disabled,
  onAdd,
  onEdit,
  onToggle,
  onInvert,
  onRasterize,
  onDelete,
}: {
  layer: {
    name: string;
    vectorMask?: {
      enabled: boolean;
      invert: boolean;
      subpaths: number;
    } | null;
  } | null;
  /** The path tools edit this mask now. */
  editing: boolean;
  disabled: boolean;
  onAdd: (start: "revealAll" | "hideAll") => void;
  onEdit: () => void;
  onToggle: () => void;
  onInvert: () => void;
  onRasterize: () => void;
  onDelete: () => void;
}) {
  const vm = layer?.vectorMask ?? null;
  const off = disabled || !layer;
  return (
    <Section title={t(VP.vectorMask)} data-vector-mask>
      {!vm && (
        <>
          <div style={note}>{t(VP.noVectorMask)}</div>
          <div style={row}>
            <button
              type="button"
              data-vector-mask-reveal-all
              disabled={off}
              onClick={() => onAdd("revealAll")}
            >
              {t(VP.revealAll)}
            </button>
            <button
              type="button"
              data-vector-mask-hide-all
              disabled={off}
              onClick={() => onAdd("hideAll")}
            >
              {t(VP.hideAll)}
            </button>
          </div>
        </>
      )}
      {vm && layer && (
        <>
          <div style={note} data-vector-mask-state>
            {t(VP.vectorMaskOf, {
              layer: layer.name,
              count: vm.subpaths,
              state:
                (vm.enabled ? "" : t(VP.vectorMaskOff)) +
                (vm.invert ? t(VP.vectorMaskInverted) : ""),
            })}
          </div>
          <div style={row}>
            <button
              type="button"
              data-vector-mask-edit
              aria-pressed={editing}
              disabled={off}
              onClick={() => onEdit()}
            >
              {t(VP.editMask)}
            </button>
            <button
              type="button"
              data-vector-mask-toggle
              disabled={off}
              onClick={() => onToggle()}
            >
              {t(vm.enabled ? VP.disable : VP.enable)}
            </button>
            <button
              type="button"
              data-vector-mask-invert
              disabled={off}
              onClick={() => onInvert()}
            >
              {t(VP.invert)}
            </button>
            <button
              type="button"
              data-vector-mask-rasterize
              disabled={off || !vm.enabled}
              onClick={() => onRasterize()}
            >
              {t(VP.rasterize)}
            </button>
            <button
              type="button"
              data-vector-mask-delete
              disabled={off}
              onClick={() => onDelete()}
            >
              {t(VP.deleteMask)}
            </button>
          </div>
        </>
      )}
      <div style={note}>{t(VP.vectorNote)}</div>
    </Section>
  );
}

/** The selection toolbar: the Select menu's verbs, and the Quick Mask
 *  toggle (the contract has no toolbar door, so it lives here and in the
 *  menu). */
export function SelectionToolbar({
  quickMask,
  hasSelection,
  disabled,
  onColorRange,
  onSelectAndMask,
  onQuickMask,
  onGrow,
  onSimilar,
  onFocusArea,
}: {
  quickMask: boolean;
  hasSelection: boolean;
  disabled: boolean;
  onColorRange: () => void;
  onSelectAndMask: () => void;
  onQuickMask: () => void;
  onGrow: () => void;
  onSimilar: () => void;
  onFocusArea: () => void;
}) {
  return (
    <div style={{ ...row, flexWrap: "wrap" }} data-masking-toolbar>
      <button
        type="button"
        data-masking-cmd="colorRange"
        disabled={disabled}
        onClick={() => onColorRange()}
      >
        {t(M.colorRange)}
      </button>
      <button
        type="button"
        data-masking-cmd="selectAndMask"
        disabled={disabled || !hasSelection}
        onClick={() => onSelectAndMask()}
      >
        {t(M.selectAndMask)}
      </button>
      <button
        type="button"
        data-masking-cmd="quickMask"
        aria-pressed={quickMask}
        disabled={disabled}
        onClick={() => onQuickMask()}
      >
        {t(quickMask ? M.quickMaskOn : M.quickMask)}
      </button>
      <button
        type="button"
        data-masking-cmd="grow"
        disabled={disabled || !hasSelection}
        onClick={() => onGrow()}
      >
        {t(M.grow)}
      </button>
      <button
        type="button"
        data-masking-cmd="similar"
        disabled={disabled || !hasSelection}
        onClick={() => onSimilar()}
      >
        {t(M.similar)}
      </button>
      <button
        type="button"
        data-masking-cmd="focusArea"
        disabled={disabled}
        onClick={() => onFocusArea()}
      >
        {t(M.focusArea)}
      </button>
    </div>
  );
}

/** Everything above, wired to the session's masking controller. */
export function MaskingSections({
  session,
  disabled,
}: {
  session: ImageSession;
  disabled: boolean;
}) {
  const live = useLive(session, onDidChangeOf);
  const st = live.state();
  const ui: MaskingUiState = live.masking().state();
  const vui: VectorUiState = live.vectors().state();
  const m = session.masking();
  const v = session.vectors();
  const activeLayer = st.layers.layers[st.layers.active] ?? null;
  const pathTarget = vui.target?.kind === "path" ? vui.target.id : null;
  const w = st.source?.width ?? 0;
  const h = st.source?.height ?? 0;
  const off = disabled || !st.source;
  const hasSelection = !!st.selection;
  return (
    <>
      <div style={{ marginTop: space[2] }}>
        <div style={{ fontWeight: 600 }}>{t(M.selection)}</div>
        <SelectionToolbar
          quickMask={ui.info.quickMask !== null}
          hasSelection={hasSelection}
          disabled={off}
          onColorRange={() => m.openColorRange()}
          onSelectAndMask={() => void m.openRefine()}
          onQuickMask={() => void m.toggleQuickMask()}
          onGrow={() => m.grow()}
          onSimilar={() => m.similar()}
          onFocusArea={() => m.openFocusArea()}
        />
      </div>
      {ui.colorRange && (
        <ColorRangeDialog
          opts={ui.colorRange.opts}
          preview={ui.colorRange.preview}
          canvasPreview={ui.colorRange.canvasPreview}
          width={w}
          height={h}
          onChange={(p) => void m.setColorRange(p)}
          onSample={(x, y, how) => void m.sampleColorRange(x, y, how)}
          onCanvasPreview={(mode) => void m.setColorRangePreview(mode)}
          onOk={() => void m.colorRangeOk()}
          onCancel={() => void m.colorRangeCancel()}
        />
      )}
      {ui.focusArea && (
        <FocusAreaDialog
          range={ui.focusArea.range}
          noise={ui.focusArea.noise}
          preview={ui.focusArea.preview}
          width={w}
          height={h}
          onChange={(p) => void m.setFocusArea(p)}
          onOk={() => void m.focusAreaOk()}
          onCancel={() => void m.focusAreaCancel()}
        />
      )}
      {ui.load && (
        <LoadSelectionDialog
          info={ui.info}
          channel={ui.load.channel}
          mode={ui.load.mode}
          invert={ui.load.invert}
          onChange={(p) => m.setLoadSelection(p)}
          onOk={() => m.loadSelectionOk()}
          onCancel={() => m.loadSelectionCancel()}
        />
      )}
      {ui.refine && (
        <SelectAndMaskWorkspace
          opts={ui.refine.opts}
          view={ui.refine.view}
          opacity={ui.refine.opacity}
          output={ui.refine.output}
          brushRadius={ui.refine.brushRadius}
          alpha={ui.refine.alpha}
          width={w}
          height={h}
          onChange={(p) => void m.setRefine(p)}
          onView={(v, o) => void m.setRefineView(v, o)}
          onOutput={(o) => m.setRefineOutput(o)}
          onBrush={(r) => m.setRefineBrush(r)}
          onOk={() => void m.refineOk()}
          onCancel={() => void m.refineCancel()}
        />
      )}
      <ChannelsListSection
        info={ui.info}
        view={ui.view}
        disabled={off}
        hasSelection={hasSelection}
        onView={(v) => void m.setView(v)}
        onEdit={(id) => m.editChannel(id)}
        onLoad={(id) => m.loadSelection(id)}
        onRename={(id, name) => m.renameChannel(id, name)}
        onDuplicate={(id) => m.duplicateChannel(id)}
        onDelete={(id) => m.deleteChannel(id)}
        onSave={() => m.saveSelection()}
        onNewSpot={(c, s) => m.newSpotChannel("", c, s)}
        onSpot={(id, c, s) => m.setSpot(id, c, s)}
      />
      <PathsSection
        info={ui.info}
        disabled={off}
        hasSelection={hasSelection}
        onMakeWorkPath={() => m.pathFromSelection()}
        onMakeSelection={(id) => m.makeSelectionFromPath(id)}
        onRename={(id, name) => m.renamePath(id, name)}
        onDuplicate={(id) => m.duplicatePath(id)}
        onDelete={(id) => m.deletePath(id)}
        target={pathTarget}
        onTarget={(id) => v.selectPath(id)}
        onFill={(id) => void v.fillPath(id)}
        onStroke={(id) => void v.strokePath(id)}
        onSave={() => v.saveWorkPath()}
        onVectorMask={(id) => {
          v.selectPath(id);
          void v.addVectorMask("currentPath");
        }}
      />
      <VectorMaskSection
        layer={activeLayer}
        editing={
          vui.target?.kind === "vectorMask" &&
          vui.target.layer === st.layers.active
        }
        disabled={off}
        onAdd={(start) => void v.addVectorMask(start)}
        onEdit={() => v.selectVectorMask(st.layers.active)}
        onToggle={() => void v.toggleVectorMask()}
        onInvert={() => void v.invertVectorMask()}
        onRasterize={() => void v.rasterizeVectorMask()}
        onDelete={() => void v.deleteVectorMask()}
      />
    </>
  );
}
