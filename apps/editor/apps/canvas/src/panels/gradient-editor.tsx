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

// Concept 2 — the gradient EDITOR (expert leaf under the Gradients
// panel's composition apply-picker). Reads stop detail through
// protocol 25's `gradientDetail` (stops as swatch REFS + resolved
// hex + midpoints), edits locally (drag thumbs/midpoints, add/
// remove stops, change a stop's colour, the type, reverse),
// and commits the WHOLE gradient as one `editGradient` mutation.
// Angle stays per-frame (`frameGradientFillAngle` via the Gradient tool /
// selection property), not part of the gradient resource.
//
// Paint model v2 (engine ADR 1007):
//   · each stop has an OPACITY (slider + field), committed as the stop's
//     `opacityPct` (100 is opaque and written as absent);
//   · a stop's colour is a SWATCH (IDML's form, and the default) or an
//     INLINE colour picked here, which no swatch holds (`color`);
//   · the type is Linear, Radial or Conic;
//   · "Apply to" puts the gradient on the selection's FILL or STROKE
//     (`frameFillColor` / `frameStrokeColor`), and for the stroke picks how
//     it maps: Within (InDesign's), Along the path or Across the stroke
//     (`frameGradientStrokeMode`). Each is one object-model write — one
//     batch over a multi-selection, one undo step.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  GradientRamp,
  Icon,
  useCanvasClient,
  useObjectBindings,
  type ObjectField,
  type RampStop,
} from "@paged-media/shell";
import { IconButton, Segment } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";
import { KitSelect } from "@paged-media/ui";
import type {
  GradientDetail,
  GradientSummary,
  SwatchSummary,
  Value,
} from "@paged-media/client";

const M = defineMessages("app.gradientEditor", {
  empty: "No gradients in this document.",
  gradient: "Gradient",
  linear: "Linear",
  radial: "Radial",
  conic: "Conic",
  reverseGradient: "Reverse gradient",
  reverse: "Reverse",
  stops: "Stops",
  stopColour: "Stop {n} colour",
  stopLocation: "Stop {n} location (%)",
  stopOpacity: "Stop {n} opacity (%)",
  stopOpacitySlider: "Stop {n} opacity",
  stopInlineColour: "Stop {n} inline colour",
  inlineColour: "Inline colour…",
  removeStopN: "Remove stop {n}",
  keepsTwo: "A gradient keeps ≥2 stops",
  removeStop: "Remove stop",
  applyTo: "Apply to",
  fill: "Fill",
  stroke: "Stroke",
  apply: "Apply",
  applyHint: "Select an object to apply the gradient to",
  strokeMode: "Stroke gradient",
  within: "Within",
  along: "Along",
  across: "Across",
  withinHint: "Apply gradient within stroke",
  alongHint: "Apply gradient along stroke",
  acrossHint: "Apply gradient across stroke",
});

/** The sentinel `<option>` value that switches a stop to an inline colour. */
const INLINE = "__inline__";

const KINDS = [
  { kind: "linear", wire: "Linear", label: "linear" },
  { kind: "radial", wire: "Radial", label: "radial" },
  { kind: "conic", wire: "Conic", label: "conic" },
] as const;

const STROKE_MODES = [
  { value: "Within", label: "within", hint: "withinHint" },
  { value: "Along", label: "along", hint: "alongHint" },
  { value: "Across", label: "across", hint: "acrossHint" },
] as const;

/** Object-model bindings the apply row reads and writes (ADR 323). */
const APPLY_BINDINGS = {
  fill: { scope: "element" as const, path: "frameFillColor" },
  stroke: { scope: "element" as const, path: "frameStrokeColor" },
  strokeMode: { scope: "element" as const, path: "frameGradientStrokeMode" },
};

/** `#rrggbb` → its RGB 0..255 channels. */
function hexChannels(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function channelsHex([r, g, b]: readonly number[]): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r ?? 0)}${h(g ?? 0)}${h(b ?? 0)}`;
}

function wireKind(kind: string): string {
  return KINDS.find((k) => k.kind === kind)?.wire ?? "Linear";
}

/** One stop as `editGradient` takes it: the swatch or the inline colour,
 *  and the opacity only when it is less than opaque. */
function stopSpec(s: RampStop) {
  const opacity =
    s.opacityPct === null || s.opacityPct === undefined || s.opacityPct >= 100
      ? {}
      : { opacityPct: s.opacityPct };
  return {
    stopColor: s.color ? "" : s.stopColorRef,
    locationPct: s.locationPct,
    midpointPct: s.midpointPct,
    ...opacity,
    ...(s.color ? { color: s.color } : {}),
  };
}

export function GradientEditor() {
  const strings = useStrings();
  const client = useCanvasClient();
  const [gradients, setGradients] = useState<GradientSummary[]>([]);
  const [swatches, setSwatches] = useState<SwatchSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GradientDetail | null>(null);
  const [stops, setStops] = useState<RampStop[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [kind, setKind] = useState<string>("linear");
  const [target, setTarget] = useState<"fill" | "stroke">("fill");
  const bound = useObjectBindings(APPLY_BINDINGS);
  // Finding PN-160 (R15): the ramp follows the gradient when it changes
  // elsewhere (Gradient Options, a script, an undo). Each applied change
  // reloads the active gradient's stops, so the next commit starts from
  // the document's ramp, never a stale copy.
  const activeRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    activeRef.current = activeId;
  });

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const refreshLists = useCallback(() => {
    void client
      .collection<GradientSummary>("gradients")
      .then((g) => {
        setGradients([...g]);
        setActiveId((cur) => cur ?? g[0]?.selfId ?? null);
      })
      .catch(() => setGradients([]));
    void client
      .collection<SwatchSummary>("swatches")
      .then((s) => setSwatches([...s]))
      .catch(() => setSwatches([]));
  }, [client]);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const loadDetail = useCallback(
    (id: string | null) => {
      if (!id) {
        setDetail(null);
        setStops([]);
        return;
      }
      void client
        .gradientDetail(id)
        .then((d) => {
          setDetail(d);
          setStops(
            d?.stops.map((s) => ({
              stopColorRef: s.stopColorRef,
              resolvedRgbHex: s.resolvedRgbHex,
              locationPct: s.locationPct,
              midpointPct: s.midpointPct ?? null,
              opacityPct: s.opacityPct ?? null,
              color: s.color ?? null,
            })) ?? [],
          );
          setKind(d?.kind ?? "linear");
          const count = d?.stops.length ?? 0;
          setSelected((cur) => (cur !== null && cur < count ? cur : null));
        })
        .catch(() => setDetail(null));
    },
    [client],
  );

  useEffect(() => {
    refreshLists();
    const off = client.subscribe((msg) => {
      if (msg.kind === "documentLoaded") {
        setActiveId(null);
        setSelected(null);
        refreshLists();
      }
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied"
      ) {
        refreshLists();
        if (activeRef.current) loadDetail(activeRef.current);
      }
    });
    return off;
  }, [client, refreshLists, loadDetail]);

  useEffect(() => loadDetail(activeId), [activeId, loadDetail]);

  // Commit the locally edited stop table as ONE editGradient.
  const commit = (nextStops: RampStop[], nextKind: string) => {
    if (!detail) return;
    void client
      .mutate({
        op: "editGradient",
        args: {
          gradientId: detail.selfId,
          spec: {
            selfId: detail.selfId,
            name: detail.name,
            kind: wireKind(nextKind),
            stops: [...nextStops]
              .sort((a, b) => a.locationPct - b.locationPct)
              .map(stopSpec),
          },
        },
      })
      .catch(() => {});
  };

  const moveStop = (i: number, pct: number) =>
    setStops((prev) =>
      prev.map((s, j) => (j === i ? { ...s, locationPct: pct } : s)),
    );
  const moveMidpoint = (i: number, pct: number) =>
    setStops((prev) =>
      prev.map((s, j) => (j === i ? { ...s, midpointPct: pct } : s)),
    );
  const addStop = (pct: number) => {
    const from = stops[0];
    const next: RampStop = {
      stopColorRef: from?.stopColorRef ?? swatches[0]?.selfId ?? "Color/Black",
      resolvedRgbHex: from?.resolvedRgbHex ?? "#808080",
      locationPct: pct,
      midpointPct: null,
      opacityPct: null,
      color: from?.color ?? null,
    };
    const nextStops = [...stops, next];
    setStops(nextStops);
    commit(nextStops, kind);
  };
  const reverse = () => {
    const nextStops = stops.map((s) => ({
      ...s,
      locationPct: 100 - s.locationPct,
      midpointPct: s.midpointPct === null ? null : 100 - s.midpointPct,
    }));
    setStops(nextStops);
    commit(nextStops, kind);
  };
  const setType = (t: string) => {
    setKind(t);
    commit(stops, t);
  };

  if (gradients.length === 0) {
    return (
      <div
        className="text-xs text-muted-foreground px-1 pt-2"
        data-gradient-editor="empty"
      >
        {strings.t(M.empty)}
      </div>
    );
  }

  const replaceAt = (i: number, patch: Partial<RampStop>) => {
    const nextStops = stops.map((s, j) => (j === i ? { ...s, ...patch } : s));
    setStops(nextStops);
    commit(nextStops, kind);
  };
  // Per-row edits (the gallery stop rows): colour, opacity and position
  // per stop, committed as one editGradient like every other edit.
  const setStopSwatchAt = (i: number, ref: string) => {
    if (ref === INLINE) {
      // Start the inline colour from what the stop shows now.
      const hex = stops[i]?.resolvedRgbHex ?? "#808080";
      replaceAt(i, {
        color: { space: "RGB", value: hexChannels(hex) },
        resolvedRgbHex: hex,
      });
      return;
    }
    replaceAt(i, { stopColorRef: ref, color: null });
  };
  const setStopInlineAt = (i: number, hex: string) =>
    replaceAt(i, {
      color: { space: "RGB", value: hexChannels(hex) },
      resolvedRgbHex: hex,
    });
  const setStopOpacityAt = (i: number, pct: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    replaceAt(i, { opacityPct: clamped >= 100 ? null : clamped });
  };
  const setStopLocationAt = (i: number, pct: number) => {
    const clamped = Math.max(0, Math.min(100, pct));
    replaceAt(i, { locationPct: clamped });
  };
  const removeStopAt = (i: number) => {
    if (stops.length <= 2) return;
    const nextStops = stops.filter((_, j) => j !== i);
    setSelected(null);
    setStops(nextStops);
    commit(nextStops, kind);
  };

  const applyField: ObjectField = target === "fill" ? bound.fill : bound.stroke;
  const applyGradient = () => {
    if (!detail) return;
    applyField.onCommit?.({ type: "colorRef", value: detail.selfId } as Value);
  };
  const mode =
    bound.strokeMode.value?.type === "text"
      ? (bound.strokeMode.value.value as string) || "Within"
      : null;

  return (
    <div
      className="border-t border-input mt-2 pt-2 flex flex-col gap-2"
      data-gradient-editor="ready"
    >
      <KitSelect
        aria-label={strings.t(M.gradient)}
        data-gradient-select
        value={activeId ?? ""}
        onChange={(e) => {
          setSelected(null);
          setActiveId(e.target.value || null);
        }}
      >
        {gradients.map((g) => (
          <option key={g.selfId} value={g.selfId}>
            {g.name}
          </option>
        ))}
      </KitSelect>
      <div className="flex items-center gap-2">
        {/* Gallery type segments + the reverse icon button. */}
        <div
          className="inline-flex flex-1 overflow-hidden rounded-[6px] border border-input"
          role="group"
          data-gradient-type
        >
          {KINDS.map((k, i) => {
            const active = kind === k.kind;
            return (
              <Segment
                key={k.kind}
                pressed={active}
                data-gradient-kind={k.kind}
                onClick={() => setType(k.kind)}
                className="flex-1 text-xs h-[27px] border-0 cursor-pointer"
                style={{
                  borderRight:
                    i < KINDS.length - 1
                      ? "1px solid var(--pg-border)"
                      : "none",
                  background: active
                    ? "var(--chrome-slot-active)"
                    : "var(--pg-bg)",
                  color: active
                    ? "var(--chrome-icon-active)"
                    : "var(--pg-muted-fg)",
                }}
              >
                {strings.t(M[k.label])}
              </Segment>
            );
          })}
        </div>
        <IconButton
          label={strings.t(M.reverseGradient)}
          className="w-[30px] h-[29px] rounded-[6px] border border-input bg-background text-muted-foreground hover:text-foreground flex items-center justify-center"
          data-action="reverse-gradient"
          title={strings.t(M.reverse)}
          onClick={reverse}
        >
          <Icon name="ui-return" size={14} />
        </IconButton>
      </div>

      <GradientRamp
        stops={stops}
        stopName={(ref) => swatches.find((w) => w.selfId === ref)?.name}
        kind={kind}
        selectedIndex={selected}
        onSelectStop={setSelected}
        onMoveStop={moveStop}
        onMoveMidpoint={moveMidpoint}
        onAddStop={addStop}
        onCommit={() => commit(stops, kind)}
      />

      {/* The gallery STOPS rows — chip · colour · position %, then the
          stop's opacity (slider + %). */}
      <div className="pg-label">{strings.t(M.stops)}</div>
      <div className="flex flex-col gap-1" data-gradient-stop-rows>
        {stops.map((s, i) => {
          const opacity = s.opacityPct ?? 100;
          return (
            <div
              key={`${s.stopColorRef}-${i}`}
              className="flex flex-col gap-1"
              data-gradient-stop-row={i}
              data-selected={selected === i ? "true" : undefined}
              data-inline={s.color ? "true" : undefined}
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-[18px] h-[18px] rounded-[5px] border border-input shrink-0"
                  style={{
                    background: s.resolvedRgbHex,
                    opacity: opacity / 100,
                  }}
                  title={s.resolvedRgbHex}
                />
                <select
                  aria-label={strings.t(M.stopColour, { n: i + 1 })}
                  className="flex-1 min-w-0 text-xs h-[26px] px-1 rounded-[6px] border border-input bg-background"
                  data-action="stop-swatch"
                  value={s.color ? INLINE : s.stopColorRef}
                  onChange={(e) => setStopSwatchAt(i, e.target.value)}
                >
                  {swatches.map((sw) => (
                    <option key={sw.selfId} value={sw.selfId}>
                      {sw.name}
                    </option>
                  ))}
                  <option value={INLINE}>{strings.t(M.inlineColour)}</option>
                </select>
                {s.color ? (
                  <input
                    type="color"
                    aria-label={strings.t(M.stopInlineColour, { n: i + 1 })}
                    data-stop-inline-colour
                    className="w-[26px] h-[26px] p-0 rounded-[6px] border border-input bg-background"
                    value={channelsHex(s.color.value)}
                    onChange={(e) => setStopInlineAt(i, e.target.value)}
                  />
                ) : null}
                <input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={Math.round(s.locationPct)}
                  key={`loc-${i}-${Math.round(s.locationPct)}`}
                  aria-label={strings.t(M.stopLocation, { n: i + 1 })}
                  data-stop-location
                  className="w-[52px] text-xs h-[26px] px-1 text-center rounded-[6px] border border-input bg-background pg-value"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setStopLocationAt(
                        i,
                        Number.parseFloat(
                          (e.target as HTMLInputElement).value,
                        ) || 0,
                      );
                    }
                  }}
                  onBlur={(e) => {
                    const v = Number.parseFloat(e.target.value);
                    if (Number.isFinite(v) && Math.round(s.locationPct) !== v) {
                      setStopLocationAt(i, v);
                    }
                  }}
                />
                <IconButton
                  label={strings.t(M.removeStopN, { n: i + 1 })}
                  className="w-[22px] h-[22px] rounded border-0 bg-transparent text-muted-foreground hover:text-foreground disabled:opacity-40"
                  data-action="remove-stop"
                  title={
                    stops.length <= 2
                      ? strings.t(M.keepsTwo)
                      : strings.t(M.removeStop)
                  }
                  disabled={stops.length <= 2}
                  onClick={() => removeStopAt(i)}
                >
                  ✕
                </IconButton>
              </div>
              <div className="flex items-center gap-2 pl-[26px]">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  defaultValue={opacity}
                  key={`opr-${i}-${opacity}`}
                  aria-label={strings.t(M.stopOpacitySlider, { n: i + 1 })}
                  data-stop-opacity-slider
                  className="flex-1 min-w-0"
                  // A drag commits once, on release: one undo step.
                  onPointerUp={(e) =>
                    setStopOpacityAt(
                      i,
                      Number((e.target as HTMLInputElement).value),
                    )
                  }
                  onKeyUp={(e) =>
                    setStopOpacityAt(
                      i,
                      Number((e.target as HTMLInputElement).value),
                    )
                  }
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={opacity}
                  key={`op-${i}-${opacity}`}
                  aria-label={strings.t(M.stopOpacity, { n: i + 1 })}
                  data-stop-opacity
                  className="w-[52px] text-xs h-[26px] px-1 text-center rounded-[6px] border border-input bg-background pg-value"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const v = Number.parseFloat(
                        (e.target as HTMLInputElement).value,
                      );
                      if (Number.isFinite(v)) setStopOpacityAt(i, v);
                    }
                  }}
                  onBlur={(e) => {
                    const v = Number.parseFloat(e.target.value);
                    if (Number.isFinite(v) && Math.round(opacity) !== v) {
                      setStopOpacityAt(i, v);
                    }
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Apply to: the selection's fill or stroke, and the stroke's
          mapping. */}
      <div className="pg-label">{strings.t(M.applyTo)}</div>
      <div className="flex items-center gap-2" data-gradient-apply>
        <div
          className="inline-flex flex-1 overflow-hidden rounded-[6px] border border-input"
          role="group"
          aria-label={strings.t(M.applyTo)}
        >
          {(["fill", "stroke"] as const).map((t, i) => {
            const active = target === t;
            return (
              <Segment
                key={t}
                pressed={active}
                data-gradient-target={t}
                onClick={() => setTarget(t)}
                className="flex-1 text-xs h-[27px] border-0 cursor-pointer"
                style={{
                  borderRight: i === 0 ? "1px solid var(--pg-border)" : "none",
                  background: active
                    ? "var(--chrome-slot-active)"
                    : "var(--pg-bg)",
                  color: active
                    ? "var(--chrome-icon-active)"
                    : "var(--pg-muted-fg)",
                }}
              >
                {strings.t(M[t])}
              </Segment>
            );
          })}
        </div>
        <button
          type="button"
          data-action="apply-gradient"
          disabled={!detail || applyField.onCommit == null}
          title={
            applyField.onCommit == null ? strings.t(M.applyHint) : undefined
          }
          onClick={applyGradient}
          className="h-[27px] rounded-[6px] border border-input px-2 text-[11px] disabled:opacity-55"
        >
          {strings.t(M.apply)}
        </button>
      </div>
      {target === "stroke" ? (
        <StrokeModeRow field={bound.strokeMode} mode={mode} />
      ) : null}
    </div>
  );
}

/** Within / Along / Across — `frameGradientStrokeMode` on the selection.
 *  A mixed selection presses none; no selection disables all three. */
function StrokeModeRow({
  field,
  mode,
}: {
  field: ObjectField;
  mode: string | null;
}) {
  const strings = useStrings();
  const inert = field.onCommit == null;
  return (
    <div
      className="flex items-center justify-between gap-2"
      data-gradient-stroke-mode-row=""
      data-mixed={mode === null ? "" : undefined}
    >
      <span className="text-xs" style={{ color: "var(--pg-fg)" }}>
        {strings.t(M.strokeMode)}
      </span>
      <div
        role="group"
        aria-label={strings.t(M.strokeMode)}
        className="inline-flex overflow-hidden rounded-[6px] border border-input"
        style={{ opacity: inert ? 0.55 : 1 }}
      >
        {STROKE_MODES.map((opt, i) => {
          const active = mode === opt.value;
          return (
            <Segment
              key={opt.value}
              pressed={active}
              disabled={inert}
              data-gradient-stroke-mode={opt.value}
              title={strings.t(M[opt.hint])}
              className="h-[26px] px-2 text-[11px] cursor-pointer border-0 disabled:cursor-default"
              style={{
                borderRight:
                  i < STROKE_MODES.length - 1
                    ? "1px solid var(--pg-border)"
                    : "none",
                background: active
                  ? "var(--chrome-slot-active)"
                  : "var(--pg-bg)",
                color: active
                  ? "var(--chrome-icon-active)"
                  : "var(--pg-muted-fg)",
              }}
              onClick={() => {
                if (active) return;
                field.onCommit?.({ type: "text", value: opt.value } as Value);
              }}
            >
              {strings.t(M[opt.label])}
            </Segment>
          );
        })}
      </div>
    </div>
  );
}
