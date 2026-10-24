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
// decoded once (createImageBitmap) and kept while the surface lives. The
// returned revision moves when an image arrives, so the painter runs again.

import { useEffect, useRef, useState } from "react";

import type { GridScene } from "@paged-media/sheet-host-model";

type Decoded = ImageBitmap;

export function usePictureImages(
  scene: Pick<GridScene, "pictures"> | null,
  bytesOf: (media: string) => Uint8Array | null,
): {
  revision: number;
  imageOf: (media: string) => Decoded | undefined;
} {
  const cache = useRef(new Map<string, Decoded | "pending" | "failed">());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (typeof createImageBitmap !== "function") return;
    let live = true;
    for (const p of scene?.pictures ?? []) {
      if (cache.current.has(p.media)) continue;
      const bytes = bytesOf(p.media);
      if (!bytes) {
        cache.current.set(p.media, "failed");
        continue;
      }
      cache.current.set(p.media, "pending");
      const blob = new Blob([bytes.slice()], { type: p.contentType });
      createImageBitmap(blob).then(
        (img) => {
          cache.current.set(p.media, img);
          if (live) setRevision((r) => r + 1);
        },
        () => cache.current.set(p.media, "failed"),
      );
    }
    return () => {
      live = false;
    };
  }, [scene, bytesOf]);

  useEffect(() => {
    const c = cache.current;
    return () => {
      for (const v of c.values()) if (typeof v === "object") v.close();
      c.clear();
    };
  }, []);

  const imageOf = (media: string) => {
    const v = cache.current.get(media);
    return typeof v === "object" ? v : undefined;
  };
  return { revision, imageOf };
}
