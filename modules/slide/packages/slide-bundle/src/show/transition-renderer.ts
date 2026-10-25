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

// The seam between the slide show and its transitions (slide ADR 716,
// ADR 721). A transition is drawn by a TransitionRenderer: WebGPU, one WGSL
// shader per PowerPoint transition kind (`p:fade`, `p14:vortex`, …), from
// the outgoing slide's texture to the incoming one's at a progress 0…1.
// The shader library (`./shaders/`) implements it and registers its
// factory here; until one is registered, or where the device has no
// WebGPU, the show draws a cross-fade (fade-like kinds) or a cut on its
// 2D canvas instead (compositor.ts).
//
// This module is the contract both sides build on: keep it free of any
// shader or DOM code.

/** Draws one frame of a transition into `target`. */
export interface TransitionRenderer {
  /** Whether this renderer has a shader for `kind` (a PowerPoint
   *  transition id such as `p:fade`). */
  supports(kind: string): boolean;
  render(opts: {
    kind: string;
    from: GPUTexture;
    to: GPUTexture;
    /** 0 shows `from`, 1 shows `to`. */
    progress: number;
    /** The kind's parameters (direction, …), by the manifest's names. */
    params?: Record<string, number>;
    target: GPUTextureView;
  }): void;
}

/** Makes a renderer on the show's device, for its canvas format. */
export type TransitionRendererFactory = (
  device: GPUDevice,
  format: GPUTextureFormat,
) => TransitionRenderer;

let factory: TransitionRendererFactory | null = null;

/** Register the shader library's factory (it calls this once, on import).
 *  Returns a function that unregisters it. */
export function registerTransitionRenderer(
  f: TransitionRendererFactory,
): () => void {
  factory = f;
  return () => {
    if (factory === f) factory = null;
  };
}

/** The registered factory, or null (the show then draws on 2D). */
export function transitionRendererFactory(): TransitionRendererFactory | null {
  return factory;
}

/** A transition as the slide stores it (the importer's names: `fade`,
 *  `push`, …, or an already qualified id), as the shader manifest's id. */
export function transitionKind(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return kind.includes(":") ? kind : `p:${kind}`;
}

/** PowerPoint's speeds when a transition carries no duration. */
const SPEED_MS: Record<string, number> = { fast: 500, med: 750, slow: 1000 };

/** How long a transition runs, ms: its duration, else its speed, else
 *  PowerPoint's default (0.7 s). */
export function transitionDurationMs(t: {
  durationMs?: number | null;
  speed?: string | null;
}): number {
  if (typeof t.durationMs === "number" && t.durationMs >= 0)
    return t.durationMs;
  return SPEED_MS[t.speed ?? ""] ?? 700;
}

/** Kinds the 2D path draws as a cross-fade rather than a cut. Every other
 *  kind cuts there; the shader library draws them all. */
export const FADE_LIKE: ReadonlySet<string> = new Set([
  "p:fade",
  "p:dissolve",
  "p14:flash",
  "p:random",
]);

/** The parameters a transition's direction maps to (`dir` as the deck
 *  writes it: l, r, u, d, …), for a shader manifest that reads
 *  `direction` (0 left, 1 right, 2 up, 3 down). */
export function transitionParams(
  dir: string | null | undefined,
): Record<string, number> {
  const d = { l: 0, r: 1, u: 2, d: 3 }[dir ?? ""];
  return d === undefined ? {} : { direction: d };
}
