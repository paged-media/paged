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

// Animations as the bundle sees them (slide ADR 714). The timing itself is
// the Rust side's (`pptx_core::anim::Timing`, read, edited, evaluated and
// written in slide-anim through the slide engine's `anim` door); here are
// only its JSON shapes and the names the show and the panes use for its
// targets. No PresentationML semantics live in TypeScript (CLAUDE.md).

/** A slide's `p:timing` as the engine models it. Opaque here: it is read
 *  and changed only through the engine. `nodes` empty: no animations. */
export interface Timing {
  nodes: unknown[];
  builds?: unknown[];
  extra?: string[];
}

/** A shape an animation names: the deck's `spid`, and the document's own
 *  names for it once imported (the page item's `Self` id, its shape key). */
export interface TargetRef {
  spid: string;
  item?: string | null;
  key?: string | null;
}

export type EffectClass = "entr" | "exit" | "emph" | "path" | string;
export type EffectStart = "click" | "with" | "after";

/** One effect of a slide's timing, as the Animation Pane lists it. */
export interface EffectInfo {
  index: number;
  target: TargetRef;
  /** The paragraph it animates (a build by paragraph), or null. */
  paragraph: number | null;
  /** It animates the shape without its text (`p:bg`). */
  bg: boolean;
  presetClass: EffectClass;
  presetId: number;
  presetSubtype: number;
  name: string;
  start: EffectStart;
  delayMs: number;
  durationMs: number;
  repeat: number | "indefinite" | null;
  /** Auto-reverse: it plays forwards, then backwards. */
  rewind: boolean;
  /** Rewind when done playing (`fill="remove"`): back to as it was. */
  rewindWhenDone?: boolean;
  smoothStart?: boolean;
  smoothEnd?: boolean;
  /** The shape whose click plays it (a trigger), or null. */
  trigger: TargetRef | null;
  /** 0: plays when the slide starts; n: after the nth click. */
  clickGroup: number;
  /** Where it runs within its click group, ms. */
  beginMs: number;
  endMs: number;
  /** The pane can change it (its structure is one the engine writes). */
  editable: boolean;
  /** Its motion path (slide fractions from where the shape stands). */
  path?: string;
  /** Path lock (`pathEditMode="fixed"`). */
  pathLocked?: boolean;
}

/** One segment of a motion path (slide-anim `path::Seg`): absolute slide
 *  fractions from where the shape stands. */
export type PathSeg =
  | { kind: "move"; to: [number, number] }
  | { kind: "line"; to: [number, number] }
  | {
      kind: "curve";
      c1: [number, number];
      c2: [number, number];
      to: [number, number];
    }
  | { kind: "close" };

export interface EffectList {
  effects: EffectInfo[];
  /** Clicks the main sequence takes before the slide advances. */
  clicks: number;
}

/** One preset of the effect gallery. */
export interface GalleryPreset {
  class: EffectClass;
  presetId: number;
  name: string;
  subtypes: { subtype: number; label: string }[];
  defaultSubtype: number;
}

/** An edit of a slide's timing (slide-anim `author`). */
export type TimingEdit =
  | {
      kind: "add";
      target: TargetRef | { item: string; key?: string | null; spid?: string };
      presetClass: EffectClass;
      presetId: number;
      presetSubtype?: number;
      start?: EffectStart;
      durationMs?: number;
      delayMs?: number;
      /** Build by paragraph over this many paragraphs. */
      paragraphs?: number;
      /** The shape has text (PowerPoint lists it in the build list). */
      hasText?: boolean;
      trigger?: TargetRef;
      at?: number;
    }
  | { kind: "remove"; index: number }
  | { kind: "move"; from: number; to: number }
  | {
      kind: "timing";
      index: number;
      start?: EffectStart;
      durationMs?: number;
      delayMs?: number;
      repeat?: number | "indefinite" | null;
      rewind?: boolean;
      rewindWhenDone?: boolean;
      smoothStart?: boolean;
      smoothEnd?: boolean;
      trigger?: TargetRef | null;
    }
  | { kind: "option"; index: number; presetSubtype: number }
  | {
      kind: "change";
      index: number;
      presetClass: EffectClass;
      presetId: number;
      presetSubtype?: number;
    }
  | { kind: "paint"; from: TargetRef; to: TargetRef }
  | { kind: "path"; index: number; path?: string; locked?: boolean };

/** A layer's state at one moment (slide-anim `LayerState`): about the
 *  layer's own centre, then moved by (dx, dy) pt. */
export interface LayerState {
  visible: boolean;
  opacity: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  /** Degrees, clockwise. */
  rot: number;
  skewX?: number;
  skewY?: number;
  mask?: {
    filter: string;
    sub: string | null;
    progress: number;
    out: boolean;
  } | null;
  fill?: string | null;
  line?: string | null;
  text?: string | null;
  textStyle?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    size?: number;
  } | null;
}

/** What the player answers for one moment. */
export interface PlayerFrame {
  layers: Record<string, LayerState>;
  /** Something animates at this moment (keep drawing frames). */
  running: boolean;
  /** When the state next changes without input, ms; null: never. */
  nextChange: number | null;
  /** Media commands due (play, pause, stop): no-ops until media lands. */
  commands: { target: string; cmd: string; at: number }[];
}

/** An input to the player: a main-sequence click (`next`) or a click on a
 *  shape (`click`, for triggers), at `at` ms after the slide started. */
export interface PlayerEvent {
  kind: "next" | "click";
  at: number;
  target?: string;
}

/** A box in page pt. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlayerInput {
  timing: Timing;
  slide: { w: number; h: number };
  /** Each layer key's box (the shape's, a paragraph's), page pt. */
  boxes: Record<string, Box>;
  /** Theme colours by scheme name (`accent1` → `4472C4`), for colour
   *  effects that name them. */
  theme?: Record<string, string>;
}

export const IDENTITY_STATE: LayerState = {
  visible: true,
  opacity: 1,
  dx: 0,
  dy: 0,
  sx: 1,
  sy: 1,
  rot: 0,
};

/** The name the show and the player use for a target: the page item it
 *  became, else its shape key, else the deck's spid. */
export function targetId(t: TargetRef): string {
  if (t.item) return t.item;
  if (t.key) return `key:${t.key}`;
  return `spid:${t.spid}`;
}

/** A layer key split into its target and the part of it: the whole shape,
 *  its background (the shape without its text), or one paragraph. */
export function splitLayerKey(key: string): {
  target: string;
  part: "whole" | "bg" | number;
} {
  const hash = key.lastIndexOf("#");
  if (hash < 0) return { target: key, part: "whole" };
  const target = key.slice(0, hash);
  const rest = key.slice(hash + 1);
  if (rest === "bg") return { target, part: "bg" };
  const p = /^p(\d+)$/.exec(rest);
  if (p) return { target, part: Number(p[1]) };
  // A character range plays as its paragraph (`#c<st>-<end>`): the show
  // has paragraph layers, not character ones.
  return { target, part: "whole" };
}

/** Whether a timing has any animation. */
export function hasAnimations(t: Timing | null | undefined): t is Timing {
  return !!t && Array.isArray(t.nodes) && t.nodes.length > 0;
}
