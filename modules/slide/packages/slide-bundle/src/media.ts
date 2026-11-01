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

// Video and audio (slide ADR 718). A movie or sound is a picture frame
// whose medium the engine keeps (engine ADR 1027): the picture is its
// poster, which is all the engine draws; the medium is a part of the
// document (extensions ADR 345, amendment 1, `host.media.store`) and the frame's
// `frameMedia` says how it plays. Insert ▸ Video… / Audio… place one on the
// active slide, its poster the video's first frame (a sound gets an icon),
// in one undo step. The show plays the media over their frames
// (show/media-player.ts) and the video export mixes their sound and draws
// their frames (show/offline.ts).

import type {
  BundleHost,
  ElementId,
  MediaItem,
  MediaRead,
  MutationInput,
} from "@paged-media/plugin-api";

import type { Box, EffectInfo } from "./anim/model.js";
import { idOf, type PageShapes } from "./anim/shapes.js";

/** What Insert ▸ Video… asks the picker for. */
export const VIDEO_ACCEPT: readonly string[] = [
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".ogv",
  "video/*",
];

/** What Insert ▸ Audio… asks the picker for. */
export const AUDIO_ACCEPT: readonly string[] = [
  ".mp3",
  ".m4a",
  ".wav",
  ".aac",
  ".ogg",
  ".oga",
  ".flac",
  ".weba",
  "audio/*",
];

/** The media type of a file by its name (the picker gives the bytes and
 *  the name), or null when it is no medium the browser plays. */
export function mediaType(
  name: string,
): { mime: string; kind: "movie" | "sound" } | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const video: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/x-m4v",
    mov: "video/quicktime",
    webm: "video/webm",
    ogv: "video/ogg",
  };
  const audio: Record<string, string> = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    aac: "audio/aac",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    flac: "audio/flac",
    weba: "audio/webm",
  };
  if (video[ext]) return { mime: video[ext]!, kind: "movie" };
  if (audio[ext]) return { mime: audio[ext]!, kind: "sound" };
  return null;
}

/** A medium's first frame and length, read by the browser: a PNG of the
 *  first frame (a video) and the duration. Nulls where there is no DOM or
 *  the browser cannot decode it. */
export async function probeMedia(
  bytes: Uint8Array,
  mime: string,
  kind: "movie" | "sound",
): Promise<{
  poster: Uint8Array | null;
  width: number;
  height: number;
  durationMs: number | null;
}> {
  const none = { poster: null, width: 0, height: 0, durationMs: null };
  if (typeof document === "undefined" || typeof URL === "undefined")
    return none;
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
  );
  try {
    const el = document.createElement(kind === "movie" ? "video" : "audio");
    el.preload = "auto";
    el.muted = true;
    el.src = url;
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      el.addEventListener(
        "loadeddata",
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
      el.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          resolve(false);
        },
        { once: true },
      );
    });
    if (!ready) return none;
    const durationMs = Number.isFinite(el.duration)
      ? Math.round(el.duration * 1000)
      : null;
    if (kind === "sound" || !(el instanceof HTMLVideoElement))
      return { ...none, durationMs };
    const w = el.videoWidth;
    const h = el.videoHeight;
    if (!(w > 0 && h > 0)) return { ...none, durationMs };
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(el, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob(r, "image/png"),
    );
    const poster = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    return { poster, width: w, height: h, durationMs };
  } catch {
    return none;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A sound's icon when no poster is given: a 96 × 96 PNG, a speaker in
 *  PowerPoint's blue (a plain square without a canvas). */
export async function soundIcon(): Promise<Uint8Array> {
  if (typeof document !== "undefined") {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 96;
      const g = c.getContext("2d");
      if (g) {
        g.fillStyle = "#2f5597";
        g.beginPath();
        g.moveTo(14, 36);
        g.lineTo(34, 36);
        g.lineTo(58, 14);
        g.lineTo(58, 82);
        g.lineTo(34, 60);
        g.lineTo(14, 60);
        g.closePath();
        g.fill();
        g.strokeStyle = "#2f5597";
        g.lineWidth = 6;
        for (const r of [14, 26]) {
          g.beginPath();
          g.arc(58, 48, r, -0.9, 0.9);
          g.stroke();
        }
        const blob = await new Promise<Blob | null>((r) =>
          c.toBlob(r, "image/png"),
        );
        if (blob) return new Uint8Array(await blob.arrayBuffer());
      }
    } catch {
      // fall through to the plain square
    }
  }
  return PLAIN_POSTER;
}

/** A 1 × 1 grey PNG: the poster of last resort. */
const PLAIN_POSTER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x68, 0x68, 0x68, 0x00, 0x00, 0x03, 0x04, 0x01,
  0x81, 0x4b, 0xd3, 0xc3, 0x45, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

export interface InsertMediaArgs {
  bytes: Uint8Array;
  /** The file's name: its type, and the medium's name. */
  name: string;
  pageId: string;
  pageSize: [number, number];
  /** The poster, PNG (default: the video's first frame, a sound's icon). */
  poster?: Uint8Array;
  center?: [number, number];
  w?: number;
  h?: number;
  /** When it plays in the show (default: on click). */
  play?: "onClick" | "auto";
}

/** Insert the medium `args.bytes` on `args.pageId` as a movie or sound
 *  frame: its id, or null with the reason logged. The medium is stored in
 *  the document first (not undoable, like any part); the frame, its poster
 *  and its medium are one undo step. */
export async function insertMedia(
  host: BundleHost,
  args: InsertMediaArgs,
): Promise<ElementId | null> {
  const type = mediaType(args.name);
  if (!type) {
    host.log.warn(
      `paged.slide insert media: ${args.name} is no video or audio`,
    );
    return null;
  }
  if (!host.supports("document.media@1")) {
    host.log.warn("paged.slide insert media: this host keeps no media");
    return null;
  }
  const probe = await probeMedia(args.bytes, type.mime, type.kind);
  const poster =
    args.poster ??
    probe.poster ??
    (type.kind === "sound" ? await soundIcon() : PLAIN_POSTER);
  let source: MediaItem["source"];
  try {
    source = await host.media.store(args.bytes, {
      mime: type.mime,
      kind: type.kind,
    });
  } catch (err) {
    host.log.warn(`paged.slide insert media: ${String(err)}`);
    return null;
  }
  // A video at its own size (96 pixels an inch) fitted to the slide; a
  // sound's icon at 0.5 in.
  let [w, h] =
    type.kind === "sound"
      ? [36, 36]
      : probe.width > 0
        ? [probe.width * 0.75, probe.height * 0.75]
        : [480, 270];
  if (args.w && args.h) [w, h] = [args.w, args.h];
  const k = Math.min(1, args.pageSize[0] / w, args.pageSize[1] / h);
  [w, h] = [w * k, h * k];
  const [cx, cy] = args.center ?? [args.pageSize[0] / 2, args.pageSize[1] / 2];
  const media: MediaItem = {
    kind: type.kind,
    source,
    mime: type.mime,
    name: args.name.split(/[\\/]/).pop() ?? args.name,
    durationMs: probe.durationMs ?? undefined,
    play: args.play ?? "onClick",
  } as MediaItem;
  const handle = { kind: "rectangle", id: "$h:media" } as unknown as ElementId;
  const batch = {
    op: "batch",
    args: {
      ops: [
        {
          op: "insertFrame",
          args: {
            pageId: args.pageId,
            bounds: [cy - h / 2, cx - w / 2, cy + h / 2, cx + w / 2],
          },
        },
        { op: "bindCreated", args: { handle: "media" } },
        { op: "replaceImageBytes", args: { elementId: "$h:media", bytes: [] } },
        {
          op: "setElementProperty",
          args: {
            elementId: handle,
            path: "frameMedia",
            value: { type: "media", value: media },
          },
        },
      ],
    },
  } as MutationInput;
  const out = await host.document.mutateWithBytes(batch, poster);
  if (!out.applied) {
    host.log.warn(
      `paged.slide insert media: the engine refused (${JSON.stringify(out.error)})`,
    );
    return null;
  }
  const id =
    out.minted?.find((m) => m.handle === "media")?.element ??
    out.minted?.[0]?.element ??
    out.createdId ??
    null;
  return (id as ElementId | null) ?? null;
}

// ------------------------------------------------------------ the show

/** A medium of a slide as the show plays it. */
export interface ShowMedia {
  /** The frame. */
  element: ElementId;
  /** Its page area, pt. */
  box: Box;
  media: MediaItem;
  /** The build step it starts at (0: with the slide), or null: when it
   *  is clicked. */
  step: number | null;
  /** How long after that step it starts, ms. */
  beginMs: number;
}

/** When a medium starts: the slide's `mediacall` effect on its frame (its
 *  click group and offset, or a click on a trigger), else its own `play`
 *  (automatically with the slide, or when it is clicked). */
export function mediaStart(
  media: MediaItem,
  frame: string,
  key: string | null,
  effects: readonly EffectInfo[] | undefined,
): { step: number | null; beginMs: number } {
  const e = effects?.find(
    (x) =>
      x.presetClass === "mediacall" &&
      (x.target.item === frame || (key !== null && x.target.key === key)),
  );
  if (e) {
    if (e.trigger) return { step: null, beginMs: 0 };
    return { step: e.clickGroup, beginMs: Math.max(0, e.beginMs) };
  }
  return media.play === "auto"
    ? { step: 0, beginMs: 0 }
    : { step: null, beginMs: 0 };
}

/** The movie and sound frames of each page, read once for a show. */
export async function pageMedia(
  host: BundleHost,
  pages: ReadonlyMap<string, PageShapes>,
): Promise<
  Map<string, { item: PageShapes["items"][number]; media: MediaItem }[]>
> {
  const out = new Map<
    string,
    { item: PageShapes["items"][number]; media: MediaItem }[]
  >();
  if (!host.supports("document.media@1")) return out;
  for (const [pageId, page] of pages) {
    for (const item of page.items) {
      if (item.id.kind !== "rectangle") continue;
      const props = await host.document.elementProperties(item.id);
      const row = props?.entries.find((e) => e.path === "frameMedia");
      const v = row?.value as {
        type?: string;
        value?: MediaItem | null;
      } | null;
      if (v?.type !== "media" || !v.value) continue;
      const list = out.get(pageId) ?? [];
      list.push({ item, media: v.value });
      out.set(pageId, list);
    }
  }
  return out;
}

/** The media a show slide plays. */
export function showMediaOf(
  found: readonly { item: PageShapes["items"][number]; media: MediaItem }[],
  effects: readonly EffectInfo[] | undefined,
): ShowMedia[] {
  return found.map(({ item, media }) => ({
    element: item.id,
    box: item.box,
    media,
    ...mediaStart(media, idOf(item.id), item.key, effects),
  }));
}

/** Read a medium for playing. */
export type MediaReader = (element: ElementId) => Promise<MediaRead | null>;
