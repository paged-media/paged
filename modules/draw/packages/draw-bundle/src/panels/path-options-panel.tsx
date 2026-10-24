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

// The PATH OPTIONS panel — the dialog the menu's "…" promised.
//
// One section per operation that takes parameters: Offset path,
// Simplify, Outline stroke, Stroke dashes (the one section that edits a
// PROPERTY the selection already has, so its values follow the
// selection — `commands/path-options.ts` says why it lives here), the
// four Insert shapes, and Select same stroke weight (its tolerance — a
// selection verb, but "…" means a question whatever the verb, and this
// is where questions live). Each is a form
// over its command's real payload and an Apply button that runs the
// EXISTING command with what was typed (`commands/path-options.ts` owns
// the values, their defaults and where "last used" is kept; this file
// is the form).
//
// A panel, not a dialog, because the contract has no prompt and no
// dialog door — and that has a consequence a modal would not: the panel
// STAYS, so it is also where an operation is repeated with different
// numbers without going back to the menu.
//
// ONE SECTION IS OPEN AT A TIME. A "…" menu row opens ITS section (it
// says which through `BIND_PATH_OPTIONS_FOCUS`); the headers switch
// between them. A closed section keeps what was typed into it.
//
// WHAT SURVIVES WHAT. The typed values are a draft:
//   · a RELOAD (every selection and document change) never overwrites
//     it — `useFollowedDraft` loads the stored last-used values only
//     when the STORED record changes, not on every reload;
//   · an UNMOUNT (the dock tab hidden or closed) does not lose it
//     either: the draft, the open section and what was last followed
//     live in the factory's closure, which outlives the component.
// Only an Apply turns a draft into "last used".

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import * as React from "react";

import { INSERT_SHAPE_LIMITS } from "../commands/insert-shapes";
import {
  FLARE_MAX_RAYS,
  FLARE_MAX_RINGS,
  STAR_MAX_POINTS,
  STAR_MIN_POINTS,
} from "@paged-media/draw-geometry";
import { dashArrayFrom, MAX_DASH_PAIRS } from "../commands/dash";
import { supportsDuplicate, DUPLICATE_ENGINE } from "../commands/transform";
import { MAX_STROKE_WEIGHT_TOLERANCE } from "../commands/select-same";
import {
  outlineParamsFrom,
  supportsPathOps,
  type OutlineStrokeParams,
} from "../commands/path-ops";
import {
  applyPathOptions,
  dashLengthsOf,
  dashOptionsFromLengths,
  lastUsedPathOptions,
  pathOptionsFocusOf,
  BIND_PATH_OPTIONS_FOCUS,
  FROM_ELEMENT,
  OFFSET_JOIN_NOTE,
  PATH_OPTION_SECTIONS,
  PATH_OPTION_SECTION_TITLES,
  PATH_OPTIONS_PANEL_ID,
  SELECTION_SECTIONS,
  STROKE_CAPS,
  STROKE_JOINS,
  type PathOptionSection,
  type PathOptions,
} from "../commands/path-options";
import {
  clearSimplifyPreview,
  showSimplifyPreview,
  simplifyPreviewOf,
} from "../commands/simplify-preview";
import { useFollowedDraft, usePanelReload } from "./use-panel-reload";
import {
  About,
  color,
  font,
  Refusal,
  useActionFeedback,
} from "@paged-media/panel-kit";
import { PanelIntro, tokenLabel } from "./panel-parts";
import { defineMessages, t, useStrings } from "@paged-media/strings";

const M = defineMessages("draw.pathOptionsPanel", {
  summary:
    "Set the values for the path commands in the Draw menu, then apply them to the selected paths or insert a new shape.",
  note: "Apply runs the operation with these values and remembers them: the same command run from the menu or the command palette repeats the values last applied here, except Outline stroke, which then uses each path's own stroke. Offset, Simplify and Outline stroke are one undo step per selected path; each Insert, Stroke dashes and Reflect are one undo step; Select same only changes the selection. Image Trace has no options here yet.",
  dashNote:
    "Shows the first selected path's own dash and follows the selection. A pair whose dash and gap are both 0 is not used; untick Dashed for a solid stroke. Apply writes this pattern to every selected path.",
  reflectNote:
    "Mirrors the selection across an axis at this angle through the centre of the selection's box: 90° flips left and right, 0° top and bottom. Draw ▸ Transform ▸ Transform again repeats it on whatever is selected next.",
  selectSameNote:
    "Matches every object whose stroke weight is within this many points of the first selected object's, the reference included; 0 is an exact match. Colours take no tolerance: an object's fill and stroke are read as swatch references, and this plugin cannot read a swatch's colour values to compare them yet.",
  widthProfileNote:
    "Replaces each selected open path with its outline, its width running from the start through the middle to the end. The outline is a filled shape and cannot be edited as a stroke again; closed and compound paths are left as they are.",
  reflectCopyUnavailable:
    "Copy needs a newer engine (version {version} or later).",
  hiddenPairs:
    "This path's dash has {count} pairs; the editor shows the first {shown}, and Apply writes only those.",
  solid: "Solid",
  ownStroke: "{width} pt · {cap} cap · {join} join · miter limit {miterLimit}",
  fromPath: "From the path",
  offsetDelta: "Offset (pt, negative shrinks)",
  joins: "Joins",
  miterLimit: "Miter limit",
  tolerance: "Tolerance (pt)",
  cornerAngle: "Corner angle (°, 0 = none)",
  simplifyPreview: "Preview: {before} → {after} anchors",
  simplifyEngineNote:
    "The dashed outline previews the result. With no corner angle, Apply runs the engine's own simplify, which can keep a slightly different number of anchors; with a corner angle, anchors at least that sharp stay corners and Apply writes exactly what is previewed.",
  aboutPoint: "About a point (else the selection's centre)",
  pointX: "Point X (pt)",
  pointY: "Point Y (pt)",
  overrideWidth: "Override the width",
  width: "Width (pt)",
  caps: "Caps",
  overrideMiterLimit: "Override the miter limit",
  dashed: "Dashed line",
  dash1: "Dash 1 (pt)",
  gap1: "Gap 1 (pt)",
  dash2: "Dash 2 (pt)",
  gap2: "Gap 2 (pt)",
  dash3: "Dash 3 (pt)",
  gap3: "Gap 3 (pt)",
  axisAngle: "Axis angle (°)",
  copy: "Copy (reflect a copy)",
  centreX: "Centre X (pt)",
  centreY: "Centre Y (pt)",
  radiusX: "Radius X (pt)",
  radiusY: "Radius Y (pt)",
  startAngle: "Start angle (°)",
  sweep: "Sweep (°, negative reverses)",
  closeChord: "Close with the chord",
  startRadius: "Start radius (pt)",
  decay: "Radius per turn (×)",
  turns: "Turns",
  segmentsPerTurn: "Segments per turn",
  left: "Left (pt)",
  top: "Top (pt)",
  height: "Height (pt)",
  rows: "Rows",
  columns: "Columns",
  radius: "Radius (pt)",
  rings: "Rings",
  spokes: "Spokes",
  radius1: "Radius 1 (pt, the tips)",
  radius2: "Radius 2 (pt, between the tips)",
  points: "Points",
  rotation: "Rotation (°)",
  centreRadius: "Centre radius (pt)",
  haloScale: "Halo (× the centre)",
  rays: "Rays",
  rayLength: "Longest ray (pt)",
  ringRadius: "Largest ring (pt)",
  endX: "Rings end X (pt)",
  endY: "Rings end Y (pt)",
  ownStrokeIs: "The path's own stroke: {stroke}.",
  ownStrokeEach: "Each path is outlined at its own stroke unless overridden.",
  needReference: "Select the reference object first.",
  needSomething: "Select something first.",
  needPath: "Select a path first.",
  selectMatching: "Select matching",
  reflectN: "{count, plural, one {Reflect # object} other {Reflect # objects}}",
  applyToN: "{count, plural, one {Apply to # path} other {Apply to # paths}}",
  insert: "Insert",
  profileStart: "Width at the start (pt)",
  profileMiddle: "Width in the middle (pt)",
  profileEnd: "Width at the end (pt)",
  title: "Path options",
});

export { PATH_OPTIONS_PANEL_ID };

/** What the panel is for, in one sentence (shown at the top). */
export const PATH_OPTIONS_SUMMARY = M.summary;

/** The "About" text. Pinned by a test. */
export const PATH_OPTIONS_PANEL_NOTE = M.note;

/** What the Stroke dashes section says, verbatim (pinned by a test). */
export const DASH_SECTION_NOTE = M.dashNote;

/** What the section says when the path's dash has more pairs than the
 *  editor shows — an Apply would rewrite it with the three shown. */
export function hiddenPairsNote(hidden: number): string {
  return t(M.hiddenPairs, {
    count: MAX_DASH_PAIRS + hidden,
    shown: MAX_DASH_PAIRS,
  });
}

/** "6 · 3 · 1 · 3 pt", or "Solid" — the pattern an Apply writes. Pure. */
export function dashPatternLabel(lengths: readonly number[]): string {
  return lengths.length === 0 ? t(M.solid) : `${lengths.join(" · ")} pt`;
}

/** What the Reflect section says, verbatim (pinned by a test). */
export const REFLECT_SECTION_NOTE = M.reflectNote;

/** What the Simplify section says about its preview, verbatim (pinned by
 *  a test). */
export const SIMPLIFY_PREVIEW_ENGINE_NOTE = M.simplifyEngineNote;

/** What the Reflect section says when the engine cannot copy. */
export const REFLECT_COPY_UNAVAILABLE_NOTE = M.reflectCopyUnavailable;

/** What the Select same stroke weight section says, verbatim (pinned by
 *  a test) — the colour half of the request, and why it is not here. */
export const SELECT_SAME_TOLERANCE_NOTE = M.selectSameNote;

/** What the Width profile section says, verbatim (pinned by a test). */
export const WIDTH_PROFILE_SECTION_NOTE = M.widthProfileNote;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: `12px ${font.sans}`,
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  gap: 6,
  border: "none",
  borderTop: `1px solid ${color.border}`,
  background: "none",
  cursor: "pointer",
  padding: "6px 0",
  textAlign: "left",
  font: `11px ${font.sans}`,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: color.fg,
};
const applyStyle: React.CSSProperties = {
  marginTop: 4,
  cursor: "pointer",
  font: `12px ${font.sans}`,
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: `12px ${font.sans}`,
};
const inputStyle: React.CSSProperties = {
  width: 64,
  font: `12px ${font.sans}`,
};
const selectStyle: React.CSSProperties = {
  font: `12px ${font.sans}`,
};

/** "2 pt · butt · miter · limit 4" — what the selected element's own
 *  stroke says, i.e. what an untouched Outline stroke section applies.
 *  Pure; exported so the spec pins the wording without a DOM. */
export function ownStrokeLabel(own: OutlineStrokeParams): string {
  return t(M.ownStroke, {
    width: own.width,
    cap: own.cap,
    join: own.join,
    miterLimit: own.miterLimit,
  });
}

export function makePathOptionsPanel(host: BundleHost): {
  title: string;
  component: React.ComponentType<PanelProps>;
  defaultDock: "right";
} {
  // What outlives the component (see "WHAT SURVIVES WHAT" above). Filled
  // on the first mount, not at activate: `host.storage` is read when the
  // panel is first shown, not when the bundle loads.
  const session: {
    draft: PathOptions | null;
    /** Per section: the stored values the draft last took, serialised. */
    followed: Partial<Record<PathOptionSection, string>>;
    open: PathOptionSection;
    /** The newest focus request already honoured. */
    focusSeq: number;
    /** The dash section follows the SELECTION: the path + dash it last
     *  loaded, so a reload that changes neither keeps what was typed. */
    dashFollowed: string | null;
    /** Pairs the followed path's dash has beyond the three shown. */
    dashHidden: number;
  } = {
    draft: null,
    followed: {},
    open: "offset",
    focusSeq: 0,
    dashFollowed: null,
    dashHidden: 0,
  };

  /** Take into the draft every section whose STORED values changed since
   *  the draft last took them; null when none did. Per SECTION, because
   *  applying one must not reset what is typed, unapplied, in another. */
  const followStored = (): PathOptions | null => {
    const stored = lastUsedPathOptions(host);
    let next: PathOptions | null = null;
    for (const section of PATH_OPTION_SECTIONS) {
      const key = JSON.stringify(stored[section]);
      if (session.followed[section] === key) continue;
      session.followed[section] = key;
      next = {
        ...(next ?? session.draft ?? stored),
        [section]: stored[section],
      };
    }
    if (next) session.draft = next;
    return next;
  };

  const Component: React.FC<PanelProps> = () => {
    const s = useStrings();
    // The first mount starts from the stored values; a later one from
    // the draft the last one left.
    if (session.draft === null) followStored();
    const [draft, setDraftState, followDraft] = useFollowedDraft<PathOptions>(
      session.draft as PathOptions,
    );
    const [open, setOpenState] = React.useState<PathOptionSection>(
      session.open,
    );
    const [targets, setTargets] = React.useState(0);
    /** Everything selected, path or not — Select same's reference may be
     *  any kind that carries a stroke weight. */
    const [selected, setSelected] = React.useState(0);
    const [own, setOwn] = React.useState<OutlineStrokeParams | null>(null);
    const [dashHidden, setDashHidden] = React.useState(session.dashHidden);
    /** Can this engine COPY (`duplicateElements`)? Probed when the
     *  Reflect section is first opened — never on a reload — and cached
     *  per host by the probe itself. Null until known. */
    const [copyAvailable, setCopyAvailable] = React.useState<boolean | null>(
      null,
    );
    /** Simplify's preview counts, while its section is open. */
    const [simplifyCounts, setSimplifyCounts] = React.useState<{
      before: number;
      after: number;
    } | null>(null);
    /** Bumped by every reload, so the Simplify preview follows the
     *  selection and the document. */
    const [reloads, setReloads] = React.useState(0);

    // eslint-disable-next-line no-restricted-syntax -- the component is not compiled yet (compiler-coverage.json) (ADR 229)
    const setOpen = React.useCallback((section: PathOptionSection) => {
      session.open = section;
      setOpenState(section);
    }, []);

    /** Replace one section of the draft. */
    const edit = <S extends PathOptionSection>(
      section: S,
      patch: Partial<PathOptions[S]>,
    ) => {
      const next: PathOptions = {
        ...draft,
        [section]: { ...draft[section], ...patch },
      };
      session.draft = next;
      setDraftState(next);
    };

    // A "…" command names its section through a binding: honour the
    // request that is already there when the panel mounts (the command
    // raised a panel that was not open yet) and every later one.
    React.useEffect(() => {
      const honour = () => {
        const focus = pathOptionsFocusOf(host);
        if (!focus || focus.seq <= session.focusSeq) return;
        session.focusSeq = focus.seq;
        setOpen(focus.section);
      };
      honour();
      const sub = host.bindings.onDidChange((name) => {
        if (name === BIND_PATH_OPTIONS_FOCUS) honour();
      });
      return () => sub.dispose();
    }, [setOpen]);

    // The engine-0.65 probe — once, when Reflect or Offset is first shown:
    // Reflect ▸ Copy needs `duplicateElements`, and the same release made
    // the offset honour its join (OFFSET_JOIN_NOTE is only for an older
    // engine).
    React.useEffect(() => {
      if ((open !== "reflect" && open !== "offset") || copyAvailable !== null)
        return;
      let live = true;
      void supportsDuplicate(host).then((ok) => {
        if (live) setCopyAvailable(ok);
      });
      return () => {
        live = false;
      };
    }, [open, copyAvailable]);

    // SIMPLIFY'S LIVE PREVIEW (`commands/simplify-preview.ts`): while the
    // section is open, every edit of its values — and every reload — draws
    // the simplified selection over the canvas; closing the section or
    // the panel clears it.
    React.useEffect(() => {
      if (open !== "simplify") {
        clearSimplifyPreview(host);
        return;
      }
      let live = true;
      void simplifyPreviewOf(host, host.selection.get(), {
        tolerance: draft.simplify.tolerance,
        cornerAngle: draft.simplify.cornerAngle,
      })
        .then((preview) => {
          if (!live) return;
          showSimplifyPreview(host, preview.shapes);
          setSimplifyCounts(
            preview.shapes.length > 0
              ? { before: preview.before, after: preview.after }
              : null,
          );
        })
        .catch((err) =>
          host.log.debug(`simplify preview failed: ${String(err)}`),
        );
      return () => {
        live = false;
      };
    }, [open, draft.simplify.tolerance, draft.simplify.cornerAngle, reloads]);
    React.useEffect(() => () => clearSimplifyPreview(host), []);

    // WHAT A RELOAD COSTS (`test/panels/path-options-panel.dom.test.tsx`):
    // nothing with no path selected, and ONE property read — the first
    // selected path's own stroke, which is what the Outline stroke
    // section shows it will use AND what the Stroke dashes section
    // loads — otherwise. No document walk: this panel keeps no records.
    const reload = usePanelReload(
      host,
      "path-options",
      async ({ live, selection }) => {
        const paths = selection.filter(supportsPathOps);
        const first = paths[0];
        const props = first
          ? await host.document.elementProperties(first).catch(() => null)
          : null;
        if (!live()) return;
        const entries = props?.entries ?? [];
        setTargets(paths.length);
        setSelected(selection.length);
        setReloads((n) => n + 1);
        setOwn(first ? outlineParamsFrom(entries) : null);
        // Follow the STORED last-used values — only the sections that
        // changed since this panel last took them, so neither a reload
        // nor a remount throws away what was typed.
        let next = followStored();
        // …and the dash section follows the SELECTED PATH's own dash,
        // when the path or its dash changed since it was last loaded.
        if (first) {
          const dash = dashArrayFrom(entries);
          const key = JSON.stringify([first.kind, String(first.id), dash]);
          if (key !== session.dashFollowed) {
            session.dashFollowed = key;
            const base = (next ?? session.draft ?? lastUsedPathOptions(host))
              .dash;
            const read = dashOptionsFromLengths(dash, base);
            session.dashHidden = read.hiddenPairs;
            setDashHidden(read.hiddenPairs);
            next = {
              ...(next ?? (session.draft as PathOptions)),
              dash: read.options,
            };
            session.draft = next;
          }
        }
        if (next) {
          followDraft(
            JSON.stringify([session.followed, session.dashFollowed]),
            next,
          );
        }
      },
    );

    const { refusal, run } = useActionFeedback(host, reload, "draw panel");

    const numberRow = <S extends PathOptionSection>(
      section: S,
      key: keyof PathOptions[S] & string,
      label: string,
      opts: {
        step?: number;
        min?: number;
        max?: number;
        disabled?: boolean;
      } = {},
    ) => (
      <div style={rowStyle}>
        <span style={{ flex: 1 }}>{label}</span>
        <input
          type="number"
          step={opts.step ?? 1}
          min={opts.min}
          max={opts.max}
          disabled={opts.disabled}
          style={inputStyle}
          data-draw-pathopts-field={`${section}.${key}`}
          value={draft[section][key] as unknown as number}
          onChange={(e) =>
            edit(section, {
              [key]: Number(e.target.value),
            } as unknown as Partial<PathOptions[S]>)
          }
        />
      </div>
    );

    const selectRow = <S extends PathOptionSection>(
      section: S,
      key: keyof PathOptions[S] & string,
      label: string,
      options: readonly { value: string; label: string }[],
    ) => (
      <div style={rowStyle}>
        <span style={{ flex: 1 }}>{label}</span>
        <select
          style={selectStyle}
          data-draw-pathopts-select={`${section}.${key}`}
          value={draft[section][key] as unknown as string}
          onChange={(e) =>
            edit(section, {
              [key]: e.target.value,
            } as unknown as Partial<PathOptions[S]>)
          }
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );

    const checkRow = <S extends PathOptionSection>(
      section: S,
      key: keyof PathOptions[S] & string,
      label: string,
      opts: { disabled?: boolean } = {},
    ) => (
      <div style={rowStyle}>
        <label style={{ flex: 1 }} htmlFor={`draw-pathopts-${section}-${key}`}>
          {label}
        </label>
        <input
          id={`draw-pathopts-${section}-${key}`}
          type="checkbox"
          data-draw-pathopts-toggle={`${section}.${key}`}
          disabled={opts.disabled}
          checked={draft[section][key] as unknown as boolean}
          onChange={(e) =>
            edit(section, {
              [key]: e.target.checked,
            } as unknown as Partial<PathOptions[S]>)
          }
        />
      </div>
    );

    const tokens = (list: readonly string[]) =>
      list.map((value) => ({ value, label: tokenLabel(value) }));
    const withElement = (list: readonly string[]) => [
      { value: FROM_ELEMENT, label: s.t(M.fromPath) },
      ...tokens(list),
    ];

    const fields = (section: PathOptionSection): React.ReactNode => {
      switch (section) {
        case "offset":
          return (
            <>
              {numberRow("offset", "delta", s.t(M.offsetDelta), {
                step: 0.5,
              })}
              {selectRow("offset", "join", s.t(M.joins), tokens(STROKE_JOINS))}
              {numberRow("offset", "miterLimit", s.t(M.miterLimit), {
                step: 0.5,
                min: 1,
                disabled: draft.offset.join !== "miter",
              })}
              {copyAvailable === false && (
                <div style={mutedStyle} data-draw-pathopts-offset-join-note>
                  {s.t(OFFSET_JOIN_NOTE)}
                </div>
              )}
            </>
          );
        case "simplify":
          return (
            <>
              {numberRow("simplify", "tolerance", s.t(M.tolerance), {
                step: 0.25,
                min: 0,
              })}
              {numberRow("simplify", "cornerAngle", s.t(M.cornerAngle), {
                step: 5,
                min: 0,
                max: 180,
              })}
              {open === "simplify" && simplifyCounts && (
                <div style={mutedStyle} data-draw-pathopts-simplify-preview>
                  {s.t(M.simplifyPreview, simplifyCounts)}
                </div>
              )}
              <div style={mutedStyle} data-draw-pathopts-simplify-note>
                {s.t(SIMPLIFY_PREVIEW_ENGINE_NOTE)}
              </div>
            </>
          );
        case "outlineStroke":
          return (
            <>
              <div style={mutedStyle} data-draw-pathopts-own>
                {own
                  ? s.t(M.ownStrokeIs, { stroke: ownStrokeLabel(own) })
                  : s.t(M.ownStrokeEach)}
              </div>
              {checkRow("outlineStroke", "overrideWidth", s.t(M.overrideWidth))}
              {numberRow("outlineStroke", "width", s.t(M.width), {
                step: 0.25,
                min: 0,
                disabled: !draft.outlineStroke.overrideWidth,
              })}
              {selectRow(
                "outlineStroke",
                "cap",
                s.t(M.caps),
                withElement(STROKE_CAPS),
              )}
              {selectRow(
                "outlineStroke",
                "join",
                s.t(M.joins),
                withElement(STROKE_JOINS),
              )}
              {checkRow(
                "outlineStroke",
                "overrideMiterLimit",
                s.t(M.overrideMiterLimit),
              )}
              {numberRow("outlineStroke", "miterLimit", s.t(M.miterLimit), {
                step: 0.5,
                min: 1,
                disabled: !draft.outlineStroke.overrideMiterLimit,
              })}
            </>
          );
        case "dash": {
          const off = !draft.dash.dashed;
          return (
            <>
              {checkRow("dash", "dashed", s.t(M.dashed))}
              {numberRow("dash", "dash1", s.t(M.dash1), {
                step: 0.5,
                min: 0,
                disabled: off,
              })}
              {numberRow("dash", "gap1", s.t(M.gap1), {
                step: 0.5,
                min: 0,
                disabled: off,
              })}
              {numberRow("dash", "dash2", s.t(M.dash2), {
                step: 0.5,
                min: 0,
                disabled: off,
              })}
              {numberRow("dash", "gap2", s.t(M.gap2), {
                step: 0.5,
                min: 0,
                disabled: off,
              })}
              {numberRow("dash", "dash3", s.t(M.dash3), {
                step: 0.5,
                min: 0,
                disabled: off,
              })}
              {numberRow("dash", "gap3", s.t(M.gap3), {
                step: 0.5,
                min: 0,
                disabled: off,
              })}
              <div style={mutedStyle} data-draw-pathopts-dash-pattern>
                {dashPatternLabel(dashLengthsOf(draft.dash))}
              </div>
              {dashHidden > 0 && (
                <div style={mutedStyle} data-draw-pathopts-dash-hidden>
                  {hiddenPairsNote(dashHidden)}
                </div>
              )}
              <div style={mutedStyle} data-draw-pathopts-dash-note>
                {s.t(DASH_SECTION_NOTE)}
              </div>
            </>
          );
        }
        case "reflect":
          return (
            <>
              {numberRow("reflect", "angleDeg", s.t(M.axisAngle), {
                min: -360,
                max: 360,
              })}
              {checkRow("reflect", "copy", s.t(M.copy), {
                disabled: copyAvailable !== true,
              })}
              {checkRow("reflect", "aboutPoint", s.t(M.aboutPoint))}
              {numberRow("reflect", "x", s.t(M.pointX), {
                disabled: !draft.reflect.aboutPoint,
              })}
              {numberRow("reflect", "y", s.t(M.pointY), {
                disabled: !draft.reflect.aboutPoint,
              })}
              {copyAvailable === false && (
                <div style={mutedStyle} data-draw-pathopts-reflect-copy-note>
                  {s.t(REFLECT_COPY_UNAVAILABLE_NOTE, {
                    version: DUPLICATE_ENGINE,
                  })}
                </div>
              )}
              <div style={mutedStyle} data-draw-pathopts-reflect-note>
                {s.t(REFLECT_SECTION_NOTE)}
              </div>
            </>
          );
        case "arc":
          return (
            <>
              {numberRow("arc", "cx", s.t(M.centreX))}
              {numberRow("arc", "cy", s.t(M.centreY))}
              {numberRow("arc", "rx", s.t(M.radiusX), { min: 0 })}
              {numberRow("arc", "ry", s.t(M.radiusY), { min: 0 })}
              {numberRow("arc", "startAngleDeg", s.t(M.startAngle))}
              {numberRow("arc", "sweepDeg", s.t(M.sweep), {
                min: -360,
                max: 360,
              })}
              {checkRow("arc", "closed", s.t(M.closeChord))}
            </>
          );
        case "spiral":
          return (
            <>
              {numberRow("spiral", "cx", s.t(M.centreX))}
              {numberRow("spiral", "cy", s.t(M.centreY))}
              {numberRow("spiral", "r0", s.t(M.startRadius), { min: 0 })}
              {numberRow("spiral", "decay", s.t(M.decay), {
                step: 0.05,
                min: 0,
              })}
              {numberRow("spiral", "turns", s.t(M.turns), {
                step: 0.25,
                min: 0,
                max: INSERT_SHAPE_LIMITS.maxTurns,
              })}
              {numberRow("spiral", "segmentsPerTurn", s.t(M.segmentsPerTurn), {
                min: 2,
                max: INSERT_SHAPE_LIMITS.maxSegmentsPerTurn,
              })}
            </>
          );
        case "rectGrid":
          return (
            <>
              {numberRow("rectGrid", "x", s.t(M.left))}
              {numberRow("rectGrid", "y", s.t(M.top))}
              {numberRow("rectGrid", "width", s.t(M.width), { min: 0 })}
              {numberRow("rectGrid", "height", s.t(M.height), { min: 0 })}
              {numberRow("rectGrid", "rows", s.t(M.rows), {
                min: 1,
                max: INSERT_SHAPE_LIMITS.maxCount,
              })}
              {numberRow("rectGrid", "cols", s.t(M.columns), {
                min: 1,
                max: INSERT_SHAPE_LIMITS.maxCount,
              })}
            </>
          );
        case "polarGrid":
          return (
            <>
              {numberRow("polarGrid", "cx", s.t(M.centreX))}
              {numberRow("polarGrid", "cy", s.t(M.centreY))}
              {numberRow("polarGrid", "r", s.t(M.radius), { min: 0 })}
              {numberRow("polarGrid", "rings", s.t(M.rings), {
                min: 0,
                max: INSERT_SHAPE_LIMITS.maxCount,
              })}
              {numberRow("polarGrid", "radials", s.t(M.spokes), {
                min: 0,
                max: INSERT_SHAPE_LIMITS.maxCount,
              })}
            </>
          );
        case "star":
          return (
            <>
              {numberRow("star", "cx", s.t(M.centreX))}
              {numberRow("star", "cy", s.t(M.centreY))}
              {numberRow("star", "radius1", s.t(M.radius1), { min: 0 })}
              {numberRow("star", "radius2", s.t(M.radius2), { min: 0 })}
              {numberRow("star", "points", s.t(M.points), {
                min: STAR_MIN_POINTS,
                max: STAR_MAX_POINTS,
              })}
              {numberRow("star", "rotationDeg", s.t(M.rotation))}
            </>
          );
        case "flare":
          return (
            <>
              {numberRow("flare", "cx", s.t(M.centreX))}
              {numberRow("flare", "cy", s.t(M.centreY))}
              {numberRow("flare", "centreRadius", s.t(M.centreRadius), {
                min: 0.5,
              })}
              {numberRow("flare", "haloScale", s.t(M.haloScale), {
                step: 0.25,
                min: 1,
              })}
              {numberRow("flare", "rays", s.t(M.rays), {
                min: 0,
                max: FLARE_MAX_RAYS,
              })}
              {numberRow("flare", "rayLength", s.t(M.rayLength), { min: 0 })}
              {numberRow("flare", "rings", s.t(M.rings), {
                min: 0,
                max: FLARE_MAX_RINGS,
              })}
              {numberRow("flare", "ringRadius", s.t(M.ringRadius), { min: 0 })}
              {numberRow("flare", "endX", s.t(M.endX))}
              {numberRow("flare", "endY", s.t(M.endY))}
            </>
          );
        case "selectSameWeight":
          return (
            <>
              {numberRow("selectSameWeight", "tolerance", s.t(M.tolerance), {
                step: 0.25,
                min: 0,
                max: MAX_STROKE_WEIGHT_TOLERANCE,
              })}
              <div style={mutedStyle} data-draw-pathopts-select-note>
                {s.t(SELECT_SAME_TOLERANCE_NOTE)}
              </div>
            </>
          );
        case "widthProfile":
          return (
            <>
              {numberRow("widthProfile", "start", s.t(M.profileStart), {
                step: 0.5,
                min: 0,
              })}
              {numberRow("widthProfile", "middle", s.t(M.profileMiddle), {
                step: 0.5,
                min: 0,
              })}
              {numberRow("widthProfile", "end", s.t(M.profileEnd), {
                step: 0.5,
                min: 0,
              })}
              <div style={mutedStyle} data-draw-pathopts-width-note>
                {s.t(WIDTH_PROFILE_SECTION_NOTE)}
              </div>
            </>
          );
      }
    };

    return (
      <div
        style={{ padding: 12 }}
        data-draw-pathopts-panel={open}
        data-draw-pathopts-targets={targets}
      >
        <PanelIntro
          summary={s.t(PATH_OPTIONS_SUMMARY)}
          attr="data-draw-pathopts-intro"
        />
        <Refusal text={refusal} />
        {PATH_OPTION_SECTIONS.map((section) => {
          const isOpen = section === open;
          const needsSelection = SELECTION_SECTIONS.has(section);
          const selects = section === "selectSameWeight";
          const reflects = section === "reflect";
          // A path operation needs a PATH; Select same needs a reference;
          // Reflect takes any object (groups included).
          const have = selects || reflects ? selected : targets;
          return (
            <div
              key={section}
              data-draw-pathopts-section={section}
              data-draw-pathopts-open={isOpen ? "true" : "false"}
            >
              <button
                type="button"
                style={{ ...headerStyle, opacity: isOpen ? 1 : 0.65 }}
                aria-expanded={isOpen}
                data-draw-pathopts-header={section}
                onClick={() => setOpen(section)}
              >
                <span style={{ flex: 1 }}>
                  {s.t(PATH_OPTION_SECTION_TITLES[section])}
                </span>
                <span aria-hidden>{isOpen ? "–" : "+"}</span>
              </button>
              {isOpen && (
                <div style={{ paddingBottom: 8 }}>
                  {fields(section)}
                  {needsSelection && have === 0 && (
                    <div style={mutedStyle} data-draw-pathopts-needs-selection>
                      {selects
                        ? s.t(M.needReference)
                        : reflects
                          ? s.t(M.needSomething)
                          : s.t(M.needPath)}
                    </div>
                  )}
                  <button
                    type="button"
                    style={applyStyle}
                    data-draw-pathopts-apply={section}
                    disabled={needsSelection && have === 0}
                    onClick={() =>
                      void run(() =>
                        applyPathOptions(host, section, draft[section]),
                      )
                    }
                  >
                    {selects
                      ? s.t(M.selectMatching)
                      : reflects
                        ? s.t(M.reflectN, { count: selected })
                        : needsSelection
                          ? s.t(M.applyToN, { count: targets })
                          : s.t(M.insert)}
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <About attr="data-draw-pathopts-note">
          {s.t(PATH_OPTIONS_PANEL_NOTE)}
        </About>
      </div>
    );
  };
  return {
    title: t(M.title),
    component: Component,
    defaultDock: "right",
  };
}
