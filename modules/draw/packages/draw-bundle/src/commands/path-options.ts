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

// PATH OPTIONS — the parameters behind the menu's "…".
//
// THE GAP. "Offset path…", "Simplify…" and the four "Insert …" rows
// carried an ellipsis and opened nothing: each ran one fixed set of
// numbers. The commands have always taken a payload; nobody could type
// one, because the contract has no prompt and no dialog door. What it
// has is panels, so the parameters live in one — the Path Options panel
// (`panels/path-options-panel.tsx`), one section per operation — and
// this module is everything about it that is not React:
//
//   · THE VALUES. One typed record per section, its defaults (each the
//     number the command ran on before), and a sanitiser that turns
//     whatever storage holds into that record.
//
//   · LAST USED. `rememberPathOptions` — called by a section's Apply —
//     saves what was applied to `host.storage`: the bundle's namespaced
//     key/value store, which is the right home for this (it is app
//     state, like a dialog's remembered fields; it is not document
//     state, so not a container part, and not undoable). The existing
//     command ids, run with no payload, repeat those values: that is
//     the "apply again" lane, and with nothing ever applied it is
//     exactly the old behaviour.
//
//   · THE "…" COMMANDS. One per section. They RAISE the panel with that
//     section open; they mutate nothing. Raising is `host.shell.openPanel`
//     — the same cockpit action the `vectorGraphic` edit context's
//     `panelIds` goes through, reached imperatively. A panel id is all
//     that door takes, so WHICH section is said through a published
//     binding the panel listens to.
//
// ON A HOST THAT CANNOT RAISE A PANEL (`supports("shell.openPanel@1")`
// false — the headless harness, an older editor) a "…" command would be
// a dead menu row. It degrades to what the row did before the panel
// existed: it applies the operation with the last-used values, and says
// so in the log.
//
// IMAGE TRACE is not here. Its menu row still carries an ellipsis and
// still runs fixed options; its command file belongs to another change.
//
// STROKE DASHES ARE HERE, and that is a decision, not a convenience. The
// four dash presets (`commands/dash.ts`) were the only way to set a dash,
// because the Stroke panel is a SCHEMA panel and its binding ceiling is
// scalar — a dash array is a vector, so no schema row can bind it. The
// two homes left were a new React panel or a section here. Here wins:
// this panel already IS the stroke's typed-parameter form (Outline
// stroke's caps/joins/miter live in it), it already reads the first
// selected path's stroke on every reload, it already has the "…" door a
// menu row raises at a section, and a draft that survives reloads. A
// separate Dashes panel would copy all of that to hold six numbers, and
// put a third stroke surface in the dock beside Stroke and this one.
//
// ONE THING IS DIFFERENT about this section, and the panel says so: its
// values FOLLOW THE SELECTION. Every other section edits the parameters
// of an operation; this one edits a PROPERTY the selected path already
// has, so a selection change loads that path's own dash (read from the
// same property read Outline stroke uses — no extra round trip).

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

import {
  ARC_PARAM_DEFAULTS,
  POLAR_GRID_PARAM_DEFAULTS,
  RECT_GRID_PARAM_DEFAULTS,
  SPIRAL_PARAM_DEFAULTS,
  applyInsertArc,
  applyInsertPolarGrid,
  applyInsertRectGrid,
  applyInsertSpiral,
  arcParamsFrom,
  polarGridParamsFrom,
  rectGridParamsFrom,
  spiralParamsFrom,
  type ArcParams,
  type PolarGridParams,
  type RectGridParams,
  type SpiralParams,
} from "./insert-shapes";
import {
  DEFAULT_MITER_LIMIT,
  DEFAULT_OFFSET_DELTA_PT,
  DEFAULT_OUTLINE_WIDTH_PT,
  DEFAULT_SIMPLIFY_TOLERANCE_PT,
  applyOffsetPath,
  applyOutlineStroke,
  applySimplifyPath,
  type StrokeCapToken,
  type StrokeJoinToken,
} from "./path-ops";
import {
  applySelectSameStrokeWeight,
  MAX_STROKE_WEIGHT_TOLERANCE,
} from "./select-same";
import { applyDashArray, MAX_DASH_PAIRS } from "./dash";
import { applyReflect } from "./transform";
import { supportsPathOps } from "./path-ops";

export const PATH_OPTIONS_PANEL_ID = "media.paged.draw.panel.pathOptions";

export const PATH_OPTIONS_COMMAND_CATEGORY = "Path";

/** The sections, in panel order. */
export const PATH_OPTION_SECTIONS = [
  "offset",
  "simplify",
  "outlineStroke",
  "dash",
  "reflect",
  "arc",
  "spiral",
  "rectGrid",
  "polarGrid",
  "selectSameWeight",
] as const;

export type PathOptionSection = (typeof PATH_OPTION_SECTIONS)[number];

export const PATH_OPTION_SECTION_TITLES: Record<PathOptionSection, string> = {
  offset: "Offset path",
  simplify: "Simplify",
  outlineStroke: "Outline stroke",
  dash: "Stroke dashes",
  reflect: "Reflect",
  arc: "Insert arc",
  spiral: "Insert spiral",
  rectGrid: "Insert rectangular grid",
  polarGrid: "Insert polar grid",
  selectSameWeight: "Select same stroke weight",
};

/** The sections whose Apply acts on the SELECTION (the inserts need
 *  none). */
export const SELECTION_SECTIONS: ReadonlySet<PathOptionSection> = new Set([
  "offset",
  "simplify",
  "outlineStroke",
  "dash",
  "reflect",
  "selectSameWeight",
]);

/** Select same stroke weight — the one SELECTION verb here. Its
 *  tolerance is a stroke weight in pt (a colour cannot take one; see
 *  `commands/select-same.ts`). */
export interface SelectSameWeightOptions {
  /** pt, inclusive — 0 is the exact match the plain command makes. */
  tolerance: number;
}

export const STROKE_JOINS: readonly StrokeJoinToken[] = ["miter", "round", "bevel"];
export const STROKE_CAPS: readonly StrokeCapToken[] = ["butt", "round", "square"];

/** "Use what the element's own stroke says" — the Outline Stroke
 *  default for every key. */
export const FROM_ELEMENT = "element";

export interface OffsetOptions {
  /** pt — positive grows outward, negative shrinks. */
  delta: number;
  join: StrokeJoinToken;
  miterLimit: number;
}

/** What the Offset section says under its join fields, verbatim (pinned
 *  by a test). The join and the miter limit are on the `offsetPath` wire
 *  and this form sends them — but the engine's kernel does not read
 *  them: core `paged-mutate` `offset_closed_path(_join, _miter_limit)`
 *  bevels every OUTWARD corner whatever was asked ("round/miter joins
 *  are a follow-up"; measured in `test/oracle/offset-path.spec.ts`). The
 *  fields are offered because the choice is real on the wire and takes
 *  effect the day the kernel honours it; the sentence is there because
 *  until then a control that changes nothing must say so. */
/** Shown only on an engine OLDER than 0.65, whose offset bevelled every
 *  outward corner (core `offset_closed_path` took `_join` / `_miter_limit`).
 *  0.65.0 honours both — `test/oracle/offset-path.spec.ts` against
 *  Illustrator — and the same release added `duplicateElements`, which is
 *  how the panel tells the two apart (one vocabulary probe, shared with
 *  Reflect ▸ Copy). */
export const OFFSET_JOIN_NOTE =
  "This engine bevels every outward corner whatever join is chosen — " +
  "the join and the miter limit are sent with the offset and remembered, " +
  "and take effect on engine 0.65 or later.";

export interface SimplifyOptions {
  /** pt — the largest deviation a removed anchor may introduce. */
  tolerance: number;
}

/** Outline Stroke's overrides. Each key defaults to the ELEMENT's own
 *  stroke (the command reads it per element), so an untouched section
 *  outlines exactly what is rendered. */
export interface OutlineStrokeOptions {
  /** False (the default) = the element's own stroke weight. */
  overrideWidth: boolean;
  /** pt — used only when `overrideWidth`. */
  width: number;
  cap: StrokeCapToken | typeof FROM_ELEMENT;
  join: StrokeJoinToken | typeof FROM_ELEMENT;
  /** False (the default) = the element's own miter limit. */
  overrideMiterLimit: boolean;
  miterLimit: number;
}

/** STROKE DASHES — up to three dash/gap pairs, Illustrator's six
 *  fields. `dashed` off is a SOLID stroke whatever the fields hold (they
 *  are kept, so ticking it again restores them). A pair whose dash AND
 *  gap are both 0 is unused; the first pair is always used. */
export interface DashOptions {
  dashed: boolean;
  dash1: number;
  gap1: number;
  dash2: number;
  gap2: number;
  dash3: number;
  gap3: number;
}

/** REFLECT — the mirror axis' angle (degrees from +x, y down: 90 flips
 *  left ↔ right, 0 top ↔ bottom) and whether a COPY is reflected
 *  (`commands/transform.ts` — needs the engine's `duplicateElements`). */
export interface ReflectOptions {
  angleDeg: number;
  copy: boolean;
}

export interface PathOptions {
  offset: OffsetOptions;
  simplify: SimplifyOptions;
  outlineStroke: OutlineStrokeOptions;
  dash: DashOptions;
  reflect: ReflectOptions;
  arc: ArcParams;
  spiral: SpiralParams;
  rectGrid: RectGridParams;
  polarGrid: PolarGridParams;
  selectSameWeight: SelectSameWeightOptions;
}

/** What every section holds before anything is typed — each value the
 *  one its command ran on when it took no parameters. */
export const PATH_OPTIONS_DEFAULTS: PathOptions = {
  offset: {
    delta: DEFAULT_OFFSET_DELTA_PT,
    join: "miter",
    miterLimit: DEFAULT_MITER_LIMIT,
  },
  simplify: { tolerance: DEFAULT_SIMPLIFY_TOLERANCE_PT },
  outlineStroke: {
    overrideWidth: false,
    width: DEFAULT_OUTLINE_WIDTH_PT,
    cap: FROM_ELEMENT,
    join: FROM_ELEMENT,
    overrideMiterLimit: false,
    miterLimit: DEFAULT_MITER_LIMIT,
  },
  // The "Dashed" preset's 6 / 3, so ticking the box gives a dash at once.
  dash: { dashed: false, dash1: 6, gap1: 3, dash2: 0, gap2: 0, dash3: 0, gap3: 0 },
  reflect: { angleDeg: 90, copy: false },
  arc: ARC_PARAM_DEFAULTS,
  spiral: SPIRAL_PARAM_DEFAULTS,
  rectGrid: RECT_GRID_PARAM_DEFAULTS,
  polarGrid: POLAR_GRID_PARAM_DEFAULTS,
  selectSameWeight: { tolerance: 0.5 },
};

// --------------------------------------------------------- sanitising

type Loose = Record<string, unknown> | undefined;

const loose = (v: unknown): Loose =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

const oneOf = <T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
): T => (allowed.includes(v as T) ? (v as T) : fallback);

/** Whatever `raw` is — a stored record from an older build, a
 *  hand-edited one, nothing at all — as a complete `PathOptions`: every
 *  unreadable field is its default. */
export function sanitizePathOptions(raw: unknown): PathOptions {
  const r = loose(raw);
  const d = PATH_OPTIONS_DEFAULTS;
  const offset = loose(r?.offset);
  const simplify = loose(r?.simplify);
  const outline = loose(r?.outlineStroke);
  return {
    offset: {
      delta: num(offset?.delta, d.offset.delta),
      join: oneOf(offset?.join, STROKE_JOINS, d.offset.join),
      miterLimit: num(offset?.miterLimit, d.offset.miterLimit),
    },
    simplify: { tolerance: num(simplify?.tolerance, d.simplify.tolerance) },
    outlineStroke: {
      overrideWidth: bool(outline?.overrideWidth, d.outlineStroke.overrideWidth),
      width: num(outline?.width, d.outlineStroke.width),
      cap: oneOf(outline?.cap, [FROM_ELEMENT, ...STROKE_CAPS], d.outlineStroke.cap),
      join: oneOf(
        outline?.join,
        [FROM_ELEMENT, ...STROKE_JOINS],
        d.outlineStroke.join,
      ),
      overrideMiterLimit: bool(
        outline?.overrideMiterLimit,
        d.outlineStroke.overrideMiterLimit,
      ),
      miterLimit: num(outline?.miterLimit, d.outlineStroke.miterLimit),
    },
    dash: dashOptionsFrom(loose(r?.dash)),
    reflect: {
      angleDeg: num(loose(r?.reflect)?.angleDeg, d.reflect.angleDeg),
      copy: bool(loose(r?.reflect)?.copy, d.reflect.copy),
    },
    arc: arcParamsFrom(loose(r?.arc)),
    spiral: spiralParamsFrom(loose(r?.spiral)),
    rectGrid: rectGridParamsFrom(loose(r?.rectGrid)),
    polarGrid: polarGridParamsFrom(loose(r?.polarGrid)),
    selectSameWeight: {
      tolerance: Math.min(
        MAX_STROKE_WEIGHT_TOLERANCE,
        Math.max(
          0,
          num(loose(r?.selectSameWeight)?.tolerance, d.selectSameWeight.tolerance),
        ),
      ),
    },
  };
}

// -------------------------------------------------------------- dashes

const DASH_FIELDS = ["dash1", "gap1", "dash2", "gap2", "dash3", "gap3"] as const;

/** A stored / typed dash record, sanitised: a length is a finite number
 *  ≥ 0 (a negative one is 0), anything unreadable is its default. */
function dashOptionsFrom(raw: Loose): DashOptions {
  const d = PATH_OPTIONS_DEFAULTS.dash;
  const out: DashOptions = { ...d, dashed: bool(raw?.dashed, d.dashed) };
  for (const key of DASH_FIELDS) out[key] = Math.max(0, num(raw?.[key], d[key]));
  return out;
}

/** The engine's `lengths` for `o`: `[]` (solid) when not dashed or when
 *  every length is 0; otherwise the first pair and every later pair
 *  that is not 0 / 0, in order. Pure. */
export function dashLengthsOf(o: DashOptions): number[] {
  if (!o.dashed) return [];
  const clean = dashOptionsFrom(o as unknown as Loose);
  const pairs: [number, number][] = [
    [clean.dash1, clean.gap1],
    [clean.dash2, clean.gap2],
    [clean.dash3, clean.gap3],
  ];
  const out: number[] = [];
  pairs.forEach(([dash, gap], i) => {
    if (i === 0 || dash > 0 || gap > 0) out.push(dash, gap);
  });
  return out.every((n) => n === 0) ? [] : out;
}

/** What the section shows for a path whose dash array is `lengths`
 *  (null = unreadable, shown as solid). An ODD-length array repeats to
 *  even (the SVG/PDF dash rule); pairs past the third are not shown, and
 *  `hiddenPairs` says how many — the section puts that in front of the
 *  user, because an Apply rewrites the dash with the three it shows. */
export function dashOptionsFromLengths(
  lengths: readonly number[] | null,
  base: DashOptions = PATH_OPTIONS_DEFAULTS.dash,
): { options: DashOptions; hiddenPairs: number } {
  const values = (lengths ?? []).filter((n) => Number.isFinite(n) && n >= 0);
  if (values.length === 0 || values.every((n) => n === 0)) {
    return { options: { ...base, dashed: false }, hiddenPairs: 0 };
  }
  const even = values.length % 2 === 1 ? [...values, ...values] : values;
  const pairs = even.length / 2;
  const options: DashOptions = {
    dashed: true,
    dash1: even[0] ?? 0,
    gap1: even[1] ?? 0,
    dash2: even[2] ?? 0,
    gap2: even[3] ?? 0,
    dash3: even[4] ?? 0,
    gap3: even[5] ?? 0,
  };
  return { options, hiddenPairs: Math.max(0, pairs - MAX_DASH_PAIRS) };
}

/** The selection's paths — what a dash Apply writes to. */
export function dashTargetsOf(host: BundleHost) {
  return host.selection.get().filter(supportsPathOps);
}

// ----------------------------------------------------------- last used

/** The `host.storage` key the last-applied values live under. */
export const PATH_OPTIONS_STORAGE_KEY = "pathOptions.v1";

/** The stored record, untouched — `undefined` when nothing was ever
 *  applied or the store cannot be read. */
function storedPathOptions(host: BundleHost): Loose {
  try {
    return loose(host.storage.get<unknown>(PATH_OPTIONS_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

/** Every section's last-applied values (its defaults where none were). */
export function lastUsedPathOptions(host: BundleHost): PathOptions {
  return sanitizePathOptions(storedPathOptions(host));
}

/** Has `section` ever been applied from the panel? Decides whether a
 *  payload-free command repeats stored values or runs its original
 *  defaults untouched. */
export function hasLastUsed(host: BundleHost, section: PathOptionSection): boolean {
  return loose(storedPathOptions(host)?.[section]) !== undefined;
}

/** Save `values` as the last-used ones for `section`. Called by a
 *  section's Apply. A store that refuses the write loses the memory,
 *  never the operation. */
export function rememberPathOptions<S extends PathOptionSection>(
  host: BundleHost,
  section: S,
  values: PathOptions[S],
): void {
  try {
    host.storage.set(PATH_OPTIONS_STORAGE_KEY, {
      ...(storedPathOptions(host) ?? {}),
      [section]: values,
    });
  } catch (e) {
    host.log.debug(`path options: could not remember ${section} (${String(e)})`);
  }
}

// ------------------------------------------------------------ payloads
// A section's values as the payload its command takes.

export function offsetPayloadOf(o: OffsetOptions): Record<string, unknown> {
  return { delta: o.delta, join: o.join, miterLimit: o.miterLimit };
}

export function simplifyPayloadOf(o: SimplifyOptions): Record<string, unknown> {
  return { tolerance: o.tolerance };
}

/** Only the keys the user OVERRODE — an absent key is read from the
 *  element by `applyOutlineStroke`. */
export function outlineStrokePayloadOf(
  o: OutlineStrokeOptions,
): Record<string, unknown> {
  return {
    ...(o.overrideWidth ? { width: o.width } : {}),
    ...(o.cap !== FROM_ELEMENT ? { cap: o.cap } : {}),
    ...(o.join !== FROM_ELEMENT ? { join: o.join } : {}),
    ...(o.overrideMiterLimit ? { miterLimit: o.miterLimit } : {}),
  };
}

/** The payload a payload-free run of `section`'s command uses:
 *  `undefined` — the command's ORIGINAL defaults, bit for bit — until
 *  the section has been applied from the panel. */
export function lastUsedPayload(
  host: BundleHost,
  section: Exclude<
    PathOptionSection,
    "outlineStroke" | "selectSameWeight" | "dash" | "reflect"
  >,
): Record<string, unknown> | undefined {
  if (!hasLastUsed(host, section)) return undefined;
  const all = lastUsedPathOptions(host);
  switch (section) {
    case "offset":
      return offsetPayloadOf(all.offset);
    case "simplify":
      return simplifyPayloadOf(all.simplify);
    case "arc":
      return { ...all.arc };
    case "spiral":
      return { ...all.spiral };
    case "rectGrid":
      return { ...all.rectGrid };
    case "polarGrid":
      return { ...all.polarGrid };
  }
}

// --------------------------------------------------------------- apply

/** Run `section`'s operation with `values` and remember them as last
 *  used — what a section's Apply button does. */
export async function applyPathOptions<S extends PathOptionSection>(
  host: BundleHost,
  section: S,
  values: PathOptions[S],
): Promise<void> {
  rememberPathOptions(host, section, values);
  // `values` is `PathOptions[S]`; the switch below reads it back out of
  // a whole record so each arm gets its own section's type.
  const all: PathOptions = { ...PATH_OPTIONS_DEFAULTS, [section]: values };
  switch (section as PathOptionSection) {
    case "offset":
      await applyOffsetPath(host, offsetPayloadOf(all.offset));
      return;
    case "simplify":
      await applySimplifyPath(host, simplifyPayloadOf(all.simplify));
      return;
    case "outlineStroke":
      await applyOutlineStroke(host, outlineStrokePayloadOf(all.outlineStroke));
      return;
    case "dash":
      await applyDashArray(host, dashLengthsOf(all.dash), dashTargetsOf(host));
      return;
    case "reflect":
      await applyReflect(host, all.reflect.angleDeg, all.reflect.copy);
      return;
    case "arc":
      await applyInsertArc(host, { ...all.arc });
      return;
    case "spiral":
      await applyInsertSpiral(host, { ...all.spiral });
      return;
    case "rectGrid":
      await applyInsertRectGrid(host, { ...all.rectGrid });
      return;
    case "polarGrid":
      await applyInsertPolarGrid(host, { ...all.polarGrid });
      return;
    case "selectSameWeight":
      await applySelectSameStrokeWeight(host, all.selectSameWeight.tolerance);
      return;
  }
}

/** Run `section`'s operation with its last-used values — the lane a "…"
 *  command falls back to on a host that cannot raise a panel. */
async function applyLastUsed(
  host: BundleHost,
  section: PathOptionSection,
): Promise<void> {
  switch (section) {
    case "offset":
      await applyOffsetPath(host, lastUsedPayload(host, "offset"));
      return;
    case "simplify":
      await applySimplifyPath(host, lastUsedPayload(host, "simplify"));
      return;
    case "outlineStroke":
      // Bare Outline Stroke = the element's own stroke (path-ops.ts).
      await applyOutlineStroke(host);
      return;
    case "dash":
      await applyDashArray(
        host,
        dashLengthsOf(lastUsedPathOptions(host).dash),
        dashTargetsOf(host),
      );
      return;
    case "reflect": {
      const r = lastUsedPathOptions(host).reflect;
      await applyReflect(host, r.angleDeg, r.copy);
      return;
    }
    case "arc":
      await applyInsertArc(host, lastUsedPayload(host, "arc"));
      return;
    case "spiral":
      await applyInsertSpiral(host, lastUsedPayload(host, "spiral"));
      return;
    case "rectGrid":
      await applyInsertRectGrid(host, lastUsedPayload(host, "rectGrid"));
      return;
    case "polarGrid":
      await applyInsertPolarGrid(host, lastUsedPayload(host, "polarGrid"));
      return;
    case "selectSameWeight":
      // The "within…" row was chosen explicitly, so it may use the
      // remembered tolerance (the plain "Stroke weight" row never does).
      await applySelectSameStrokeWeight(
        host,
        lastUsedPathOptions(host).selectSameWeight.tolerance,
      );
      return;
  }
}

// --------------------------------------------------------------- focus

/** The published binding a "…" command names its section through.
 *  `shell.openPanel` takes a panel id and nothing else, so this is how
 *  "open the panel" becomes "open the panel AT Offset path". */
export const BIND_PATH_OPTIONS_FOCUS = "media.paged.draw.pathOptions.focus";

/** The binding's value. `seq` makes two requests for the same section
 *  two CHANGES (the panel re-opens a section the user has since
 *  collapsed). */
export interface PathOptionsFocus {
  section: PathOptionSection;
  seq: number;
}

/** The focus request currently published, if it is a well-formed one. */
export function pathOptionsFocusOf(
  host: Pick<BundleHost, "bindings">,
): PathOptionsFocus | null {
  const v = loose(host.bindings.get(BIND_PATH_OPTIONS_FOCUS));
  if (!v) return null;
  const section = v.section;
  if (!PATH_OPTION_SECTIONS.includes(section as PathOptionSection)) return null;
  return { section: section as PathOptionSection, seq: num(v.seq, 0) };
}

/** The host feature that says `shell.openPanel` reaches a real cockpit. */
export const OPEN_PANEL_FEATURE = "shell.openPanel@1";

/**
 * Raise the Path Options panel with `section` open. Answers whether the
 * host could raise it — false means nothing was shown and nothing was
 * published (the caller decides what a host with no panel door gets).
 */
export function showPathOptions(
  host: BundleHost,
  section: PathOptionSection,
): boolean {
  if (!host.supports(OPEN_PANEL_FEATURE)) return false;
  // Publish FIRST: a panel that is not mounted yet reads the request
  // when it mounts; one that is already open hears the change.
  const last = pathOptionsFocusOf(host);
  host.bindings.publish(BIND_PATH_OPTIONS_FOCUS, {
    section,
    seq: (last?.seq ?? 0) + 1,
  } satisfies PathOptionsFocus);
  host.shell.openPanel(PATH_OPTIONS_PANEL_ID);
  return true;
}

// ------------------------------------------------------------ commands

const C = "media.paged.draw.command";

/** The "…" command of each section — what the menu rows point at. */
export const PATH_OPTIONS_COMMANDS: Record<PathOptionSection, string> = {
  offset: `${C}.offsetPathOptions`,
  simplify: `${C}.simplifyPathOptions`,
  outlineStroke: `${C}.outlineStrokeOptions`,
  dash: `${C}.strokeDashOptions`,
  reflect: `${C}.reflectOptions`,
  arc: `${C}.insertArcOptions`,
  spiral: `${C}.insertSpiralOptions`,
  rectGrid: `${C}.insertRectGridOptions`,
  polarGrid: `${C}.insertPolarGridOptions`,
  selectSameWeight: `${C}.selectSameStrokeWeightOptions`,
};

/** The contributed command ids, in registration order. */
export const PATH_OPTIONS_COMMAND_IDS = PATH_OPTION_SECTIONS.map(
  (s) => PATH_OPTIONS_COMMANDS[s],
);

/** What a "…" command does: raise the panel at its section; on a host
 *  with no panel door, run the operation with its last-used values. */
export async function openPathOptions(
  host: BundleHost,
  section: PathOptionSection,
): Promise<void> {
  if (showPathOptions(host, section)) return;
  host.log.info(
    `${PATH_OPTIONS_COMMANDS[section]}: this host cannot raise a panel ` +
      `(${OPEN_PANEL_FEATURE}) — applying "${PATH_OPTION_SECTION_TITLES[section]}" ` +
      "with its last used values instead",
  );
  await applyLastUsed(host, section);
}

/** Register the "…" commands, one per section. */
export function contributePathOptionsCommands(host: BundleHost): Disposable {
  const disposers = PATH_OPTION_SECTIONS.map((section) =>
    host.contribute.command({
      id: PATH_OPTIONS_COMMANDS[section],
      title: `Path options: ${PATH_OPTION_SECTION_TITLES[section]}…`,
      category: PATH_OPTIONS_COMMAND_CATEGORY,
      handler: () => openPathOptions(host, section),
    }),
  );
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
