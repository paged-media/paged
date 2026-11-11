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

// W2.3 (sheet ADR 526) — the decoded images of the pictures a grid scene
// shows. The bytes come from the session by media part name; each is
// decoded once (createImageBitmap) and kept while the surface lives. A
// picture with corrections is drawn through the engine's filter stack
// (engine ADR 1037: the ops the page draws it with, evaluated by the engine
// wasm), kept under its `pictureKey`. The returned revision moves when an
// image arrives, so the painter runs again.

import { useEffect, useRef, useState } from "react";

import { pictureKey, type GridScene } from "@paged-media/sheet-host-model";
import type { RasterOp } from "@paged-media/plugin-api";

type Decoded = ImageBitmap;

/** The engine's filter stack over straight RGBA pixels; null where the
 *  engine cannot (the picture is then drawn as stored). */
export type AdjustPicture = (
  rgba: Uint8Array,
  width: number,
  height: number,
  ops: readonly RasterOp[],
) => Uint8Array | null;

/** `img` run through `ops` by the engine, or `img` itself where the realm
 *  has no 2D canvas to read its pixels or the engine declines. */
async function corrected(
  img: ImageBitmap,
  ops: readonly RasterOp[],
  adjust: AdjustPicture,
): Promise<ImageBitmap> {
  if (typeof OffscreenCanvas !== "function") return img;
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext("2d");
  if (!g) return img;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, img.width, img.height);
  const out = adjust(
    new Uint8Array(data.data.buffer),
    img.width,
    img.height,
    ops,
  );
  if (!out || out.length !== data.data.length) return img;
  const next = await createImageBitmap(
    new ImageData(new Uint8ClampedArray(out), img.width, img.height),
  );
  img.close();
  return next;
}

export function usePictureImages(
  scene: Pick<GridScene, "pictures"> | null,
  bytesOf: (media: string) => Uint8Array | null,
  adjust?: AdjustPicture,
): {
  revision: number;
  imageOf: (key: string) => Decoded | undefined;
} {
  const cache = useRef(new Map<string, Decoded | "pending" | "failed">());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (typeof createImageBitmap !== "function") return;
    let live = true;
    for (const p of scene?.pictures ?? []) {
      const key = pictureKey(p);
      if (cache.current.has(key)) continue;
      const bytes = bytesOf(p.media);
      if (!bytes) {
        cache.current.set(key, "failed");
        continue;
      }
      cache.current.set(key, "pending");
      const blob = new Blob([bytes.slice()], { type: p.contentType });
      const ops = p.adjustments ?? [];
      createImageBitmap(blob)
        .then((img) =>
          ops.length > 0 && adjust ? corrected(img, ops, adjust) : img,
        )
        .then(
          (img) => {
            cache.current.set(key, img);
            if (live) setRevision((r) => r + 1);
          },
          () => cache.current.set(key, "failed"),
        );
    }
    return () => {
      live = false;
    };
  }, [scene, bytesOf, adjust]);

  useEffect(() => {
    const c = cache.current;
    return () => {
      for (const v of c.values()) if (typeof v === "object") v.close();
      c.clear();
    };
  }, []);

  const imageOf = (key: string) => {
    const v = cache.current.get(key);
    return typeof v === "object" ? v : undefined;
  };
  return { revision, imageOf };
}
