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
import { dashArrayFrom, MAX_DASH_PAIRS } from "../commands/dash";
import {
  supportsDuplicate,
  DUPLICATE_ENGINE,
  DUPLICATE_OP,
} from "../commands/transform";
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
import { useFollowedDraft, usePanelReload } from "./use-panel-reload";

export { PATH_OPTIONS_PANEL_ID };

/** What the panel says under the form, verbatim. Pinned by a test. */
export const PATH_OPTIONS_PANEL_NOTE =
  "Apply runs the operation with the values above and remembers them: " +
  "the same command run from the command palette, with no parameters, " +
  "repeats the values last APPLIED here. Outline stroke is the exception " +
  "— run bare it always outlines the element's own stroke. The undo " +
  "arithmetic: Offset, Simplify and Outline stroke are one undo step per " +
  "selected path; each Insert is ONE undo step however many paths it " +
  "adds; Stroke dashes is ONE undo step for every selected path, and " +
  "so is Reflect for the whole selection; " +
  "Select same changes only the selection. Image Trace has no " +
  "options here yet — its menu row still runs " +
  "fixed settings.";

/** What the Stroke dashes section says, verbatim (pinned by a test). */
export const DASH_SECTION_NOTE =
  "Shows the first selected path's own dash and follows the selection. " +
  "A pair whose dash and gap are both 0 is not used; untick Dashed for a " +
  "solid stroke. Apply writes this pattern to every selected path.";

/** What the section says when the path's dash has more pairs than the
 *  editor shows — an Apply would rewrite it with the three shown. */
export function hiddenPairsNote(hidden: number): string {
  return (
    `This path's dash has ${MAX_DASH_PAIRS + hidden} pairs; the editor shows ` +
    `the first ${MAX_DASH_PAIRS}, and Apply writes only those.`
  );
}

/** "6 · 3 · 1 · 3 pt", or "Solid" — the pattern an Apply writes. Pure. */
export function dashPatternLabel(lengths: readonly number[]): string {
  return lengths.length === 0 ? "Solid" : `${lengths.join(" · ")} pt`;
}

/** What the Reflect section says, verbatim (pinned by a test). */
export const REFLECT_SECTION_NOTE =
  "Mirrors the selection across an axis at this angle through the centre " +
  "of the selection's box: 90° flips left and right, 0° top and bottom. " +
  "Draw ▸ Transform ▸ Transform again repeats it on whatever is selected next.";

/** What the Reflect section says when the engine cannot copy. */
export const REFLECT_COPY_UNAVAILABLE_NOTE =
  `Copy needs the engine's ${DUPLICATE_OP} op (engine ${DUPLICATE_ENGINE}), ` +
  "which this engine does not have.";

/** What the Select same stroke weight section says, verbatim (pinned by
 *  a test) — the colour half of the request, and why it is not here. */
export const SELECT_SAME_TOLERANCE_NOTE =
  "Matches every object whose stroke weight is within this many points " +
  "of the first selected object's, the reference included; 0 is an exact " +
  "match. Colours take no tolerance: an object's fill and stroke are read " +
  "as swatch references, and no door gives this plugin a swatch's colour " +
  "values to compare.";

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  font: "12px var(--font-sans, sans-serif)",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  gap: 6,
  border: "none",
  borderTop: "1px solid var(--pg-border, rgba(127,127,127,0.4))",
  background: "none",
  cursor: "pointer",
  padding: "6px 0",
  textAlign: "left",
  font: "11px var(--font-sans, sans-serif)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--pg-fg, currentColor)",
};
const applyStyle: React.CSSProperties = {
  marginTop: 4,
  cursor: "pointer",
  font: "12px var(--font-sans, sans-serif)",
};
const noteStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "6px 8px",
  border: "1px solid var(--pg-border, rgba(127,127,127,0.4))",
  borderRadius: 3,
  font: "11px/1.45 var(--font-sans, sans-serif)",
  opacity: 0.8,
};
const mutedStyle: React.CSSProperties = {
  opacity: 0.6,
  font: "12px var(--font-sans, sans-serif)",
};
const inputStyle: React.CSSProperties = {
  width: 64,
  font: "12px var(--font-sans, sans-serif)",
};
const selectStyle: React.CSSProperties = {
  font: "12px var(--font-sans, sans-serif)",
};

/** "2 pt · butt · miter · limit 4" — what the selected element's own
 *  stroke says, i.e. what an untouched Outline stroke section applies.
 *  Pure; exported so the spec pins the wording without a DOM. */
export function ownStrokeLabel(own: OutlineStrokeParams): string {
  return `${own.width} pt · ${own.cap} · ${own.join} · limit ${own.miterLimit}`;
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
      next = { ...(next ?? session.draft ?? stored), [section]: stored[section] };
    }
    if (next) session.draft = next;
    return next;
  };

  const Component: React.FC<PanelProps> = () => {
    // The first mount starts from the stored values; a later one from
    // the draft the last one left.
    if (session.draft === null) followStored();
    const [draft, setDraftState, followDraft] = useFollowedDraft<PathOptions>(
      session.draft as PathOptions,
    );
    const [open, setOpenState] = React.useState<PathOptionSection>(session.open);
    const [targets, setTargets] = React.useState(0);
    /** Everything selected, path or not — Select same's reference may be
     *  any kind that carries a stroke weight. */
    const [selected, setSelected] = React.useState(0);
    const [own, setOwn] = React.useState<OutlineStrokeParams | null>(null);
    const [dashHidden, setDashHidden] = React.useState(session.dashHidden);
    /** Can this engine COPY (`duplicateElements`)? Probed when the
     *  Reflect section is first opened — never on a reload — and cached
     *  per host by the probe itself. Null until known. */
    const [copyAvailable, setCopyAvailable] = React.useState<boolean | null>(null);

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

    // The copy probe — once, when Reflect is first shown.
    React.useEffect(() => {
      if (open !== "reflect" || copyAvailable !== null) return;
      let live = true;
      void supportsDuplicate(host).then((ok) => {
        if (live) setCopyAvailable(ok);
      });
      return () => {
        live = false;
      };
    }, [open, copyAvailable]);

    // WHAT A RELOAD COSTS (`test/panels/path-options-panel.spec.tsx`):
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
            const base = (next ?? session.draft ?? lastUsedPathOptions(host)).dash;
            const read = dashOptionsFromLengths(dash, base);
            session.dashHidden = read.hiddenPairs;
            setDashHidden(read.hiddenPairs);
            next = { ...(next ?? (session.draft as PathOptions)), dash: read.options };
            session.draft = next;
          }
        }
        if (next) {
          followDraft(JSON.stringify([session.followed, session.dashFollowed]), next);
        }
      },
    );

    const run = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (e) {
        host.log.warn(`path options panel: ${String(e)}`);
      }
      reload();
    };

    const numberRow = <S extends PathOptionSection>(
      section: S,
      key: keyof PathOptions[S] & string,
      label: string,
      opts: { step?: number; min?: number; max?: number; disabled?: boolean } = {},
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
      list.map((value) => ({ value, label: value }));
    const withElement = (list: readonly string[]) => [
      { value: FROM_ELEMENT, label: "From the element" },
      ...tokens(list),
    ];

    const fields = (section: PathOptionSection): React.ReactNode => {
      switch (section) {
        case "offset":
          return (
            <>
              {numberRow("offset", "delta", "Offset (pt, negative shrinks)", {
                step: 0.5,
              })}
              {selectRow("offset", "join", "Joins", tokens(STROKE_JOINS))}
              {numberRow("offset", "miterLimit", "Miter limit", {
                step: 0.5,
                min: 1,
                disabled: draft.offset.join !== "miter",
              })}
              <div style={mutedStyle} data-draw-pathopts-offset-join-note>
                {OFFSET_JOIN_NOTE}
              </div>
            </>
          );
        case "simplify":
          return numberRow("simplify", "tolerance", "Tolerance (pt)", {
            step: 0.25,
            min: 0,
          });
        case "outlineStroke":
          return (
            <>
              <div style={mutedStyle} data-draw-pathopts-own>
                {own
                  ? `The element's own stroke: ${ownStrokeLabel(own)}.`
                  : "Each path is outlined at its own stroke unless overridden."}
              </div>
              {checkRow("outlineStroke", "overrideWidth", "Override the width")}
              {numberRow("outlineStroke", "width", "Width (pt)", {
                step: 0.25,
                min: 0,
                disabled: !draft.outlineStroke.overrideWidth,
              })}
              {selectRow("outlineStroke", "cap", "Caps", withElement(STROKE_CAPS))}
              {selectRow("outlineStroke", "join", "Joins", withElement(STROKE_JOINS))}
              {checkRow(
                "outlineStroke",
                "overrideMiterLimit",
                "Override the miter limit",
              )}
              {numberRow("outlineStroke", "miterLimit", "Miter limit", {
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
              {checkRow("dash", "dashed", "Dashed line")}
              {numberRow("dash", "dash1", "Dash 1 (pt)", { step: 0.5, min: 0, disabled: off })}
              {numberRow("dash", "gap1", "Gap 1 (pt)", { step: 0.5, min: 0, disabled: off })}
              {numberRow("dash", "dash2", "Dash 2 (pt)", { step: 0.5, min: 0, disabled: off })}
              {numberRow("dash", "gap2", "Gap 2 (pt)", { step: 0.5, min: 0, disabled: off })}
              {numberRow("dash", "dash3", "Dash 3 (pt)", { step: 0.5, min: 0, disabled: off })}
              {numberRow("dash", "gap3", "Gap 3 (pt)", { step: 0.5, min: 0, disabled: off })}
              <div style={mutedStyle} data-draw-pathopts-dash-pattern>
                {dashPatternLabel(dashLengthsOf(draft.dash))}
              </div>
              {dashHidden > 0 && (
                <div style={mutedStyle} data-draw-pathopts-dash-hidden>
                  {hiddenPairsNote(dashHidden)}
                </div>
              )}
              <div style={mutedStyle} data-draw-pathopts-dash-note>
                {DASH_SECTION_NOTE}
              </div>
            </>
          );
        }
        case "reflect":
          return (
            <>
              {numberRow("reflect", "angleDeg", "Axis angle (°)", { min: -360, max: 360 })}
              {checkRow("reflect", "copy", "Copy (reflect a copy)", {
                disabled: copyAvailable !== true,
              })}
              {copyAvailable === false && (
                <div style={mutedStyle} data-draw-pathopts-reflect-copy-note>
                  {REFLECT_COPY_UNAVAILABLE_NOTE}
                </div>
              )}
              <div style={mutedStyle} data-draw-pathopts-reflect-note>
                {REFLECT_SECTION_NOTE}
              </div>
            </>
          );
        case "arc":
          return (
            <>
              {numberRow("arc", "cx", "Centre X (pt)")}
              {numberRow("arc", "cy", "Centre Y (pt)")}
              {numberRow("arc", "rx", "Radius X (pt)", { min: 0 })}
              {numberRow("arc", "ry", "Radius Y (pt)", { min: 0 })}
              {numberRow("arc", "startAngleDeg", "Start angle (°)")}
              {numberRow("arc", "sweepDeg", "Sweep (°, negative reverses)", {
                min: -360,
                max: 360,
              })}
              {checkRow("arc", "closed", "Close with the chord")}
            </>
          );
        case "spiral":
          return (
            <>
              {numberRow("spiral", "cx", "Centre X (pt)")}
              {numberRow("spiral", "cy", "Centre Y (pt)")}
              {numberRow("spiral", "r0", "Start radius (pt)", { min: 0 })}
              {numberRow("spiral", "decay", "Radius per turn (×)", {
                step: 0.05,
                min: 0,
              })}
              {numberRow("spiral", "turns", "Turns", {
                step: 0.25,
                min: 0,
                max: INSERT_SHAPE_LIMITS.maxTurns,
              })}
              {numberRow("spiral", "segmentsPerTurn", "Segments per turn", {
                min: 2,
                max: INSERT_SHAPE_LIMITS.maxSegmentsPerTurn,
              })}
            </>
          );
        case "rectGrid":
          return (
            <>
              {numberRow("rectGrid", "x", "Left (pt)")}
              {numberRow("rectGrid", "y", "Top (pt)")}
              {numberRow("rectGrid", "width", "Width (pt)", { min: 0 })}
              {numberRow("rectGrid", "height", "Height (pt)", { min: 0 })}
              {numberRow("rectGrid", "rows", "Rows", {
                min: 1,
                max: INSERT_SHAPE_LIMITS.maxCount,
              })}
              {numberRow("rectGrid", "cols", "Columns", {
                min: 1,
                max: INSERT_SHAPE_LIMITS.maxCount,
              })}
            </>
          );
        case "polarGrid":
          return (
            <>
              {numberRow("polarGrid", "cx", "Centre X (pt)")}
              {numberRow("polarGrid", "cy", "Centre Y (pt)")}
              {numberRow("polarGrid", "r", "Radius (pt)", { min: 0 })}
              {numberRow("polarGrid", "rings", "Rings", {
                min: 0,
                max: INSERT_SHAPE_LIMITS.maxCount,
              })}
              {numberRow("polarGrid", "radials", "Spokes", {
                min: 0,
                max: INSERT_SHAPE_LIMITS.maxCount,
              })}
            </>
          );
        case "selectSameWeight":
          return (
            <>
              {numberRow("selectSameWeight", "tolerance", "Tolerance (pt)", {
                step: 0.25,
                min: 0,
                max: MAX_STROKE_WEIGHT_TOLERANCE,
              })}
              <div style={mutedStyle} data-draw-pathopts-select-note>
                {SELECT_SAME_TOLERANCE_NOTE}
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
                  {PATH_OPTION_SECTION_TITLES[section]}
                </span>
                <span aria-hidden>{isOpen ? "–" : "+"}</span>
              </button>
              {isOpen && (
                <div style={{ paddingBottom: 8 }}>
                  {fields(section)}
                  {needsSelection && have === 0 && (
                    <div style={mutedStyle} data-draw-pathopts-needs-selection>
                      {selects
                        ? "Select the reference object first."
                        : reflects
                          ? "Select something first."
                          : "Select a path first."}
                    </div>
                  )}
                  <button
                    type="button"
                    style={applyStyle}
                    data-draw-pathopts-apply={section}
                    disabled={needsSelection && have === 0}
                    onClick={() =>
                      void run(applyPathOptions(host, section, draft[section]))
                    }
                  >
                    {selects
                      ? "Select matching"
                      : reflects
                        ? `Reflect ${selected} object${selected === 1 ? "" : "s"}`
                        : needsSelection
                        ? `Apply to ${targets} path${targets === 1 ? "" : "s"}`
                        : "Insert"}
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <div style={noteStyle} data-draw-pathopts-note>
          {PATH_OPTIONS_PANEL_NOTE}
        </div>
      </div>
    );
  };
  return {
    title: "Path options",
    component: Component,
    defaultDock: "right",
  };
}
