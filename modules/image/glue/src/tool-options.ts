/**
 * TOOL OPTIONS in the host's tool-options bar: brush, pencil, eraser,
 * magic wand, paint bucket and gradient declare their fields, and the
 * values the host holds flow into the session (`tools.settings@1`).
 *
 * Declared only where the host can report the values back: a host
 * without the door would show controls that change nothing. The panel
 * keeps its own controls either way (the host offers no write-back, so
 * a change made in the panel is not reflected in the bar).
 */
import type { BundleHost, Disposable } from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import { GRADIENT_KINDS, type GradientKind } from "./engine";
import {
  ART_HISTORY_STYLES,
  COLOR_REPLACE_MODES,
  LIMITS_MODES,
  SAMPLING_MODES,
  SYMMETRY_KINDS,
  type PaintToolOptions,
} from "./brush-dynamics";
import { isSampleSize, SAMPLE_SIZES } from "./color-state";
import { gradientKindLabel } from "./words";
import type { ToolSettingValue } from "@paged-media/plugin-api";
import type { ImageSession } from "./session";

type ToolOptionField =
  | {
      kind: "number";
      key: string;
      label: string;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
    }
  | { kind: "toggle"; key: string; label: string }
  | {
      kind: "select";
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
    };

const pct = (key: string, label: string): ToolOptionField => ({
  kind: "number",
  key,
  label,
  min: 0,
  max: 100,
  step: 1,
  unit: "%",
});

const M = defineMessages("image.toolOptions", {
  sampleSize: "Sample size",
  pointSample: "Point sample",
  average: "{n} by {n} average",
  sample: "Sample",
  currentLayer: "Current layer",
  allLayers: "All layers",
  size: "Size",
  tolerance: "Tolerance",
  contiguous: "Contiguous",
  hardness: "Hardness",
  opacity: "Opacity",
  flow: "Flow",
  gradient: "Gradient",
  lockTransparent: "Lock transparent pixels",
  symmetry: "Symmetry",
  strength: "Strength",
  fingerPainting: "Finger painting",
  sampleAllLayers: "Sample all layers",
  wet: "Wet",
  load: "Load",
  mix: "Mix",
  loadAfter: "Load after each stroke",
  cleanAfter: "Clean after each stroke",
  historySource: "Source",
  historyOpen: "As opened",
  historyPrevious: "Before the last edit",
  style: "Style",
  area: "Area",
  sampling: "Sampling",
  limits: "Limits",
  protectForeground: "Protect foreground colour",
  mode: "Mode",
  antiAlias: "Anti-alias",
});

const size = (): ToolOptionField => ({
  kind: "number",
  key: "size",
  label: t(M.size),
  min: 1,
  max: 2000,
  step: 1,
  unit: "px",
});
const wand = (): ToolOptionField[] => [
  {
    kind: "number",
    key: "tolerance",
    label: t(M.tolerance),
    min: 0,
    max: 255,
    step: 1,
  },
  { kind: "toggle", key: "contiguous", label: t(M.contiguous) },
];

/** WP4.10 — the Eyedropper's and Color Sampler's sample size. */
const sampleSize = (): ToolOptionField => ({
  kind: "select",
  key: "sampleSize",
  label: t(M.sampleSize),
  options: SAMPLE_SIZES.map((n) => ({
    value: String(n),
    label: n === 1 ? t(M.pointSample) : t(M.average, { n }),
  })),
});

/** The paint tools the brush engine adds, by the session's option key. */
export type PaintToolKind = keyof PaintToolOptions;

const toggle = (key: string, label: string): ToolOptionField => ({
  kind: "toggle",
  key,
  label,
});
const choice = (
  key: string,
  label: string,
  values: readonly string[],
  labelOf: (v: string) => string = (v) => v,
): ToolOptionField => ({
  kind: "select",
  key,
  label,
  options: values.map((value) => ({ value, label: labelOf(value) })),
});

/** The fields of each brush-engine tool (size is the shared brush's). */
const smudgeFields = (): ToolOptionField[] => [
  size(),
  pct("strength", t(M.strength)),
  toggle("fingerPainting", t(M.fingerPainting)),
  toggle("sampleAll", t(M.sampleAllLayers)),
];

const mixerFields = (): ToolOptionField[] => [
  size(),
  pct("wet", t(M.wet)),
  pct("load", t(M.load)),
  pct("mix", t(M.mix)),
  pct("flow", t(M.flow)),
  toggle("loadAfter", t(M.loadAfter)),
  toggle("cleanAfter", t(M.cleanAfter)),
  toggle("sampleAll", t(M.sampleAllLayers)),
];

const historyFields = (): ToolOptionField[] => [
  size(),
  pct("opacity", t(M.opacity)),
  choice("source", t(M.historySource), ["open", "previous"], (v) =>
    t(v === "open" ? M.historyOpen : M.historyPrevious),
  ),
];

const artHistoryFields = (): ToolOptionField[] => [
  size(),
  choice("style", t(M.style), ART_HISTORY_STYLES),
  {
    kind: "number",
    key: "area",
    label: t(M.area),
    min: 0,
    max: 500,
    step: 1,
    unit: "px",
  },
  pct("tolerance", t(M.tolerance)),
];

const backgroundEraserFields = (): ToolOptionField[] => [
  size(),
  choice("sampling", t(M.sampling), SAMPLING_MODES),
  choice("limits", t(M.limits), LIMITS_MODES),
  pct("tolerance", t(M.tolerance)),
  toggle("protectForeground", t(M.protectForeground)),
];

const colorReplaceFields = (): ToolOptionField[] => [
  size(),
  choice("mode", t(M.mode), COLOR_REPLACE_MODES),
  choice("sampling", t(M.sampling), SAMPLING_MODES),
  choice("limits", t(M.limits), LIMITS_MODES),
  pct("tolerance", t(M.tolerance)),
];

const magicEraserFields = (): ToolOptionField[] => [
  {
    kind: "number",
    key: "tolerance",
    label: t(M.tolerance),
    min: 0,
    max: 255,
    step: 1,
  },
  toggle("antialias", t(M.antiAlias)),
  toggle("contiguous", t(M.contiguous)),
  toggle("sampleAll", t(M.sampleAllLayers)),
  pct("opacity", t(M.opacity)),
];

/** The fields each tool declares, by tool id, labelled in the editor's
 *  language at the time (the bundle declares them on activation). */
export function toolOptionFields(ids: {
  brush: string;
  pencil: string;
  eraser: string;
  wand: string;
  bucket: string;
  gradient: string;
  eyedropper?: string;
  colorSampler?: string;
  /** The brush engine's tools, by their option key. */
  paintTools?: Partial<Record<PaintToolKind, string>>;
}): Record<string, ToolOptionField[]> {
  const p = ids.paintTools ?? {};
  return {
    ...(p.smudge ? { [p.smudge]: smudgeFields() } : {}),
    ...(p.mixer ? { [p.mixer]: mixerFields() } : {}),
    ...(p.history ? { [p.history]: historyFields() } : {}),
    ...(p.artHistory ? { [p.artHistory]: artHistoryFields() } : {}),
    ...(p.backgroundEraser
      ? { [p.backgroundEraser]: backgroundEraserFields() }
      : {}),
    ...(p.colorReplace ? { [p.colorReplace]: colorReplaceFields() } : {}),
    ...(p.magicEraser ? { [p.magicEraser]: magicEraserFields() } : {}),
    ...(ids.eyedropper
      ? {
          [ids.eyedropper]: [
            sampleSize(),
            {
              kind: "select" as const,
              key: "sampleSource",
              label: t(M.sample),
              options: [
                { value: "layer", label: t(M.currentLayer) },
                { value: "all", label: t(M.allLayers) },
              ],
            },
          ],
        }
      : {}),
    ...(ids.colorSampler ? { [ids.colorSampler]: [sampleSize()] } : {}),
    [ids.brush]: [
      size(),
      pct("hardness", t(M.hardness)),
      pct("opacity", t(M.opacity)),
      pct("flow", t(M.flow)),
      toggle("lockAlpha", t(M.lockTransparent)),
      choice("symmetry", t(M.symmetry), SYMMETRY_KINDS),
    ],
    [ids.pencil]: [size(), pct("opacity", t(M.opacity))],
    [ids.eraser]: [
      size(),
      pct("hardness", t(M.hardness)),
      pct("opacity", t(M.opacity)),
    ],
    [ids.wand]: wand(),
    [ids.bucket]: wand(),
    [ids.gradient]: [
      {
        kind: "select",
        key: "kind",
        label: t(M.gradient),
        options: GRADIENT_KINDS.map((k) => ({
          value: k,
          label: gradientKindLabel(k),
        })),
      },
    ],
  };
}

/** Apply one tool's settings to the session (keys it does not know are
 *  ignored; a value of the wrong type is ignored, not coerced). */
export type ToolSettingsKind =
  "brush" | "wand" | "gradient" | "eyedropper" | { paint: PaintToolKind };

export function applyToolSettings(
  session: ImageSession,
  kind: ToolSettingsKind,
  v: Readonly<Record<string, ToolSettingValue>>,
): void {
  const num = (k: string) =>
    typeof v[k] === "number" ? (v[k] as number) : undefined;
  if (typeof kind === "object") {
    applyPaintToolSettings(session, kind.paint, v);
    return;
  }
  if (kind === "eyedropper") {
    const size = Number(v.sampleSize);
    const o: Parameters<ImageSession["setEyedropperOptions"]>[0] = {};
    if (isSampleSize(size)) o.size = size;
    if (v.sampleSource === "layer" || v.sampleSource === "all")
      o.source = v.sampleSource;
    if (Object.keys(o).length) session.setEyedropperOptions(o);
    return;
  }
  if (kind === "brush") {
    const p: Parameters<ImageSession["setBrushParams"]>[0] = {};
    if (num("size") !== undefined) p.size = Math.max(1, num("size")!);
    if (num("hardness") !== undefined) p.hardness = num("hardness")! / 100;
    if (num("opacity") !== undefined) p.opacity = num("opacity")! / 100;
    if (num("flow") !== undefined) p.flow = num("flow")! / 100;
    if (Object.keys(p).length) session.setBrushParams(p);
    const d = session.state?.().dynamics;
    if (!d) return;
    if (typeof v.lockAlpha === "boolean" && v.lockAlpha !== d.lockAlpha)
      session.setBrushDynamics({ lockAlpha: v.lockAlpha });
    if (
      typeof v.symmetry === "string" &&
      (SYMMETRY_KINDS as readonly string[]).includes(v.symmetry) &&
      v.symmetry !== d.symmetry.kind
    )
      session.setBrushDynamics({
        symmetry: { kind: v.symmetry as (typeof SYMMETRY_KINDS)[number] },
      });
  } else if (kind === "wand") {
    const o: Parameters<ImageSession["setWandOptions"]>[0] = {};
    if (num("tolerance") !== undefined) o.tolerance = num("tolerance")!;
    if (typeof v.contiguous === "boolean") o.contiguous = v.contiguous;
    if (Object.keys(o).length) session.setWandOptions(o);
  } else if (
    typeof v.kind === "string" &&
    (GRADIENT_KINDS as string[]).includes(v.kind)
  ) {
    session.setGradientKind(v.kind as GradientKind);
  }
}

/** A brush-engine tool's settings into the session: size goes to the
 *  shared brush, everything else to that tool's options (percentages as
 *  fractions; a select only takes one of its listed values). */
export function applyPaintToolSettings(
  session: ImageSession,
  kind: PaintToolKind,
  v: Readonly<Record<string, ToolSettingValue>>,
): void {
  const size = v.size;
  if (typeof size === "number" && kind !== "magicEraser")
    session.setBrushParams({ size: Math.max(1, size) });
  if (kind === "history" && typeof v.opacity === "number")
    session.setBrushParams({ opacity: v.opacity / 100 });
  const listed: Record<string, readonly string[]> = {
    source: ["open", "previous"],
    style: ART_HISTORY_STYLES,
    sampling: SAMPLING_MODES,
    limits: LIMITS_MODES,
    mode: COLOR_REPLACE_MODES,
  };
  const fractions = new Set([
    "strength",
    "wet",
    "load",
    "mix",
    "flow",
    "opacity",
  ]);
  const current = session.state().paintTools[kind] as unknown as Record<
    string,
    unknown
  >;
  const patch: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(v)) {
    if (!(k in current) || k === "size") continue;
    if (kind === "history" && k === "opacity") continue;
    const was = current[k];
    if (typeof was === "boolean" && typeof value === "boolean")
      patch[k] = value;
    else if (typeof was === "number" && typeof value === "number") {
      const scaled =
        k === "tolerance" && kind !== "magicEraser"
          ? value / 100
          : fractions.has(k)
            ? value / 100
            : value;
      patch[k] = scaled;
    } else if (
      typeof was === "string" &&
      typeof value === "string" &&
      listed[k]?.includes(value)
    )
      patch[k] = value;
  }
  if (Object.keys(patch).length)
    session.setPaintToolOptions(
      kind,
      patch as Partial<PaintToolOptions[typeof kind]>,
    );
}

/** Read each tool's current settings into the session and follow its
 *  changes. Null when the host cannot report them. */
export function bindToolSettings(
  host: BundleHost,
  session: ImageSession,
  tools: Record<string, ToolSettingsKind>,
): Disposable | null {
  if (!host.supports("tools.settings@1")) return null;
  const surface = host.tools;
  const subs = Object.entries(tools).map(([id, kind]) => {
    applyToolSettings(session, kind, surface.settings(id));
    return surface.onDidChangeSettings(id, (v) =>
      applyToolSettings(session, kind, v),
    );
  });
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
