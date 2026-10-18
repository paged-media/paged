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

// The pointer TAPE: a recorded input stream, replayable through any
// gesture backend (the unit backend against a fake or headless editor,
// the browser backend against the running editor).
//
// Format v1 follows the editor's gesture test plan (gestures.md,
// Appendix A): a version, an optional fixture reference, the viewport,
// and the samples in order. Positions are DOCUMENT points
// (`coords: "doc"`), so a tape replays at any zoom; `viewport.zoom` is
// the zoom it was recorded at, which matters for click-vs-drag (the
// threshold is in screen px).
//
// Each pointer sample may carry the `coalesced` sub-samples the browser
// delivered with it (`PointerEvent.getCoalescedEvents()`). The editor
// reads only the main event today, so the backends deliver the main
// sample and ignore the coalesced ones unless asked to expand them.
//
// REPLAY IS ORDER-PRESERVING, NOT TIME-PRESERVING. `t` (ms since the
// tape began) is recorded for diagnosis and for a future time-aware
// handler; the replay never sleeps on it. A gesture whose outcome
// depended on wall time would be a determinism bug (gestures.md R4).

/** A modifier, as the DSL and the tape name it. `cmd` is Meta. */
export type ModifierName = "shift" | "alt" | "cmd" | "ctrl";

/** Pointer Events `pointerType`. */
export type PointerDevice = "mouse" | "pen" | "touch";

export const MODIFIER_NAMES: readonly ModifierName[] = [
  "shift",
  "alt",
  "cmd",
  "ctrl",
];

export interface PointerTapeSample {
  t: number;
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  /** Document pt. */
  pos: [number, number];
  /** The button that changed (0 primary, 2 secondary). */
  button: number;
  /** The buttons held after this event (Pointer Events bitmask). */
  buttons: number;
  mods: ModifierName[];
  device: PointerDevice;
  pointerId: number;
  /** 0..1, Pointer Events semantics. */
  pressure: number;
  tiltX: number;
  tiltY: number;
  coalesced?: Array<{ t: number; pos: [number, number]; pressure?: number }>;
}

export interface KeyTapeSample {
  t: number;
  type: "keydown" | "keyup";
  /** `KeyboardEvent.key` ("Escape", "ArrowRight", "a"). */
  key: string;
  mods: ModifierName[];
}

export interface WheelTapeSample {
  t: number;
  type: "wheel";
  pos: [number, number];
  /** CSS px, `deltaMode` 0. */
  deltaX: number;
  deltaY: number;
  mods: ModifierName[];
}

/** A double-click: the whole down/up/down/up/dblclick run at one point. */
export interface DblclickTapeSample {
  t: number;
  type: "dblclick";
  pos: [number, number];
  mods: ModifierName[];
}

/** The tool switched (`id` as registered). */
export interface ToolTapeSample {
  t: number;
  type: "tool";
  tool: string;
}

/** The camera zoom was set (CSS px per pt). */
export interface ZoomTapeSample {
  t: number;
  type: "zoom";
  scale: number;
}

export type TapeSample =
  | PointerTapeSample
  | KeyTapeSample
  | WheelTapeSample
  | DblclickTapeSample
  | ToolTapeSample
  | ZoomTapeSample;

export interface PointerTape {
  version: 1;
  name?: string;
  /** Free-form reference to the document the tape was recorded on. */
  fixture?: string;
  coords: "doc";
  viewport?: { zoom: number; pan?: [number, number]; dpr?: number };
  samples: TapeSample[];
  /** What the recording expects; free-form, conventionally `committed`
   *  (boolean), `undoSteps` (number) and `modelDigest` (string). */
  expect?: Record<string, unknown>;
}

/** A tape problem, with the JSON path of the offending value. */
export class TapeFormatError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`pointer tape ${path}: ${message}`);
    this.name = "TapeFormatError";
  }
}

const POINTER_TYPES = new Set([
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
]);
const DEVICES = new Set(["mouse", "pen", "touch"]);

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isPt = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

function checkMods(v: unknown, path: string): ModifierName[] {
  if (!Array.isArray(v))
    throw new TapeFormatError(path, "mods must be an array");
  for (const [i, m] of v.entries()) {
    if (!MODIFIER_NAMES.includes(m as ModifierName)) {
      throw new TapeFormatError(
        `${path}[${i}]`,
        `unknown modifier ${JSON.stringify(m)}`,
      );
    }
  }
  return v as ModifierName[];
}

/** Check a parsed tape and return it typed; throws a {@link TapeFormatError}
 *  naming the first bad value. */
export function validateTape(value: unknown): PointerTape {
  if (!value || typeof value !== "object")
    throw new TapeFormatError("$", "not an object");
  const tape = value as Record<string, unknown>;
  if (tape.version !== 1) throw new TapeFormatError("$.version", "must be 1");
  if (tape.coords !== "doc")
    throw new TapeFormatError("$.coords", 'must be "doc"');
  if (tape.viewport !== undefined) {
    const vp = tape.viewport as Record<string, unknown>;
    if (!vp || !isNum(vp.zoom) || vp.zoom <= 0) {
      throw new TapeFormatError("$.viewport.zoom", "must be a positive number");
    }
  }
  if (!Array.isArray(tape.samples))
    throw new TapeFormatError("$.samples", "must be an array");
  let lastT = -Infinity;
  tape.samples.forEach((raw, i) => {
    const path = `$.samples[${i}]`;
    if (!raw || typeof raw !== "object")
      throw new TapeFormatError(path, "not an object");
    const s = raw as Record<string, unknown>;
    if (!isNum(s.t)) throw new TapeFormatError(`${path}.t`, "must be a number");
    // Recorded streams can carry equal timestamps; they never run backwards.
    if (s.t < lastT)
      throw new TapeFormatError(`${path}.t`, "timestamps must not decrease");
    lastT = s.t;
    const type = s.type;
    if (POINTER_TYPES.has(type as string)) {
      if (!isPt(s.pos))
        throw new TapeFormatError(`${path}.pos`, "must be [x, y]");
      for (const k of [
        "button",
        "buttons",
        "pointerId",
        "pressure",
        "tiltX",
        "tiltY",
      ]) {
        if (!isNum(s[k]))
          throw new TapeFormatError(`${path}.${k}`, "must be a number");
      }
      if (!DEVICES.has(s.device as string)) {
        throw new TapeFormatError(
          `${path}.device`,
          "must be mouse, pen or touch",
        );
      }
      checkMods(s.mods, `${path}.mods`);
      if (s.coalesced !== undefined) {
        if (!Array.isArray(s.coalesced)) {
          throw new TapeFormatError(`${path}.coalesced`, "must be an array");
        }
        s.coalesced.forEach((c, j) => {
          const cc = c as Record<string, unknown>;
          if (!isNum(cc?.t) || !isPt(cc?.pos)) {
            throw new TapeFormatError(
              `${path}.coalesced[${j}]`,
              "needs t and pos",
            );
          }
        });
      }
    } else if (type === "keydown" || type === "keyup") {
      if (typeof s.key !== "string" || s.key === "") {
        throw new TapeFormatError(`${path}.key`, "must be a non-empty string");
      }
      checkMods(s.mods, `${path}.mods`);
    } else if (type === "wheel") {
      if (!isPt(s.pos))
        throw new TapeFormatError(`${path}.pos`, "must be [x, y]");
      if (!isNum(s.deltaX) || !isNum(s.deltaY)) {
        throw new TapeFormatError(path, "wheel needs deltaX and deltaY");
      }
      checkMods(s.mods, `${path}.mods`);
    } else if (type === "dblclick") {
      if (!isPt(s.pos))
        throw new TapeFormatError(`${path}.pos`, "must be [x, y]");
      checkMods(s.mods, `${path}.mods`);
    } else if (type === "tool") {
      if (typeof s.tool !== "string" || s.tool === "") {
        throw new TapeFormatError(`${path}.tool`, "must be a tool id");
      }
    } else if (type === "zoom") {
      if (!isNum(s.scale) || s.scale <= 0) {
        throw new TapeFormatError(`${path}.scale`, "must be a positive number");
      }
    } else {
      throw new TapeFormatError(
        `${path}.type`,
        `unknown sample type ${JSON.stringify(type)}`,
      );
    }
  });
  return value as PointerTape;
}

/** Parse and validate a tape from JSON text. */
export function parseTape(text: string): PointerTape {
  return validateTape(JSON.parse(text));
}

/** The canonical JSON of a tape (two-space indent, trailing newline), so
 *  a committed tape diffs line by line. */
export function serializeTape(tape: PointerTape): string {
  return `${JSON.stringify(validateTape(tape), null, 2)}\n`;
}

/** What a tape replays through: a gesture backend (unit or browser). */
export interface TapeReplayTarget {
  tool(id: string): Promise<unknown>;
  pointer(sample: PointerTapeSample): Promise<void>;
  key(sample: KeyTapeSample): Promise<void>;
  wheel(sample: WheelTapeSample): Promise<void>;
  dblclick(sample: DblclickTapeSample): Promise<void>;
  zoom?(scale: number): Promise<void>;
  settle(): Promise<void>;
}

export interface ReplayOptions {
  /** Deliver each pointer sample's `coalesced` sub-samples as moves
   *  before it. Default false: the editor reads only the main event. */
  expandCoalesced?: boolean;
  /** Set the recorded zoom before the first sample. Default true. */
  applyViewport?: boolean;
}

/** Replay `tape` through `target`, in order, then settle. */
export async function replayTape(
  tape: PointerTape,
  target: TapeReplayTarget,
  options: ReplayOptions = {},
): Promise<void> {
  validateTape(tape);
  if ((options.applyViewport ?? true) && tape.viewport && target.zoom) {
    await target.zoom(tape.viewport.zoom);
  }
  for (const s of tape.samples) {
    switch (s.type) {
      case "tool":
        // A tool the recording mounted as an object (no id) keeps the
        // tool the replay target has mounted.
        if (!s.tool.startsWith("inline:")) await target.tool(s.tool);
        break;
      case "zoom":
        if (!target.zoom)
          throw new Error("replay: this backend cannot set the zoom");
        await target.zoom(s.scale);
        break;
      case "keydown":
      case "keyup":
        await target.key(s);
        break;
      case "wheel":
        await target.wheel(s);
        break;
      case "dblclick":
        await target.dblclick(s);
        break;
      default:
        if (options.expandCoalesced && s.coalesced) {
          for (const c of s.coalesced) {
            await target.pointer({
              ...s,
              type: "pointermove",
              t: c.t,
              pos: c.pos,
              pressure: c.pressure ?? s.pressure,
              coalesced: undefined,
            });
          }
        }
        await target.pointer(s);
    }
  }
  await target.settle();
}
