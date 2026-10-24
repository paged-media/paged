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
}): Record<string, ToolOptionField[]> {
  return {
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
export function applyToolSettings(
  session: ImageSession,
  kind: "brush" | "wand" | "gradient" | "eyedropper",
  v: Readonly<Record<string, ToolSettingValue>>,
): void {
  const num = (k: string) =>
    typeof v[k] === "number" ? (v[k] as number) : undefined;
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

/** Read each tool's current settings into the session and follow its
 *  changes. Null when the host cannot report them. */
export function bindToolSettings(
  host: BundleHost,
  session: ImageSession,
  tools: Record<string, "brush" | "wand" | "gradient" | "eyedropper">,
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
