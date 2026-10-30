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

// Extensions ADR 345, amendment 1 (C6) — the media door over engine ADR 1027's movie and
// sound frames, on the real engine: the flag and the catalog row, a medium
// stored and read back by its frame, the same bytes stored twice in one
// part, a `frameMedia` write undone in one step, a link answered as a URL.

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId, MediaItem } from "@paged-media/plugin-api";

import { propertySchemas } from "../../plugin-api/src/catalog.json";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { HOST_FEATURES, mediaExtension } from "../src/host-impl";
import { minimalIdml } from "./fixtures/minimal-idml";

import { silentConsole as silent } from "../src/testing";

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

async function frameOn(h: HeadlessHost): Promise<ElementId> {
  const [pageId] = await h.load(minimalIdml());
  const out = await h.host.document.mutate({
    op: "insertFrame",
    args: { pageId: pageId!, bounds: [20, 20, 120, 200] },
  });
  if (!out.applied || !out.createdId) throw new Error("no frame inserted");
  return out.createdId;
}

const CLIP = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);

describe("the media door (extensions ADR 345, amendment 1)", () => {
  it("is advertised, and the vendored catalog carries frameMedia", () => {
    expect(HOST_FEATURES).toContain("document.media@1");
    const row = (
      propertySchemas as ReadonlyArray<{ path: string; type: { kind: string } }>
    ).find((r) => r.path === "frameMedia");
    expect(row?.type.kind).toBe("struct");
  });

  it("names a part by its type", () => {
    expect(mediaExtension("video/mp4")).toBe("mp4");
    expect(mediaExtension("audio/mpeg")).toBe("mp3");
    expect(mediaExtension("audio/x-unknown")).toBe("m4a");
    expect(mediaExtension("application/octet-stream", "movie")).toBe("mp4");
  });

  it("stores a medium, reads it back by its frame, and undoes the frame's write", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.media@1")).toBe(true);
    const id = await frameOn(h);
    expect(await h.host.media.read(id)).toBeNull();
    const source = await h.host.media.store(CLIP, { mime: "video/mp4" });
    expect(source).toMatchObject({ type: "part" });
    const path = (source as { path: string }).path;
    expect(path).toMatch(/^paged\/core\/media\/[0-9a-f]{32}\.mp4$/);
    // The same bytes again: the same part.
    expect(await h.host.media.store(CLIP, { mime: "video/mp4" })).toEqual(
      source,
    );
    const media = {
      kind: "movie",
      source,
      play: "auto",
      volume: 0.5,
    } as MediaItem;
    const out = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameMedia",
        value: { type: "media", value: media },
      },
    });
    expect(out.applied).toBe(true);
    const read = await h.host.media.read(id);
    expect(read?.media.play).toBe("auto");
    expect(read?.media.volume).toBe(0.5);
    expect(read?.url).toBeNull();
    expect([...read!.bytes!]).toEqual([...CLIP]);
    await h.host.document.undo();
    expect(await h.host.media.read(id)).toBeNull();
  });

  it("answers a linked medium's URL, and refuses a medium out of range", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const id = await frameOn(h);
    const link = {
      kind: "sound",
      source: { type: "link", uri: "https://example.com/tone.mp3" },
      play: "onClick",
    } as MediaItem;
    const set = (value: MediaItem) =>
      h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: id,
          path: "frameMedia",
          value: { type: "media", value },
        },
      });
    expect((await set(link)).applied).toBe(true);
    const read = await h.host.media.read(id);
    expect(read).toMatchObject({
      url: "https://example.com/tone.mp3",
      bytes: null,
    });
    expect((await set({ ...link, volume: 3 } as MediaItem)).applied).toBe(
      false,
    );
  });
});
