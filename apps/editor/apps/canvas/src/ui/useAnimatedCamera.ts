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

// rAF-driven camera tween.
//
// Discrete jumps (navigator click → fit-to-page, Ctrl+0 → fit-to-doc,
// Ctrl+1 → 100% zoom) feel snappy when animated over ~200 ms with a
// cubic ease-out; pan/zoom from input stays instantaneous because
// every frame is already at the correct position.
//
// The hook exposes `animateTo(target, opts?)` that cancels any
// in-flight animation and starts a new one. The actual frame-by-frame
// camera updates flow through the same `setCamera` callback the
// caller uses for direct writes — so the SAB stays the single
// source of truth for the worker.
//
// `useCameraTween` also answers where the camera is heading
// (`destination()`): the in-flight tween's target, or the camera itself
// when none runs. A command that steps from "the page in view" (the page
// keys, the fits) asks it, so a key pressed while the last one is still
// travelling steps from where that one is going, not from a frame of it.
//
// The interaction contract (editor ADR "Navigation history and one
// current page"):
// - UXI-CAM-005: with `prefers-reduced-motion: reduce` a tween jumps to
//   its target in one write: the same final view, no motion.
// - UXI-CAM-004: a tween yields to whoever moves the camera next. Each
//   frame checks the camera context's write count against the count after
//   its own last write; a wheel step, a pan or another command in between
//   took the camera, and the tween stops where that write left it instead
//   of tugging the view back. A resize is not one of them (UXI-CAM-003):
//   its anchor moves the view by a translation, and the tween moves its
//   whole path by the same shift and carries on (`anchorShift`).
// - UXI-CAM-016: `record: true` makes the jump an explicit navigation:
//   the place it leaves (where the camera is heading, so two quick jumps
//   record the first one's target) becomes the editor's Back entry.
//   `useAnimatedCamera`, the panels' jump, records by default.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Camera } from "@paged-media/client";
import { useCamera } from "@paged-media/shell";

export interface AnimateOptions {
  durationMs?: number;
  /** An explicit navigation: the place it leaves becomes a Back entry. */
  record?: boolean;
}

const DEFAULT_DURATION_MS = 220;

/** Does the user ask for reduced motion (the OS setting, read at each
 *  call so a change applies at once)? */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/** The panels' jump: a tween that records the place it leaves for Back
 *  (an explicit navigation) unless told `record: false`. */
export function useAnimatedCamera(
  current: Camera,
  setCamera: (cam: Camera) => void,
) {
  const { animateTo } = useCameraTween(current, setCamera);
  return (target: Camera, opts: AnimateOptions = {}) =>
    animateTo(target, { record: true, ...opts });
}

/** The tween, and where the camera is heading. `_current` is unused: the
 *  tween starts from the camera context's last write, which a rendered
 *  value lags by a frame. */
export function useCameraTween(
  _current: Camera,
  setCamera: (cam: Camera) => void,
) {
  const { peekCamera, cameraRevision, anchorShift, navigation } = useCamera();
  const rafRef = useRef<number | null>(null);
  // The in-flight tween's target and the resize anchors' shift when it
  // began; null when none runs.
  const goalRef = useRef<Goal | null>(null);
  // Track the latest `setCamera` + the context's readers via refs so the
  // animation callback always reads fresh values without
  // re-subscribing. Written after each commit (a layout effect, so before
  // any input that could start a tween); a ref written during render
  // keeps the hook uncompiled (ADR 229). Not an effect event: the tween
  // starts from event handlers.
  const setCameraRef = useRef(setCamera);
  const peekRef = useRef(peekCamera);
  const revisionRef = useRef(cameraRevision);
  const shiftRef = useRef(anchorShift);
  const navigationRef = useRef(navigation);
  useLayoutEffect(() => {
    setCameraRef.current = setCamera;
    peekRef.current = peekCamera;
    revisionRef.current = cameraRevision;
    shiftRef.current = anchorShift;
    navigationRef.current = navigation;
  });

  // Cancel any in-flight tween on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      goalRef.current = null;
    };
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- a hook's result, which callers may compare (ADR 229)
  const animateTo = useCallback((target: Camera, opts: AnimateOptions = {}) => {
    const duration = prefersReducedMotion()
      ? 0
      : (opts.durationMs ?? DEFAULT_DURATION_MS);
    // Where the camera was heading: the place an explicit navigation
    // leaves (a jump pressed during the last one's tween leaves its target).
    if (opts.record)
      navigationRef.current.record(
        goalOf(goalRef.current, shiftRef.current()) ?? peekRef.current(),
        target,
      );
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    goalRef.current = null;
    // The camera as last written: a frame React has not rendered yet
    // included.
    const start = peekRef.current();
    // No-op if already at target (within float tolerance).
    if (
      nearly(start.scale, target.scale) &&
      nearly(start.tx, target.tx) &&
      nearly(start.ty, target.ty) &&
      nearly(start.rotation ?? 0, target.rotation ?? start.rotation ?? 0)
    ) {
      return;
    }
    // Trivial duration → snap.
    if (duration <= 16) {
      setCameraRef.current(target);
      return;
    }
    // The resize anchors before the tween began; one since then moved the
    // view, and the path moves with it.
    const [sx0, sy0] = shiftRef.current();
    goalRef.current = { target, shift: [sx0, sy0] };
    const t0 = performance.now();
    // The write count after this tween's own last write: anything else
    // means someone else took the camera (UXI-CAM-004).
    let own = revisionRef.current();
    const step = (now: number) => {
      if (revisionRef.current() !== own) {
        rafRef.current = null;
        goalRef.current = null;
        return;
      }
      const [sx, sy] = shiftRef.current();
      const dx = sx - sx0;
      const dy = sy - sy0;
      const t = Math.min(1, (now - t0) / duration);
      const eased = easeOutCubic(t);
      setCameraRef.current({
        scale: lerp(start.scale, target.scale, eased),
        tx: lerp(start.tx, target.tx, eased) + dx,
        ty: lerp(start.ty, target.ty, eased) + dy,
        // v77 — Rotate View turns with the tween; a target without a
        // rotation keeps the view's.
        rotation: lerp(
          start.rotation ?? 0,
          target.rotation ?? start.rotation ?? 0,
          eased,
        ),
      });
      own = revisionRef.current();
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        goalRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);
  // eslint-disable-next-line no-restricted-syntax -- a hook's result, which callers may compare (ADR 229)
  const destination = useCallback(
    (): Camera =>
      goalOf(goalRef.current, shiftRef.current()) ?? peekRef.current(),
    [],
  );

  return { animateTo, destination };
}

interface Goal {
  target: Camera;
  shift: readonly [number, number];
}

/** Where a tween is going now: its target moved by the resize anchors
 *  since it began. */
function goalOf(
  goal: Goal | null,
  [sx, sy]: readonly [number, number],
): Camera | null {
  if (!goal) return null;
  const dx = sx - goal.shift[0];
  const dy = sy - goal.shift[1];
  return dx === 0 && dy === 0
    ? goal.target
    : { ...goal.target, tx: goal.target.tx + dx, ty: goal.target.ty + dy };
}

function easeOutCubic(t: number): number {
  const k = 1 - t;
  return 1 - k * k * k;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function nearly(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) < eps;
}
