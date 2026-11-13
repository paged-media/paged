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

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { IDENTITY_CAMERA, type Camera } from "@paged-media/client";

import { useCanvasClient } from "./canvas-client-context";
import {
  createNavigationHistory,
  type NavigationHistory,
  type NavigationHistoryState,
} from "./navigation-history";
import { clampCamera } from "./zoom-range";

export type ViewportSize = readonly [number, number];

interface CameraContextValue {
  camera: Camera;
  setCamera: (cam: Camera) => void;
  viewportSize: ViewportSize;
  setViewportSize: (size: ViewportSize) => void;
  /** The viewport was resized from `from` to `to` (a dock opened, closed
   *  or was dragged; the window changed): keep the document point at its
   *  centre where it was (UXI-CAM-003, UXI-PNL-007). The canvas's
   *  ResizeObserver calls it. */
  anchorViewportResize: (from: ViewportSize, to: ViewportSize) => void;
  /** The camera last written, at once: a frame of a tween or a wheel
   *  step that React has not rendered yet included. What a navigation
   *  records as the place it left, and where a tween starts from. */
  peekCamera: () => Camera;
  /** Counts the camera's writes. A tween compares it with the count after
   *  its own last frame: a write in between was someone else's (a wheel,
   *  a pan, another command), who now owns the camera, and the tween stops
   *  rather than tug the view back (UXI-CAM-004). */
  cameraRevision: () => number;
  /** This editor's Back / Forward places (`navigation-history.ts`). */
  navigation: NavigationHistory;
}

/**
 * `cam` for a viewport resized from `from` to `to` with the document point
 * at the viewport's centre kept there: a translation by half the change,
 * the same at any zoom and any view rotation. No fit, no zoom: a dock that
 * opens or a window that narrows never re-fits the document. Unchanged for
 * an unmeasured or collapsed (hidden) size on either side.
 */
export function cameraKeepingCentre(
  cam: Camera,
  from: ViewportSize,
  to: ViewportSize,
): Camera {
  if (!(from[0] > 0 && from[1] > 0 && to[0] > 0 && to[1] > 0)) return cam;
  const dx = (to[0] - from[0]) / 2;
  const dy = (to[1] - from[1]) / 2;
  if (dx === 0 && dy === 0) return cam;
  return { ...cam, tx: cam.tx + dx, ty: cam.ty + dy };
}

const Context = createContext<CameraContextValue | null>(null);

/**
 * Owns the viewport camera (scale + translation) and the measured
 * size of its host element. `setCamera` writes through to the
 * client's SAB so the worker sees the new transform on its next
 * frame; React state mirrors the value so the viewport's CSS
 * transform re-renders in the same tick. Every write is held inside the
 * one zoom range (`zoom-range.ts`, ADR 246).
 */
export function CameraProvider({ children }: PropsWithChildren) {
  const client = useCanvasClient();
  const [camera, setCameraState] = useState<Camera>(IDENTITY_CAMERA);
  const [viewportSize, setViewportSizeState] = useState<ViewportSize>([0, 0]);
  // The size the clamp zooms about, read inside `setCamera` without
  // making the setter change identity on every resize.
  const sizeRef = useRef<ViewportSize>([0, 0]);
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const setViewportSize = useCallback((size: ViewportSize) => {
    sizeRef.current = size;
    setViewportSizeState(size);
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  // v77 (editor ADR 287) — a camera written without a rotation keeps the
  // view's: a pan or a zoom about a point is the same formula at any
  // rotation, so the writers that never heard of Rotate View stay right.
  const rotationRef = useRef(0);
  // The camera last written, for the resize anchor: `setCamera` is its one
  // writer, so it is current without a render.
  const cameraRef = useRef<Camera>(IDENTITY_CAMERA);
  const revisionRef = useRef(0);
  const setCamera = useCallback(
    (requested: Camera) => {
      const rotation = requested.rotation ?? rotationRef.current;
      rotationRef.current = rotation;
      const cam = { ...clampCamera(requested, sizeRef.current), rotation };
      cameraRef.current = cam;
      revisionRef.current += 1;
      setCameraState(cam);
      client.setCamera(cam);
    },
    [client],
  );

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const anchorViewportResize = useCallback(
    (from: ViewportSize, to: ViewportSize) => {
      const cam = cameraRef.current;
      const next = cameraKeepingCentre(cam, from, to);
      if (next !== cam) setCamera(next);
    },
    [setCamera],
  );

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const peekCamera = useCallback(() => cameraRef.current, []);
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const cameraRevision = useCallback(() => revisionRef.current, []);
  // One history per editor, for the provider's lifetime.
  const [navigation] = useState(createNavigationHistory);

  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const value = useMemo<CameraContextValue>(
    () => ({
      camera,
      setCamera,
      viewportSize,
      setViewportSize,
      anchorViewportResize,
      peekCamera,
      cameraRevision,
      navigation,
    }),
    [
      camera,
      setCamera,
      viewportSize,
      setViewportSize,
      anchorViewportResize,
      peekCamera,
      cameraRevision,
      navigation,
    ],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCamera(): CameraContextValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error("useCamera called outside CameraProvider");
  }
  return ctx;
}

/** How many places Back and Forward hold in this editor, re-rendering
 *  when it changes (the Back / Forward buttons' enabled state). */
export function useNavigationHistoryState(): NavigationHistoryState {
  const { navigation } = useCamera();
  return useSyncExternalStore(
    navigation.subscribe,
    navigation.state,
    navigation.state,
  );
}
