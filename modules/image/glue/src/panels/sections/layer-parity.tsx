// PHOTOSHOP LAYER PARITY (WP5.3) — the Layers panel's further controls:
// the filter bar, the active layer's strip (fill opacity, the four locks,
// colour label, link, Blending Options), New Fill / New Adjustment Layer,
// the merges and Layer via Copy/Cut, align and distribute, the PROPERTIES
// of a typed adjustment or fill layer, LAYER COMPS, and the Blending
// Options dialog (fill opacity, knockout, Blend If).
//
// Every component is PURE (props in, elements out); the panel wires them
// to the session, where each action is one undo step.

import { useState } from "react";
import { defineMessages, t } from "@paged-media/strings";
import { About, color, font, space } from "@paged-media/panel-kit";
import { hexToRgb, rgbToHex } from "@paged-media/helpers";

import {
  ADJUSTMENT_KINDS,
  COLOR_LABELS,
  type AdjustmentKind,
  type AlignEdge,
  type AlignTo,
  type ColorLabel,
  type FillKind,
  type Knockout,
  type LayerCompInfo,
  type LayerInfo,
  type LayerParams,
} from "../../engine";
import type { LayerFilter } from "../../session";
import { parseCube, toKernelCube } from "../../cube";
import {
  D,
  DEVELOP_SECTIONS,
  DEVELOP_SETTINGS,
  developDefaults,
} from "../../develop";

import { mono, note, row, sectionTitle } from "./styles";

const M = defineMessages("image.layerParity", {
  search: "Search layers by name",
  kindAll: "All kinds",
  kindPixels: "Pixel layers",
  kindAdjustment: "Adjustment layers",
  kindFill: "Fill layers",
  kindSmart: "Smart objects",
  colorAll: "All labels",
  filterKind: "Filter by kind",
  filterColor: "Filter by colour label",
  filtered: "{shown} of {total} layers shown",
  fill: "Fill",
  fillTitle:
    "Fill opacity: the layer's own pixels, apart from its opacity (on the " +
    "eight special modes it acts inside the blend)",
  lockTransparency: "Lock transparent pixels",
  lockPixels: "Lock image pixels",
  lockPosition: "Lock position",
  lockAll: "Lock all",
  label: "Colour label",
  link: "Link with the layer below",
  unlink: "Unlink",
  linked: "linked",
  blendingOptions: "Blending options…",
  rasterize: "Rasterize",
  newFill: "New fill layer…",
  newAdjustment: "New adjustment layer…",
  solid: "Solid colour",
  gradient: "Gradient",
  pattern: "Pattern",
  mergeDown: "Merge down",
  mergeVisible: "Merge visible",
  stampVisible: "Stamp visible",
  flatten: "Flatten image",
  mergeGroup: "Merge group",
  viaCopy: "Layer via copy",
  viaCut: "Layer via cut",
  align: "Align",
  alignLeft: "Align left edges",
  alignHCenter: "Align horizontal centres",
  alignRight: "Align right edges",
  alignTop: "Align top edges",
  alignVCenter: "Align vertical centres",
  alignBottom: "Align bottom edges",
  distributeH: "Distribute horizontal centres",
  distributeV: "Distribute vertical centres",
  alignTo: "Align to",
  toCanvas: "Canvas",
  toSelection: "Selection",
  toLayers: "Linked layers",
  alignNote:
    "Align and Distribute move the active layer and the layers linked " +
    "with it, by whole pixels; Distribute needs three.",
  properties: "Properties",
  none: "Select an adjustment or fill layer to edit its properties.",
  chain:
    "This adjustment layer is a stored chain of several adjustments — edit " +
    "it with the Adjust sliders above.",
  noSettings: "{name} has no settings.",
  channel: "Channel",
  composite: "RGB",
  red: "Red",
  green: "Green",
  blue: "Blue",
  inBlack: "Input black",
  inWhite: "Input white",
  gamma: "Gamma",
  outBlack: "Output black",
  outWhite: "Output white",
  points: "Points (input → output)",
  addPoint: "Add point",
  removePoint: "Remove point",
  brightness: "Brightness",
  contrast: "Contrast",
  exposure: "Exposure",
  offset: "Offset",
  vibrance: "Vibrance",
  saturation: "Saturation",
  hue: "Hue",
  lightness: "Lightness",
  colorize: "Colorize",
  edit: "Edit",
  master: "Master",
  reds: "Reds",
  yellows: "Yellows",
  greens: "Greens",
  cyans: "Cyans",
  blues: "Blues",
  magentas: "Magentas",
  whites: "Whites",
  neutrals: "Neutrals",
  blacks: "Blacks",
  tone: "Tone",
  shadows: "Shadows",
  midtones: "Midtones",
  highlights: "Highlights",
  cyanRed: "Cyan – Red",
  magentaGreen: "Magenta – Green",
  yellowBlue: "Yellow – Blue",
  filterColour: "Colour",
  density: "Density",
  preserveLuminosity: "Preserve luminosity",
  output: "Output channel",
  constant: "Constant",
  monochrome: "Monochrome",
  levels: "Levels",
  threshold: "Threshold level",
  reverse: "Reverse",
  stops: "Colour stops",
  addStop: "Add stop",
  removeStop: "Remove stop",
  position: "Position",
  cyan: "Cyan",
  magenta: "Magenta",
  yellow: "Yellow",
  black: "Black",
  absolute: "Absolute",
  loadCube: "Load .cube look…",
  look: "Look: {name}",
  noLook: "No look loaded (the identity).",
  style: "Style",
  linear: "Linear",
  radial: "Radial",
  angle: "Angle",
  reflected: "Reflected",
  diamond: "Diamond",
  angleDeg: "Angle (°)",
  scale: "Scale (%)",
  offsetX: "Offset x (%)",
  offsetY: "Offset y (%)",
  patternName: "Pattern: {name}",
  comps: "Layer comps",
  compsNone: "No layer comps yet.",
  newComp: "New layer comp",
  compName: "Name",
  recordVisibility: "Visibility",
  recordPosition: "Position",
  recordAppearance: "Appearance",
  apply: "Apply",
  update: "Update",
  remove: "Delete",
  compsNote:
    "A comp records the layers' visibility, position and appearance " +
    "(opacity, fill, mode, Blend If, knockout); Apply puts them back in one " +
    "undo step. The layers have no position apart from their pixels, so a " +
    "comp that records position puts back the pixels as they were placed.",
  dialogTitle: "Blending options — {name}",
  general: "General blending",
  advanced: "Advanced blending",
  knockout: "Knockout",
  knockoutNone: "None",
  knockoutShallow: "Shallow",
  knockoutDeep: "Deep",
  blendIf: "Blend If",
  gray: "Gray",
  thisLayer: "This layer",
  underlying: "Underlying layer",
  blackLow: "black",
  blackHigh: "black (split)",
  whiteLow: "white (split)",
  whiteHigh: "white",
  resetBlendIf: "Reset Blend If",
  blendNote:
    "Blend If hides the layer where its own value (This layer) or the " +
    "value beneath it (Underlying layer) lies outside the sliders; a split " +
    "slider fades over its range. Knockout lets the layer cut through the " +
    "layers beneath it, to the start of its group (shallow) or to the " +
    "Background (deep), with its fill opacity setting how much of it " +
    "stays.",
  close: "Close",
});

const ADJ_LABELS = defineMessages("image.adjustmentKind", {
  brightnessContrast: "Brightness/Contrast",
  levels: "Levels",
  curves: "Curves",
  exposure: "Exposure",
  vibrance: "Vibrance",
  hueSaturation: "Hue/Saturation",
  colorBalance: "Color Balance",
  blackWhite: "Black & White",
  photoFilter: "Photo Filter",
  channelMixer: "Channel Mixer",
  colorLookup: "Color Lookup",
  invert: "Invert",
  posterize: "Posterize",
  threshold: "Threshold",
  gradientMap: "Gradient Map",
  selectiveColor: "Selective Color",
  develop: "Develop",
});

const COLOR_WORDS = defineMessages("image.colorLabel", {
  none: "No colour",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  violet: "Violet",
  gray: "Gray",
});

/** The swatch of a colour label. */
const LABEL_SWATCH: Record<ColorLabel, string> = {
  none: "transparent",
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffc53d",
  green: "#30a46c",
  blue: "#3e63dd",
  violet: "#8e4ec6",
  gray: "#8b8d98",
};

export function adjustmentKindLabel(k: AdjustmentKind): string {
  return t(ADJ_LABELS[k]);
}

export function colorLabelWord(c: ColorLabel): string {
  return t(COLOR_WORDS[c]);
}

/** Does `l` pass the filter bar? */
export function matchesLayerFilter(l: LayerInfo, f: LayerFilter): boolean {
  const q = f.query.trim().toLowerCase();
  return (
    (q === "" || l.name.toLowerCase().includes(q)) &&
    (f.kind === "all" || l.kind === f.kind) &&
    (f.color === "all" || l.color === f.color)
  );
}

const small = { font: `11px ${font.sans}` } as const;
const numberStyle = { width: 52, font: `11px ${font.mono}` } as const;

// ───────────────────────────── filter bar ─────────────────────────────

export function LayerFilterBar({
  filter,
  shown,
  total,
  disabled,
  onFilter,
}: {
  filter: LayerFilter;
  shown: number;
  total: number;
  disabled: boolean;
  onFilter: (patch: Partial<LayerFilter>) => void;
}) {
  return (
    <div data-image-layer-filter style={{ ...row, gap: 4, flexWrap: "wrap" }}>
      <input
        type="search"
        placeholder={t(M.search)}
        aria-label={t(M.search)}
        data-image-layer-search
        value={filter.query}
        disabled={disabled}
        onChange={(e) => onFilter({ query: e.target.value })}
        style={{ ...small, flex: 1, minWidth: 80 }}
      />
      <select
        aria-label={t(M.filterKind)}
        data-image-layer-filter-kind
        value={filter.kind}
        disabled={disabled}
        onChange={(e) =>
          onFilter({ kind: e.target.value as LayerFilter["kind"] })
        }
        style={small}
      >
        <option value="all">{t(M.kindAll)}</option>
        <option value="pixels">{t(M.kindPixels)}</option>
        <option value="adjustment">{t(M.kindAdjustment)}</option>
        <option value="fill">{t(M.kindFill)}</option>
        <option value="smart">{t(M.kindSmart)}</option>
      </select>
      <select
        aria-label={t(M.filterColor)}
        data-image-layer-filter-color
        value={filter.color}
        disabled={disabled}
        onChange={(e) =>
          onFilter({ color: e.target.value as LayerFilter["color"] })
        }
        style={small}
      >
        <option value="all">{t(M.colorAll)}</option>
        {COLOR_LABELS.map((c) => (
          <option key={c} value={c}>
            {colorLabelWord(c)}
          </option>
        ))}
      </select>
      {shown !== total ? (
        <span style={{ ...note, marginTop: 0 }} data-image-layer-filtered>
          {t(M.filtered, { shown, total })}
        </span>
      ) : null}
    </div>
  );
}

/** A colour label chip that is also its picker. */
export function ColorLabelPicker({
  value,
  disabled,
  testAttr,
  onChange,
}: {
  value: ColorLabel;
  disabled: boolean;
  testAttr: Record<string, string | number>;
  onChange: (c: ColorLabel) => void;
}) {
  return (
    <select
      aria-label={t(M.label)}
      title={t(M.label)}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ColorLabel)}
      style={{
        ...small,
        width: 18,
        padding: 0,
        border: `1px solid ${color.border}`,
        background: LABEL_SWATCH[value],
      }}
      {...testAttr}
    >
      {COLOR_LABELS.map((c) => (
        <option key={c} value={c}>
          {colorLabelWord(c)}
        </option>
      ))}
    </select>
  );
}

// ───────────────────────── the active layer's strip ─────────────────────────

export function ActiveLayerStrip({
  layer,
  below,
  disabled,
  onFill,
  onLocks,
  onColor,
  onLink,
  onUnlink,
  onBlendingOptions,
  onRasterize,
}: {
  layer: LayerInfo | null;
  /** The layer below the active one (what Link links it with). */
  below: LayerInfo | null;
  disabled: boolean;
  onFill: (v: number) => void;
  onLocks: (
    patch: Partial<{
      pixels: boolean;
      transparency: boolean;
      position: boolean;
      all: boolean;
    }>,
  ) => void;
  onColor: (c: ColorLabel) => void;
  onLink: () => void;
  onUnlink: () => void;
  onBlendingOptions: () => void;
  onRasterize: () => void;
}) {
  if (!layer) return null;
  const lock = (
    key: "pixels" | "transparency" | "position" | "all",
    on: boolean,
    label: string,
    glyph: string,
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      data-image-layer-lock-kind={key}
      disabled={disabled}
      onClick={() => onLocks({ [key]: !on })}
      style={{ ...small, fontWeight: on ? 700 : 400, minWidth: 22 }}
    >
      {glyph}
    </button>
  );
  return (
    <div data-image-active-layer-strip>
      <div style={{ ...row, gap: 4 }}>
        <label style={small} htmlFor="pg-image-fill-opacity">
          {t(M.fill)}
        </label>
        <input
          id="pg-image-fill-opacity"
          type="range"
          min={0}
          max={1}
          step={0.01}
          title={t(M.fillTitle)}
          data-image-layer-fill-opacity
          value={layer.fillOpacity}
          disabled={disabled || layer.locks.all}
          onChange={(e) => onFill(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ ...mono, ...small }}>
          {Math.round(layer.fillOpacity * 100)}%
        </span>
      </div>
      <div style={{ ...row, gap: 4, flexWrap: "wrap" }}>
        {lock(
          "transparency",
          layer.locks.transparency,
          t(M.lockTransparency),
          "▦",
        )}
        {lock("pixels", layer.locked, t(M.lockPixels), "✎")}
        {lock("position", layer.locks.position, t(M.lockPosition), "✥")}
        {lock("all", layer.locks.all, t(M.lockAll), "🔒")}
        <ColorLabelPicker
          value={layer.color}
          disabled={disabled}
          testAttr={{ "data-image-layer-color": layer.index }}
          onChange={onColor}
        />
        {layer.link !== null ? (
          <button
            type="button"
            data-image-layer-unlink
            disabled={disabled}
            onClick={onUnlink}
            style={small}
          >
            {t(M.unlink)}
          </button>
        ) : (
          <button
            type="button"
            data-image-layer-link
            disabled={disabled || !below}
            onClick={onLink}
            style={small}
          >
            {t(M.link)}
          </button>
        )}
        <button
          type="button"
          data-image-open-blending-options
          disabled={disabled}
          onClick={onBlendingOptions}
          style={small}
        >
          {t(M.blendingOptions)}
        </button>
        {layer.kind === "fill" || layer.kind === "smart" ? (
          <button
            type="button"
            data-image-layer-rasterize
            disabled={disabled}
            onClick={onRasterize}
            style={small}
          >
            {t(M.rasterize)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────── new layers and verbs ───────────────────────────

export type MergeVerb =
  | "mergeDown"
  | "mergeVisible"
  | "stampVisible"
  | "flatten"
  | "mergeGroup"
  | "viaCopy"
  | "viaCut";

export function LayerVerbs({
  disabled,
  gpu,
  inGroup,
  hasSelection,
  alignTo,
  onAlignTo,
  onNewFill,
  onNewAdjustment,
  onVerb,
  onAlign,
  onDistribute,
}: {
  disabled: boolean;
  gpu: boolean;
  inGroup: boolean;
  hasSelection: boolean;
  alignTo: AlignTo;
  onAlignTo: (to: AlignTo) => void;
  onNewFill: (kind: FillKind) => void;
  onNewAdjustment: (kind: AdjustmentKind) => void;
  onVerb: (verb: MergeVerb) => void;
  onAlign: (edge: AlignEdge) => void;
  onDistribute: (axis: "horizontal" | "vertical") => void;
}) {
  const verb = (v: MergeVerb, label: string, extra = false) => (
    <button
      type="button"
      data-image-layer-verb={v}
      disabled={disabled || extra}
      onClick={() => onVerb(v)}
      style={small}
    >
      {label}
    </button>
  );
  const edge = (e: AlignEdge, label: string, glyph: string) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-image-layer-align={e}
      disabled={disabled}
      onClick={() => onAlign(e)}
      style={{ ...small, minWidth: 22 }}
    >
      {glyph}
    </button>
  );
  return (
    <div data-image-layer-verbs>
      <div style={{ ...row, gap: 4, flexWrap: "wrap" }}>
        <select
          aria-label={t(M.newFill)}
          data-image-new-fill
          value=""
          disabled={disabled || !gpu}
          onChange={(e) => {
            if (e.target.value) onNewFill(e.target.value as FillKind);
          }}
          style={small}
        >
          <option value="">{t(M.newFill)}</option>
          <option value="solid">{t(M.solid)}</option>
          <option value="gradient">{t(M.gradient)}</option>
          <option value="pattern">{t(M.pattern)}</option>
        </select>
        <select
          aria-label={t(M.newAdjustment)}
          data-image-new-adjustment
          value=""
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value)
              onNewAdjustment(e.target.value as AdjustmentKind);
          }}
          style={small}
        >
          <option value="">{t(M.newAdjustment)}</option>
          {ADJUSTMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {adjustmentKindLabel(k)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ ...row, gap: 4, flexWrap: "wrap" }}>
        {verb("mergeDown", t(M.mergeDown), !gpu)}
        {verb("mergeVisible", t(M.mergeVisible), !gpu)}
        {verb("stampVisible", t(M.stampVisible), !gpu)}
        {verb("flatten", t(M.flatten), !gpu)}
        {verb("mergeGroup", t(M.mergeGroup), !gpu || !inGroup)}
        {verb("viaCopy", t(M.viaCopy), !hasSelection)}
        {verb("viaCut", t(M.viaCut), !hasSelection)}
      </div>
      <div style={{ ...row, gap: 4, flexWrap: "wrap" }}>
        <span style={small}>{t(M.align)}</span>
        {edge("left", t(M.alignLeft), "⇤")}
        {edge("hcenter", t(M.alignHCenter), "↔")}
        {edge("right", t(M.alignRight), "⇥")}
        {edge("top", t(M.alignTop), "⤒")}
        {edge("vcenter", t(M.alignVCenter), "↕")}
        {edge("bottom", t(M.alignBottom), "⤓")}
        <button
          type="button"
          title={t(M.distributeH)}
          aria-label={t(M.distributeH)}
          data-image-layer-distribute="horizontal"
          disabled={disabled}
          onClick={() => onDistribute("horizontal")}
          style={small}
        >
          ⋯
        </button>
        <button
          type="button"
          title={t(M.distributeV)}
          aria-label={t(M.distributeV)}
          data-image-layer-distribute="vertical"
          disabled={disabled}
          onClick={() => onDistribute("vertical")}
          style={small}
        >
          ⋮
        </button>
        <select
          aria-label={t(M.alignTo)}
          data-image-layer-align-to
          value={alignTo}
          disabled={disabled}
          onChange={(e) => onAlignTo(e.target.value as AlignTo)}
          style={small}
        >
          <option value="canvas">{t(M.toCanvas)}</option>
          <option value="selection">{t(M.toSelection)}</option>
          <option value="layers">{t(M.toLayers)}</option>
        </select>
      </div>
      <div style={note}>{t(M.alignNote)}</div>
    </div>
  );
}

// ───────────────────────────── properties ─────────────────────────────

/** One labelled numeric slider over `values[at]`. */
function Field({
  label,
  values,
  at,
  min,
  max,
  step,
  disabled,
  onValues,
}: {
  label: string;
  values: readonly number[];
  at: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onValues: (v: number[]) => void;
}) {
  const v = values[at] ?? 0;
  const set = (x: number) => {
    const next = values.slice();
    next[at] = Math.min(max, Math.max(min, x));
    onValues(next);
  };
  return (
    <div style={{ ...row, gap: 4 }} data-image-prop-field={at}>
      <label style={{ ...small, flex: 1 }}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => set(Number(e.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(v.toFixed(3))}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => set(Number(e.target.value))}
        style={numberStyle}
      />
    </div>
  );
}

function Toggle({
  label,
  values,
  at,
  disabled,
  onValues,
}: {
  label: string;
  values: readonly number[];
  at: number;
  disabled: boolean;
  onValues: (v: number[]) => void;
}) {
  return (
    <label style={{ ...row, ...small, justifyContent: "flex-start", gap: 6 }}>
      <input
        type="checkbox"
        checked={(values[at] ?? 0) >= 0.5}
        disabled={disabled}
        data-image-prop-toggle={at}
        onChange={(e) => {
          const next = values.slice();
          next[at] = e.target.checked ? 1 : 0;
          onValues(next);
        }}
      />
      {label}
    </label>
  );
}

const hex = (r: number, g: number, b: number) => rgbToHex([r, g, b]);

const rgbOf = (h: string): [number, number, number] => hexToRgb(h) ?? [0, 0, 0];

/** A colour well over `values[at..at+3]` (0–255). */
function ColorWell({
  label,
  values,
  at,
  disabled,
  onValues,
}: {
  label: string;
  values: readonly number[];
  at: number;
  disabled: boolean;
  onValues: (v: number[]) => void;
}) {
  return (
    <div style={{ ...row, gap: 4 }}>
      <label style={{ ...small, flex: 1 }}>{label}</label>
      <input
        type="color"
        aria-label={label}
        data-image-prop-color={at}
        disabled={disabled}
        value={hex(values[at] ?? 0, values[at + 1] ?? 0, values[at + 2] ?? 0)}
        onChange={(e) => {
          const next = values.slice();
          const [r, g, b] = rgbOf(e.target.value);
          next[at] = r;
          next[at + 1] = g;
          next[at + 2] = b;
          onValues(next);
        }}
      />
    </div>
  );
}

/** A tab-like picker of which part of the block is being edited. */
/** THE DEVELOP PANEL (WP5.2): a Develop layer's 61 settings by section
 *  (Basic, Presence, HSL by range, Colour grading by wheel, Tone curve,
 *  Detail), the same schema the Filter ▸ Develop… dialog draws. */
function DevelopFields({
  values,
  disabled,
  onValues,
}: {
  values: readonly number[];
  disabled: boolean;
  onValues: (v: number[]) => void;
}) {
  const [section, setSection] = useState(0);
  const [sub, setSub] = useState(0);
  const sections = DEVELOP_SECTIONS;
  const name = sections[Math.min(section, sections.length - 1)]!;
  const inSection = DEVELOP_SETTINGS.map((x, at) => ({ x, at })).filter(
    ({ x }) => x.section === name,
  );
  const groups = [
    ...new Set(inSection.map(({ x }) => x.group).filter((g) => g)),
  ] as string[];
  const group = groups.length > 1 ? groups[Math.min(sub, groups.length - 1)] : null;
  const full =
    values.length === DEVELOP_SETTINGS.length ? values : developDefaults();
  return (
    <div data-image-develop>
      <PartPicker
        label={t(D.develop)}
        parts={sections.map((x) => t(x))}
        value={Math.min(section, sections.length - 1)}
        onPick={(i) => {
          setSection(i);
          setSub(0);
        }}
        testAttr="data-image-develop-section"
      />
      {group !== null && (
        <PartPicker
          label={t(name)}
          parts={groups.map((g) => t(g))}
          value={Math.min(sub, groups.length - 1)}
          onPick={setSub}
          testAttr="data-image-develop-group"
        />
      )}
      {inSection
        .filter(({ x }) => group === null || x.group === group)
        .map(({ x, at }) => (
          <Field
            key={at}
            label={x.group && group === null ? `${t(x.group)} ${t(x.label)}` : t(x.label)}
            values={full}
            at={at}
            min={x.min}
            max={x.max}
            step={x.step}
            disabled={disabled}
            onValues={onValues}
          />
        ))}
      <button
        type="button"
        data-image-develop-reset
        disabled={disabled}
        onClick={() => onValues(developDefaults())}
      >
        {t(D.reset)}
      </button>
    </div>
  );
}

function PartPicker({
  label,
  parts,
  value,
  onPick,
  testAttr,
}: {
  label: string;
  parts: string[];
  value: number;
  onPick: (i: number) => void;
  testAttr: string;
}) {
  return (
    <div style={{ ...row, gap: 4 }}>
      <label style={small}>{label}</label>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onPick(Number(e.target.value))}
        style={small}
        {...{ [testAttr]: "" }}
      >
        {parts.map((p, i) => (
          <option key={p} value={i}>
            {p}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Colour stops `values[from..]` as `n, n × (at, r, g, b)` (`at` 0–1). */
function StopsEditor({
  values,
  from,
  disabled,
  onValues,
}: {
  values: readonly number[];
  from: number;
  disabled: boolean;
  onValues: (v: number[]) => void;
}) {
  const n = values[from] ?? 0;
  const stops = Array.from({ length: n }, (_, k) => ({
    at: values[from + 1 + k * 4] ?? 0,
    rgb: [
      values[from + 2 + k * 4] ?? 0,
      values[from + 3 + k * 4] ?? 0,
      values[from + 4 + k * 4] ?? 0,
    ] as [number, number, number],
  }));
  const write = (next: typeof stops) => {
    const head = values.slice(0, from);
    onValues([...head, next.length, ...next.flatMap((s) => [s.at, ...s.rgb])]);
  };
  return (
    <div data-image-prop-stops>
      <div style={{ ...small, marginTop: space[1] }}>{t(M.stops)}</div>
      {stops.map((s, k) => (
        <div key={k} style={{ ...row, gap: 4 }} data-image-prop-stop={k}>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            aria-label={t(M.position)}
            value={Math.round(s.at * 100)}
            disabled={disabled}
            onChange={(e) => {
              const next = stops.slice();
              next[k] = {
                ...s,
                at: Math.min(100, Math.max(0, Number(e.target.value))) / 100,
              };
              write(next);
            }}
            style={numberStyle}
          />
          <input
            type="color"
            aria-label={t(M.filterColour)}
            value={hex(...s.rgb)}
            disabled={disabled}
            onChange={(e) => {
              const next = stops.slice();
              next[k] = { ...s, rgb: rgbOf(e.target.value) };
              write(next);
            }}
          />
          <button
            type="button"
            disabled={disabled || stops.length <= 2}
            aria-label={t(M.removeStop)}
            data-image-prop-stop-remove={k}
            onClick={() => write(stops.filter((_, j) => j !== k))}
            style={small}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        data-image-prop-stop-add
        disabled={disabled || stops.length >= 16}
        onClick={() => {
          const last = stops[stops.length - 1];
          write([
            ...stops,
            { at: 0.5, rgb: last ? last.rgb : [128, 128, 128] },
          ]);
        }}
        style={small}
      >
        {t(M.addStop)}
      </button>
    </div>
  );
}

/** The four Curves channels `values` = per channel `n, n × (in, out)`. */
function CurvesPoints({
  values,
  channel,
  disabled,
  onValues,
}: {
  values: readonly number[];
  channel: number;
  disabled: boolean;
  onValues: (v: number[]) => void;
}) {
  const curves: Array<Array<[number, number]>> = [];
  let at = 0;
  for (let c = 0; c < 4; c++) {
    const n = values[at] ?? 0;
    at += 1;
    const pts: Array<[number, number]> = [];
    for (let k = 0; k < n; k++) {
      pts.push([values[at] ?? 0, values[at + 1] ?? 0]);
      at += 2;
    }
    curves.push(pts);
  }
  const write = (c: number, pts: Array<[number, number]>) => {
    const next = curves.slice();
    next[c] = pts;
    onValues(next.flatMap((p) => [p.length, ...p.flat()]));
  };
  const pts = curves[channel] ?? [];
  const shown: Array<[number, number]> =
    pts.length > 0
      ? pts
      : [
          [0, 0],
          [255, 255],
        ];
  return (
    <div data-image-prop-curve={channel}>
      <div style={{ ...small, marginTop: space[1] }}>{t(M.points)}</div>
      {shown.map(([i, o], k) => (
        <div key={k} style={{ ...row, gap: 4 }}>
          {[i, o].map((v, side) => (
            <input
              key={side}
              type="number"
              min={0}
              max={255}
              step={1}
              value={v}
              disabled={disabled}
              data-image-prop-curve-point={`${k}:${side}`}
              onChange={(e) => {
                const next = shown.map((p) => [p[0], p[1]] as [number, number]);
                next[k]![side] = Math.min(
                  255,
                  Math.max(0, Number(e.target.value)),
                );
                write(channel, next);
              }}
              style={numberStyle}
            />
          ))}
          <button
            type="button"
            aria-label={t(M.removePoint)}
            disabled={disabled || shown.length <= 2}
            onClick={() =>
              write(
                channel,
                shown.filter((_, j) => j !== k),
              )
            }
            style={small}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        data-image-prop-curve-add
        disabled={disabled || shown.length >= 16}
        onClick={() => {
          const next = [...shown, [128, 128] as [number, number]].sort(
            (a, b) => a[0] - b[0],
          );
          write(channel, next);
        }}
        style={small}
      >
        {t(M.addPoint)}
      </button>
    </div>
  );
}

const RANGES = () => [
  t(M.master),
  t(M.reds),
  t(M.yellows),
  t(M.greens),
  t(M.cyans),
  t(M.blues),
  t(M.magentas),
];

/** The Properties of the active layer when it is a typed adjustment or a
 *  fill layer: one form per kind, over the kind's flat block. */
export function LayerPropertiesSection({
  layer,
  params,
  disabled,
  onAdjust,
  onFill,
}: {
  layer: LayerInfo | null;
  params: LayerParams | null;
  disabled: boolean;
  /** A typed adjustment's new block (and a Color Lookup's cube/name). */
  onAdjust: (values: number[], cube?: number[], label?: string) => void;
  onFill: (kind: FillKind, values: number[]) => void;
}) {
  const [part, setPart] = useState(0);
  const [cubeError, setCubeError] = useState<string | null>(null);
  const body = () => {
    if (!layer || !params) return <div style={note}>{t(M.none)}</div>;
    const v = params.values;
    if (params.fill) {
      const kind = params.fill;
      const set = (next: number[]) => onFill(kind, next);
      if (kind === "solid")
        return (
          <ColorWell
            label={t(M.filterColour)}
            values={v}
            at={0}
            disabled={disabled}
            onValues={set}
          />
        );
      if (kind === "pattern")
        return (
          <>
            <div style={note}>
              {t(M.patternName, { name: params.name ?? "" })}
            </div>
            <Field
              label={t(M.scale)}
              values={v}
              at={0}
              min={1}
              max={1000}
              step={1}
              disabled={disabled}
              onValues={set}
            />
            <Field
              label={t(M.angleDeg)}
              values={v}
              at={1}
              min={-180}
              max={180}
              step={1}
              disabled={disabled}
              onValues={set}
            />
          </>
        );
      return (
        <>
          <div style={{ ...row, gap: 4 }}>
            <label style={small}>{t(M.style)}</label>
            <select
              aria-label={t(M.style)}
              data-image-prop-gradient-style
              value={v[0] ?? 0}
              disabled={disabled}
              onChange={(e) => {
                const next = v.slice();
                next[0] = Number(e.target.value);
                set(next);
              }}
              style={small}
            >
              {[M.linear, M.radial, M.angle, M.reflected, M.diamond].map(
                (m, i) => (
                  <option key={i} value={i}>
                    {t(m)}
                  </option>
                ),
              )}
            </select>
          </div>
          <Field
            label={t(M.angleDeg)}
            values={v}
            at={1}
            min={-180}
            max={180}
            step={1}
            disabled={disabled}
            onValues={set}
          />
          <Field
            label={t(M.scale)}
            values={v}
            at={2}
            min={10}
            max={150}
            step={1}
            disabled={disabled}
            onValues={set}
          />
          <Toggle
            label={t(M.reverse)}
            values={v}
            at={3}
            disabled={disabled}
            onValues={set}
          />
          <Field
            label={t(M.offsetX)}
            values={v}
            at={4}
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            onValues={set}
          />
          <Field
            label={t(M.offsetY)}
            values={v}
            at={5}
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            onValues={set}
          />
          <StopsEditor values={v} from={6} disabled={disabled} onValues={set} />
        </>
      );
    }
    const kind = params.adjustment;
    if (!kind || kind === "chain") return <div style={note}>{t(M.chain)}</div>;
    const set = (next: number[]) => onAdjust(next);
    const f = (
      label: string,
      at: number,
      min: number,
      max: number,
      step = 1,
    ) => (
      <Field
        key={at}
        label={label}
        values={v}
        at={at}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValues={set}
      />
    );
    switch (kind) {
      case "brightnessContrast":
        return (
          <>
            {f(t(M.brightness), 0, -150, 150)}
            {f(t(M.contrast), 1, -50, 100)}
          </>
        );
      case "levels": {
        const c = Math.min(part, 3);
        return (
          <>
            <PartPicker
              label={t(M.channel)}
              parts={[t(M.composite), t(M.red), t(M.green), t(M.blue)]}
              value={c}
              onPick={setPart}
              testAttr="data-image-prop-part"
            />
            {f(t(M.inBlack), c * 5, 0, 253)}
            {f(t(M.inWhite), c * 5 + 1, 2, 255)}
            {f(t(M.gamma), c * 5 + 2, 0.1, 9.99, 0.01)}
            {f(t(M.outBlack), c * 5 + 3, 0, 255)}
            {f(t(M.outWhite), c * 5 + 4, 0, 255)}
          </>
        );
      }
      case "curves": {
        const c = Math.min(part, 3);
        return (
          <>
            <PartPicker
              label={t(M.channel)}
              parts={[t(M.composite), t(M.red), t(M.green), t(M.blue)]}
              value={c}
              onPick={setPart}
              testAttr="data-image-prop-part"
            />
            <CurvesPoints
              values={v}
              channel={c}
              disabled={disabled}
              onValues={set}
            />
          </>
        );
      }
      case "exposure":
        return (
          <>
            {f(t(M.exposure), 0, -5, 5, 0.01)}
            {f(t(M.offset), 1, -0.5, 0.5, 0.001)}
            {f(t(M.gamma), 2, 0.01, 9.99, 0.01)}
          </>
        );
      case "vibrance":
        return (
          <>
            {f(t(M.vibrance), 0, -100, 100)}
            {f(t(M.saturation), 1, -100, 100)}
          </>
        );
      case "hueSaturation": {
        const colorize = (v[0] ?? 0) >= 0.5;
        const r = Math.min(part, 6);
        const base = colorize ? 1 : r === 0 ? 4 : 7 + (r - 1) * 3;
        return (
          <>
            <Toggle
              label={t(M.colorize)}
              values={v}
              at={0}
              disabled={disabled}
              onValues={set}
            />
            {colorize ? null : (
              <PartPicker
                label={t(M.edit)}
                parts={RANGES()}
                value={r}
                onPick={setPart}
                testAttr="data-image-prop-part"
              />
            )}
            {f(t(M.hue), base, colorize ? 0 : -180, colorize ? 360 : 180)}
            {f(t(M.saturation), base + 1, colorize ? 0 : -100, 100)}
            {f(t(M.lightness), base + 2, -100, 100)}
          </>
        );
      }
      case "colorBalance": {
        const tone = Math.min(part, 2);
        return (
          <>
            <PartPicker
              label={t(M.tone)}
              parts={[t(M.shadows), t(M.midtones), t(M.highlights)]}
              value={tone}
              onPick={setPart}
              testAttr="data-image-prop-part"
            />
            {f(t(M.cyanRed), tone * 3, -100, 100)}
            {f(t(M.magentaGreen), tone * 3 + 1, -100, 100)}
            {f(t(M.yellowBlue), tone * 3 + 2, -100, 100)}
          </>
        );
      }
      case "blackWhite":
        return (
          <>
            {[M.reds, M.yellows, M.greens, M.cyans, M.blues, M.magentas].map(
              (m, i) => f(t(m), i, -200, 300),
            )}
          </>
        );
      case "photoFilter":
        return (
          <>
            <ColorWell
              label={t(M.filterColour)}
              values={v}
              at={0}
              disabled={disabled}
              onValues={set}
            />
            {f(t(M.density), 3, 0, 100)}
            <Toggle
              label={t(M.preserveLuminosity)}
              values={v}
              at={4}
              disabled={disabled}
              onValues={set}
            />
          </>
        );
      case "channelMixer": {
        const out = Math.min(part, 2);
        return (
          <>
            <PartPicker
              label={t(M.output)}
              parts={[t(M.red), t(M.green), t(M.blue)]}
              value={out}
              onPick={setPart}
              testAttr="data-image-prop-part"
            />
            {f(t(M.red), out * 4, -200, 200)}
            {f(t(M.green), out * 4 + 1, -200, 200)}
            {f(t(M.blue), out * 4 + 2, -200, 200)}
            {f(t(M.constant), out * 4 + 3, -200, 200)}
            <Toggle
              label={t(M.monochrome)}
              values={v}
              at={12}
              disabled={disabled}
              onValues={set}
            />
          </>
        );
      }
      case "posterize":
        return f(t(M.levels), 0, 2, 255);
      case "threshold":
        return f(t(M.threshold), 0, 1, 255);
      case "gradientMap":
        return (
          <>
            <Toggle
              label={t(M.reverse)}
              values={v}
              at={0}
              disabled={disabled}
              onValues={set}
            />
            <StopsEditor
              values={v}
              from={1}
              disabled={disabled}
              onValues={set}
            />
          </>
        );
      case "selectiveColor": {
        const r = Math.min(part, 8);
        const names = [
          M.reds,
          M.yellows,
          M.greens,
          M.cyans,
          M.blues,
          M.magentas,
          M.whites,
          M.neutrals,
          M.blacks,
        ].map((m) => t(m));
        return (
          <>
            <PartPicker
              label={t(M.channel)}
              parts={names}
              value={r}
              onPick={setPart}
              testAttr="data-image-prop-part"
            />
            {f(t(M.cyan), 1 + r * 4, -100, 100)}
            {f(t(M.magenta), 2 + r * 4, -100, 100)}
            {f(t(M.yellow), 3 + r * 4, -100, 100)}
            {f(t(M.black), 4 + r * 4, -100, 100)}
            <Toggle
              label={t(M.absolute)}
              values={v}
              at={0}
              disabled={disabled}
              onValues={set}
            />
          </>
        );
      }
      case "colorLookup":
        return (
          <>
            <div style={note} data-image-prop-look>
              {params.label ? t(M.look, { name: params.label }) : t(M.noLook)}
            </div>
            <label style={{ ...small, display: "block", marginTop: space[1] }}>
              {t(M.loadCube)}
              <input
                type="file"
                accept=".cube"
                data-image-prop-cube
                disabled={disabled}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void file.text().then((text) => {
                    try {
                      const cube = Array.from(toKernelCube(parseCube(text)));
                      setCubeError(null);
                      onAdjust([], cube, file.name.replace(/\.cube$/i, ""));
                    } catch (err) {
                      setCubeError(
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  });
                }}
              />
            </label>
            {cubeError ? <div style={note}>{cubeError}</div> : null}
          </>
        );
      case "invert":
        return (
          <div style={note}>
            {t(M.noSettings, { name: adjustmentKindLabel("invert") })}
          </div>
        );
      case "develop":
        return (
          <DevelopFields values={v} disabled={disabled} onValues={set} />
        );
    }
  };
  return (
    <div
      data-image-layer-properties
      data-kind={params?.adjustment ?? params?.fill ?? "none"}
    >
      <div style={sectionTitle}>
        {t(M.properties)}
        {layer ? ` — ${layer.name}` : ""}
      </div>
      {body()}
    </div>
  );
}

// ───────────────────────────── layer comps ─────────────────────────────

export function LayerCompsSection({
  comps,
  disabled,
  onNew,
  onApply,
  onUpdate,
  onDelete,
  onRename,
}: {
  comps: readonly LayerCompInfo[];
  disabled: boolean;
  onNew: (
    name: string,
    record: { visibility: boolean; position: boolean; appearance: boolean },
  ) => void;
  onApply: (id: number) => void;
  onUpdate: (id: number) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [record, setRecord] = useState({
    visibility: true,
    position: true,
    appearance: true,
  });
  const check = (key: keyof typeof record, label: string) => (
    <label style={{ ...small, display: "flex", gap: 4, alignItems: "center" }}>
      <input
        type="checkbox"
        checked={record[key]}
        data-image-comp-record={key}
        onChange={(e) => setRecord({ ...record, [key]: e.target.checked })}
      />
      {label}
    </label>
  );
  return (
    <div data-image-layer-comps>
      <div style={sectionTitle}>{t(M.comps)}</div>
      {comps.length === 0 ? (
        <div style={note}>{t(M.compsNone)}</div>
      ) : (
        comps.map((c) => (
          <div key={c.id} style={{ ...row, gap: 4 }} data-image-comp-row={c.id}>
            <input
              aria-label={t(M.compName)}
              value={c.name}
              disabled={disabled}
              data-image-comp-name={c.id}
              onChange={(e) => onRename(c.id, e.target.value)}
              style={{ ...small, flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              data-image-comp-apply={c.id}
              disabled={disabled}
              onClick={() => onApply(c.id)}
              style={small}
            >
              {t(M.apply)}
            </button>
            <button
              type="button"
              data-image-comp-update={c.id}
              disabled={disabled}
              onClick={() => onUpdate(c.id)}
              style={small}
            >
              {t(M.update)}
            </button>
            <button
              type="button"
              data-image-comp-delete={c.id}
              disabled={disabled}
              onClick={() => onDelete(c.id)}
              style={small}
            >
              {t(M.remove)}
            </button>
          </div>
        ))
      )}
      <div style={{ ...row, gap: 4, flexWrap: "wrap" }}>
        <input
          aria-label={t(M.compName)}
          placeholder={t(M.compName)}
          value={name}
          data-image-comp-new-name
          onChange={(e) => setName(e.target.value)}
          style={{ ...small, flex: 1, minWidth: 60 }}
        />
        {check("visibility", t(M.recordVisibility))}
        {check("position", t(M.recordPosition))}
        {check("appearance", t(M.recordAppearance))}
        <button
          type="button"
          data-image-comp-new
          disabled={disabled}
          onClick={() => {
            onNew(name, record);
            setName("");
          }}
          style={small}
        >
          {t(M.newComp)}
        </button>
      </div>
      <About>
        <p>{t(M.compsNote)}</p>
      </About>
    </div>
  );
}

// ───────────────────────── blending options dialog ─────────────────────────

const OPEN: number[] = [0, 0, 255, 255];

/** The 32 Blend If sliders of `layer` (all open when it has none). */
export function blendIfSliders(layer: LayerInfo): number[] {
  return (
    layer.blendIf ?? Array.from({ length: 4 }, () => [...OPEN, ...OPEN]).flat()
  );
}

export function BlendingOptionsDialog({
  layer,
  disabled,
  onFill,
  onKnockout,
  onBlendIf,
  onClose,
}: {
  layer: LayerInfo;
  disabled: boolean;
  onFill: (v: number) => void;
  onKnockout: (k: Knockout) => void;
  onBlendIf: (sliders: number[] | null) => void;
  onClose: () => void;
}) {
  const [channel, setChannel] = useState(0);
  const sliders = blendIfSliders(layer);
  const set = (side: 0 | 1, k: number, value: number) => {
    const next = sliders.slice();
    const at = channel * 8 + side * 4 + k;
    next[at] = Math.round(Math.min(255, Math.max(0, value)));
    // A split slider's halves stay in order: moving one half past the
    // other drags it along.
    const base = channel * 8 + side * 4;
    const [b0, b1, w0, w1] = next.slice(base, base + 4) as [
      number,
      number,
      number,
      number,
    ];
    const pair =
      k === 0
        ? [b0, Math.max(b0, b1), w0, w1]
        : k === 1
          ? [Math.min(b0, b1), b1, w0, w1]
          : k === 2
            ? [b0, b1, w0, Math.max(w0, w1)]
            : [b0, b1, Math.min(w0, w1), w1];
    next.splice(base, 4, ...pair);
    onBlendIf(next);
  };
  const side = (s: 0 | 1, label: string) => (
    <div data-image-blend-if-side={s === 0 ? "this" : "under"}>
      <div style={small}>{label}</div>
      <div style={{ ...row, gap: 4 }}>
        {[M.blackLow, M.blackHigh, M.whiteLow, M.whiteHigh].map((m, k) => (
          <label
            key={k}
            style={{ ...small, display: "flex", flexDirection: "column" }}
          >
            {t(m)}
            <input
              type="number"
              min={0}
              max={255}
              step={1}
              value={sliders[channel * 8 + s * 4 + k] ?? 0}
              disabled={disabled}
              data-image-blend-if-slider={`${s}:${k}`}
              onChange={(e) => set(s, k, Number(e.target.value))}
              style={numberStyle}
            />
          </label>
        ))}
      </div>
    </div>
  );
  return (
    <div
      data-image-blending-options
      role="dialog"
      aria-label={t(M.dialogTitle, { name: layer.name })}
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: 4,
        padding: space[2],
        margin: `${space[2]} 0`,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: space[1] }}>
        {t(M.dialogTitle, { name: layer.name })}
      </div>
      <div style={sectionTitle}>{t(M.advanced)}</div>
      <div style={{ ...row, gap: 4 }}>
        <label style={small} htmlFor="pg-image-bo-fill">
          {t(M.fill)}
        </label>
        <input
          id="pg-image-bo-fill"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={layer.fillOpacity}
          disabled={disabled}
          data-image-blending-fill
          onChange={(e) => onFill(Number(e.target.value))}
        />
        <span style={{ ...mono, ...small }}>
          {Math.round(layer.fillOpacity * 100)}%
        </span>
      </div>
      <div style={{ ...row, gap: 4 }}>
        <label style={small} htmlFor="pg-image-bo-knockout">
          {t(M.knockout)}
        </label>
        <select
          id="pg-image-bo-knockout"
          value={layer.knockout}
          disabled={disabled || layer.kind === "adjustment"}
          data-image-blending-knockout
          onChange={(e) => onKnockout(e.target.value as Knockout)}
          style={small}
        >
          <option value="none">{t(M.knockoutNone)}</option>
          <option value="shallow">{t(M.knockoutShallow)}</option>
          <option value="deep">{t(M.knockoutDeep)}</option>
        </select>
      </div>
      <div style={sectionTitle}>{t(M.blendIf)}</div>
      <PartPicker
        label={t(M.channel)}
        parts={[t(M.gray), t(M.red), t(M.green), t(M.blue)]}
        value={channel}
        onPick={setChannel}
        testAttr="data-image-blend-if-channel"
      />
      {side(0, t(M.thisLayer))}
      {side(1, t(M.underlying))}
      <div style={{ ...row, gap: 4, justifyContent: "flex-end" }}>
        <button
          type="button"
          data-image-blend-if-reset
          disabled={disabled || layer.blendIf === null}
          onClick={() => onBlendIf(null)}
          style={small}
        >
          {t(M.resetBlendIf)}
        </button>
        <button
          type="button"
          data-image-blending-close
          onClick={onClose}
          style={small}
        >
          {t(M.close)}
        </button>
      </div>
      <div style={note}>{t(M.blendNote)}</div>
    </div>
  );
}
