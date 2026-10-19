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
  type PropsWithChildren,
} from "react";

import { IDENTITY_CAMERA, type Camera } from "@paged-media/client";

import { useCanvasClient } from "./canvas-client-context";
import { clampCamera } from "./zoom-range";

export type ViewportSize = readonly [number, number];

interface CameraContextValue {
  camera: Camera;
  setCamera: (cam: Camera) => void;
  viewportSize: ViewportSize;
  setViewportSize: (size: ViewportSize) => void;
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
  const setCamera = useCallback(
    (requested: Camera) => {
      const cam = clampCamera(requested, sizeRef.current);
      setCameraState(cam);
      client.setCamera(cam);
    },
    [client],
  );

  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const value = useMemo<CameraContextValue>(
    () => ({ camera, setCamera, viewportSize, setViewportSize }),
    [camera, setCamera, viewportSize, setViewportSize],
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
