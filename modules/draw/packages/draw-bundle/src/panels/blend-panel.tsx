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

// The BLEND OPTIONS panel — §16.2's three spacing modes, the spine
// verbs, easing and independent colour acceleration, plus the two verbs
// that take a blend apart again. Every knob is a real `BlendParams`
// field the recipe persists, and the buttons drive the SAME appliers the
// commands do.
//
// THE "LIVE PREVIEW" the catalog row asks for, exactly as far as it
// goes: the panel previews the PLAN — the resolved intermediate count,
// where that count came from, and the spine's length — recomputed as you
// change the options. It does not re-render the artwork per keystroke,
// because that would be one document mutation, and one undo step, per
// keystroke. `BLEND_LIVE_NOTE` says so and its wording is pinned by a
// conformance test.
//
// An expert-leaf REACT panel for the B-01 reason: a list of records with
// per-row actions, plus enums and numerics, is above the v1 schema
// panel's scalar binding ceiling.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import type { EaseKind } from "@paged-media/draw-geometry";
import { EASE_KINDS } from "@paged-media/draw-geometry";
import * as React from "react";

import {
  applyExpandBlend,
  applyMakeBlend,
  applyReleaseBlend,
  applyReplaceBlendSpine,
  applyReverseBlendOrder,
  applyReverseBlendSpine,
  applySelectBlendObjects,
  applyUpdateBlend,
  blendLinks,
  blendStepCountFor,
  readBlendLibrary,
  resolveBlend,
  BLEND_DEFAULTS,
  BLEND_MAX_STEPS,
  BLEND_FEATURE,
  BLEND_ORIENTATIONS,
  BLEND_SPACINGS,
  type BlendOrientation,
  type BlendParams,
  type BlendRecord,
  type BlendSpacing,
} from "../commands/blend";
import { useFollowedDraft, usePanelReload } from "./use-panel-reload";
import {
  About,
  color,
  font,
  IconButton,
  Refusal,
  useActionFeedback,
} from "@paged-media/panel-kit";
import { PanelIntro, tokenLabel } from "./panel-parts";
import { defineMessages, t, useStrings } from "@paged-media/strings";

const M = defineMessages("draw.blendPanel", {
  summary:
    "Fill the space between two selected objects with intermediate shapes that change step by step in shape and colour.",
  note: "A blend makes real intermediate shapes and remembers how it built them. Editing a key object does not change the intermediates until you choose Update. The step count shown under Spacing is worked out from the settings; the artwork is only rebuilt when you build or update. The intermediates follow a straight line between the two objects unless you replace it with a path of your own (Spine): that path keeps its own colour and stays outside the blend's group, so you can still edit it. Reverse spine swaps which end each shape travels to; reverse front to back only changes which shapes paint on top. Building, updating, reversing, expanding and releasing are one undo step each; the saved settings are kept outside undo.",
  selectTwo: "Select two objects to blend",
  selectExactlyTwo: "Select exactly two objects to blend ({count} selected)",
  smoothColor: "Smooth colour",
  specifiedSteps: "Specified steps",
  specifiedDistance: "Specified distance",
  rowSteps: "{count} steps",
  rowEvery: "every {distance} pt",
  rowSmooth: "smooth colour",
  rowReplacedSpine: " · replaced spine",
  rowAligned: " · aligned",
  rowReversedSpine: " · reversed spine",
  rowReversedOrder: " · reversed order",
  rowPlaced:
    "({count, plural, one {# intermediate} other {# intermediates}} placed)",
  heading: "Blends",
  blendTwo: "Blend the two selected objects",
  plusBlend: "+ Blend",
  degraded:
    "This editor cannot save data into the document, so blend settings are not kept. A blend can still be expanded or released.",
  spacing: "Spacing",
  mode: "Mode",
  steps: "Steps",
  distance: "Distance (pt)",
  previewSteps:
    "{count, plural, one {# intermediate step.} other {# intermediate steps.}}",
  tooMany: "Too many steps: at most {max}.",
  measuredAlongSpine:
    "The step count is measured along the spine when you build.",
  fromColour:
    "The step count comes from the colour difference between the two objects when you build.",
  orientation: "Orientation",
  alignTo: "Align to",
  page: "Page",
  path: "Path",
  easing: "Easing",
  shape: "Shape",
  strength: "Strength (0 = none)",
  independentColour: "Independent colour acceleration",
  colour: "Colour",
  colourStrength: "Colour strength",
  spine: "Spine",
  reverseSpineCheck: "Reverse spine (the shapes swap ends)",
  reverseOrderCheck: "Reverse front to back (paint order only)",
  fitToArtboard: "Keep intermediates on the page",
  empty: "No blends yet. Select two objects and choose + Blend.",
  updateHint:
    "Rebuild with the settings above and the key objects' current shapes",
  update: "Update",
  spineHint: "Use the selected path (not part of this blend) as the spine",
  reverseSpine: "Reverse spine",
  reverseSpineHint: "Travel the spine the other way (geometry moves)",
  reverseOrder: "Reverse front to back",
  reverseOrderHint: "Flip paint order (nothing moves)",
  keysHint: "Select the key objects — edit them, then Update",
  keys: "Keys",
  expandHint: "Stop tracking and keep every intermediate as ordinary artwork",
  expand: "Expand",
  releaseHint: "Remove the intermediates and keep the key objects",
  release: "Release",
  title: "Blend options",
});

export const BLEND_PANEL_ID = "media.paged.draw.panel.blend";

/** What the panel is for, in one sentence (shown at the top). */
export const BLEND_SUMMARY = M.summary;

/** The "About" text. Exported so the conformance spec pins the wording. */
export const BLEND_PANEL_NOTE = M.note;

/** Why "+ Blend" is unavailable, or null when it is available. */
export function blendMakeBlocker(selected: number): string | null {
  if (selected === 2) return null;
  return selected === 0
    ? t(M.selectTwo)
    : t(M.selectExactlyTwo, { count: selected });
}

/** Human labels for the spacing modes. */
const SPACING_LABELS: Readonly<Record<BlendSpacing, string>> = {
  smoothColor: M.smoothColor,
  steps: M.specifiedSteps,
  distance: M.specifiedDistance,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: `12px ${font.sans}`,
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  padding: "0 3px",
  font: `12px ${font.sans}`,
  color: color.fg,
};
const sectionStyle: React.CSSProperties = {
  font: `11px ${font.sans}`,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  opacity: 0.65,
  paddingTop: 8,
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: `12px ${font.sans}`,
};
const inputStyle: React.CSSProperties = {
  width: 64,
  font: `12px ${font.sans}`,
};

/** The one-line summary a blend row shows. Pure — exported so the
 *  conformance spec pins the wording without a DOM. */
export function blendRowLabel(record: BlendRecord, placed: number): string {
  const p = record.params;
  const asked =
    p.spacing === "steps"
      ? t(M.rowSteps, { count: p.steps })
      : p.spacing === "distance"
        ? t(M.rowEvery, { distance: p.distancePt })
        : t(M.rowSmooth);
  return (
    `${asked}${record.spine ? t(M.rowReplacedSpine) : ""}` +
    `${p.orientation === "path" ? t(M.rowAligned) : ""}` +
    `${p.reverseSpine ? t(M.rowReversedSpine) : ""}` +
    `${p.reverseFrontToBack ? t(M.rowReversedOrder) : ""} ` +
    t(M.rowPlaced, { count: placed })
  );
}

export function makeBlendPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    const [records, setRecords] = React.useState<BlendRecord[]>([]);
    const [active, setActive] = React.useState<string | null>(null);
    const [placed, setPlaced] = React.useState<Record<string, number>>({});
    const [selected, setSelected] = React.useState(0);
    const [portable, setPortable] = React.useState(true);
    const [draft, setDraft, followDraft] =
      useFollowedDraft<BlendParams>(BLEND_DEFAULTS);

    // WHAT A RELOAD COSTS (`test/panels/blend-panel.dom.test.tsx`, and it may
    // only go down): the recipe part once, and the document's links once
    // per document REVISION — one unfiltered `blendLinks`, tallied for
    // every record at once, out of the walk every panel shares. It used
    // to walk the whole document once per RECORD, on every event.
    const reload = usePanelReload(
      host,
      "blend",
      async ({ live, selection }) => {
        const library = await readBlendLibrary(host);
        if (!live()) return;
        const id = await resolveBlend(host, undefined, library);
        if (!live()) return;
        const links = await blendLinks(host);
        if (!live()) return;
        const tally: Record<string, number> = {};
        for (const step of links.steps) {
          tally[step.ref.blend] = (tally[step.ref.blend] ?? 0) + 1;
        }
        // Everything is known; show it in one go, so the panel never
        // renders half of one reload and half of another.
        setPortable(host.supports(BLEND_FEATURE));
        setRecords(library.blends);
        setSelected(selection.length);
        setActive(id);
        setPlaced(tally);
        const saved = library.blends.find((r) => r.id === id);
        if (saved) followDraft(saved.id, saved.params);
      },
    );

    const { refusal, run } = useActionFeedback(host, reload, "draw panel");

    // The PLAN preview: the resolved count, its derivation, and the
    // spine length — the same pure function the commit uses, so what is
    // shown is what would be built. `null` colours are the honest input
    // here: the panel has no swatch resolution of its own, so a smooth
    // blend previews its FALLBACK and says so, which is exactly what
    // would happen if the fills turn out not to be readable.
    const preview = blendStepCountFor({
      params: draft,
      spineLength: 0,
      fromRgb: null,
      toRgb: null,
    });

    const numberRow = (
      label: string,
      value: number,
      onChange: (n: number) => void,
      attr: string,
      step = 1,
    ) => (
      <div style={rowStyle}>
        <span style={{ flex: 1 }}>{label}</span>
        <input
          type="number"
          step={step}
          style={inputStyle}
          data-draw-blend-field={attr}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    );

    const checkRow = (
      label: string,
      value: boolean,
      onChange: (b: boolean) => void,
      attr: string,
    ) => (
      <div style={rowStyle}>
        <label style={{ flex: 1 }} htmlFor={`draw-blend-${attr}`}>
          {label}
        </label>
        <input
          id={`draw-blend-${attr}`}
          type="checkbox"
          data-draw-blend-toggle={attr}
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
      </div>
    );

    return (
      <div
        style={{ padding: 12 }}
        data-draw-blend-panel={records.length}
        data-draw-blend-portable={portable ? "true" : "false"}
        data-draw-blend-active={active ?? ""}
      >
        <PanelIntro summary={s.t(BLEND_SUMMARY)} attr="data-draw-blend-intro" />
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <span style={{ ...sectionStyle, paddingTop: 0 }}>
            {s.t(M.heading)} ({records.length})
          </span>
          <button
            type="button"
            style={iconBtn}
            title={blendMakeBlocker(selected) ?? s.t(M.blendTwo)}
            data-draw-blend-make
            disabled={blendMakeBlocker(selected) !== null}
            onClick={() => void run(() => applyMakeBlend(host, { ...draft }))}
          >
            {s.t(M.plusBlend)}
          </button>
        </div>

        {blendMakeBlocker(selected) !== null && (
          <div style={mutedStyle} data-draw-blend-make-hint>
            {blendMakeBlocker(selected)}.
          </div>
        )}

        <Refusal text={refusal} />

        {!portable && (
          <div style={mutedStyle} data-draw-blend-degraded>
            {s.t(M.degraded)}
          </div>
        )}

        <div style={sectionStyle}>{s.t(M.spacing)}</div>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.mode)}</span>
          <select
            style={{ font: `12px ${font.sans}` }}
            data-draw-blend-spacing
            value={draft.spacing}
            onChange={(e) =>
              setDraft({ ...draft, spacing: e.target.value as BlendSpacing })
            }
          >
            {BLEND_SPACINGS.map((s) => (
              <option key={s} value={s}>
                {t(SPACING_LABELS[s])}
              </option>
            ))}
          </select>
        </div>
        {draft.spacing === "steps" &&
          numberRow(
            s.t(M.steps),
            draft.steps,
            (n) => setDraft({ ...draft, steps: n }),
            "steps",
          )}
        {draft.spacing === "distance" &&
          numberRow(
            s.t(M.distance),
            draft.distancePt,
            (n) => setDraft({ ...draft, distancePt: n }),
            "distancePt",
          )}
        <div style={mutedStyle} data-draw-blend-preview={preview.steps}>
          {draft.spacing === "steps"
            ? preview.steps > 0
              ? s.t(M.previewSteps, { count: preview.steps })
              : s.t(M.tooMany, { max: BLEND_MAX_STEPS })
            : draft.spacing === "distance"
              ? s.t(M.measuredAlongSpine)
              : s.t(M.fromColour)}
        </div>

        <div style={sectionStyle}>{s.t(M.orientation)}</div>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.alignTo)}</span>
          <select
            style={{ font: `12px ${font.sans}` }}
            data-draw-blend-orientation
            value={draft.orientation}
            onChange={(e) =>
              setDraft({
                ...draft,
                orientation: e.target.value as BlendOrientation,
              })
            }
          >
            {BLEND_ORIENTATIONS.map((o) => (
              <option key={o} value={o}>
                {o === "page" ? s.t(M.page) : s.t(M.path)}
              </option>
            ))}
          </select>
        </div>

        <div style={sectionStyle}>{s.t(M.easing)}</div>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>{s.t(M.shape)}</span>
          <select
            style={{ font: `12px ${font.sans}` }}
            data-draw-blend-easing
            value={draft.easing}
            onChange={(e) =>
              setDraft({ ...draft, easing: e.target.value as EaseKind })
            }
          >
            {EASE_KINDS.map((k) => (
              <option key={k} value={k}>
                {tokenLabel(k)}
              </option>
            ))}
          </select>
        </div>
        {numberRow(
          s.t(M.strength),
          draft.easingStrength,
          (n) => setDraft({ ...draft, easingStrength: n }),
          "easingStrength",
          0.1,
        )}
        {checkRow(
          s.t(M.independentColour),
          draft.colorEasing !== null,
          (b) => setDraft({ ...draft, colorEasing: b ? "easeIn" : null }),
          "independentColor",
        )}
        {draft.colorEasing !== null && (
          <>
            <div style={rowStyle}>
              <span style={{ flex: 1 }}>{s.t(M.colour)}</span>
              <select
                style={{ font: `12px ${font.sans}` }}
                data-draw-blend-color-easing
                value={draft.colorEasing}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    colorEasing: e.target.value as EaseKind,
                  })
                }
              >
                {EASE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {tokenLabel(k)}
                  </option>
                ))}
              </select>
            </div>
            {numberRow(
              s.t(M.colourStrength),
              draft.colorEasingStrength,
              (n) => setDraft({ ...draft, colorEasingStrength: n }),
              "colorEasingStrength",
              0.1,
            )}
          </>
        )}

        <div style={sectionStyle}>{s.t(M.spine)}</div>
        {checkRow(
          s.t(M.reverseSpineCheck),
          draft.reverseSpine,
          (b) => setDraft({ ...draft, reverseSpine: b }),
          "reverseSpine",
        )}
        {checkRow(
          s.t(M.reverseOrderCheck),
          draft.reverseFrontToBack,
          (b) => setDraft({ ...draft, reverseFrontToBack: b }),
          "reverseFrontToBack",
        )}
        {checkRow(
          s.t(M.fitToArtboard),
          draft.fitToArtboard,
          (b) => setDraft({ ...draft, fitToArtboard: b }),
          "fitToArtboard",
        )}

        {records.length === 0 ? (
          <div style={mutedStyle}>{s.t(M.empty)}</div>
        ) : (
          records.map((record) => (
            <div key={record.id} data-draw-blend-row={record.id}>
              <div style={{ ...rowStyle, paddingTop: 8 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={blendRowLabel(record, placed[record.id] ?? 0)}
                >
                  {record.name}
                </span>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.updateHint)}
                  data-draw-blend-update
                  onClick={() =>
                    void run(() =>
                      applyUpdateBlend(host, { blendId: record.id, ...draft }),
                    )
                  }
                >
                  {s.t(M.update)}
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.spineHint)}
                  data-draw-blend-spine
                  onClick={() =>
                    void run(() =>
                      applyReplaceBlendSpine(host, { blendId: record.id }),
                    )
                  }
                >
                  {s.t(M.spine)}
                </button>
                <IconButton
                  label={s.t(M.reverseSpine)}
                  style={iconBtn}
                  title={s.t(M.reverseSpineHint)}
                  data-draw-blend-reverse-spine
                  onClick={() =>
                    void run(() =>
                      applyReverseBlendSpine(host, { blendId: record.id }),
                    )
                  }
                >
                  ⇄
                </IconButton>
                <IconButton
                  label={s.t(M.reverseOrder)}
                  style={iconBtn}
                  title={s.t(M.reverseOrderHint)}
                  data-draw-blend-reverse-order
                  onClick={() =>
                    void run(() =>
                      applyReverseBlendOrder(host, { blendId: record.id }),
                    )
                  }
                >
                  ⇅
                </IconButton>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.keysHint)}
                  data-draw-blend-select
                  onClick={() =>
                    void run(() =>
                      applySelectBlendObjects(host, { blendId: record.id }),
                    )
                  }
                >
                  {s.t(M.keys)}
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.expandHint)}
                  data-draw-blend-expand
                  onClick={() =>
                    void run(() =>
                      applyExpandBlend(host, { blendId: record.id }),
                    )
                  }
                >
                  {s.t(M.expand)}
                </button>
                <button
                  type="button"
                  style={iconBtn}
                  title={s.t(M.releaseHint)}
                  data-draw-blend-release
                  onClick={() =>
                    void run(() =>
                      applyReleaseBlend(host, { blendId: record.id }),
                    )
                  }
                >
                  {s.t(M.release)}
                </button>
              </div>
              <div style={mutedStyle}>
                {blendRowLabel(record, placed[record.id] ?? 0)}
              </div>
            </div>
          ))
        )}

        <About attr="data-draw-blend-note">{s.t(BLEND_PANEL_NOTE)}</About>
      </div>
    );
  };
  return {
    title: t(M.title),
    component: Component,
    defaultDock: "right",
  };
}
