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
// shader per PowerPoint transition kind, from the outgoing slide's texture
// to the incoming one's at a progress 0…1. The shader library
// (`./shaders/`) is the default renderer; a test or an embedder can
// register another. On a device without WebGPU the show cuts and says so
// once (compositor.ts).

import {
  createTransitionRenderer,
  resolveTransition,
} from "./shaders/index.js";

/** Draws one frame of a transition into `target`. */
export interface TransitionRenderer {
  /** Whether this renderer has a shader for `kind` (a PowerPoint
   *  transition kind, or a key `resolveTransition` answered). */
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

/** Register another renderer factory in place of the shader library's.
 *  Returns a function that restores the library. */
export function registerTransitionRenderer(
  f: TransitionRendererFactory,
): () => void {
  factory = f;
  return () => {
    if (factory === f) factory = null;
  };
}

/** The renderer factory: a registered one, else the shader library. */
export function transitionRendererFactory(): TransitionRendererFactory {
  return factory ?? createTransitionRenderer;
}

/** A slide's transition as the shader to run: the manifest's key and its
 *  parameters, read from the kind, the direction and the deck's own
 *  element (its effect options). Null for no transition or an unknown
 *  kind (the show cuts). */
export function resolveShowTransition(
  t:
    | {
        kind?: string | null;
        dir?: string | null;
        xml?: string | null;
      }
    | null
    | undefined,
): { kind: string; params: Record<string, number> } | null {
  if (!t?.kind) return null;
  const r = resolveTransition({ kind: t.kind, dir: t.dir, xml: t.xml });
  return r ? { kind: r.kind, params: r.params } : null;
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
