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

// The video export runner (slide ADR 720, editor ADR 308): the show drawn
// offline frame by frame at a fixed rate (show/offline.ts), each frame
// encoded with WebCodecs (H.264 where the browser encodes it, else VP9) and
// the chunks muxed into an MP4 (mp4.ts). The encoder works off the main
// thread; the runner waits for its queue to drain before handing it more,
// and yields between frames, so the editor stays responsive. A cancel
// (AbortSignal) stops it between two frames.
//
// Audio: a deck's media items (slide wave 4, engine ADR 1027) would be
// mixed with an OfflineAudioContext into an AAC track. No deck has media
// yet, so `audioOf` answers nothing and the video is silent.

import type { Frame, FrameSource } from "../../show/frames.js";
import { createOfflineRenderer } from "../../show/offline.js";
import type { ShowSlide } from "../../show/show-model.js";
import { muxMp4, type Sample } from "./mp4.js";
import { timeline, videoSize, type Segment } from "./timeline.js";

export type VideoHeight = 720 | 1080 | 2160;

export interface VideoOptions {
  height: VideoHeight;
  fps: 24 | 30 | 60;
  /** Seconds on a slide without a recorded time (PowerPoint's 5). */
  defaultSeconds: number;
  useTimings: boolean;
  /** `auto` (H.264, else VP9), or one of them. */
  codec?: "auto" | "avc" | "vp9";
}

export interface VideoProgress {
  done: number;
  total: number;
}

export interface Video {
  bytes: Uint8Array;
  codec: "avc" | "vp9";
  /** The codec string the encoder was configured with. */
  codecString: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationMs: number;
  /** Whether transitions ran on the GPU (false: they cut). */
  gpu: boolean;
}

/** H.264 levels for the frame size and rate (High profile). */
function avcCodec(w: number, h: number, fps: number): string {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16) * fps;
  // MaxMBPS per level (ITU-T H.264 table A-1).
  const levels: [number, string][] = [
    [108000, "1f"], // 3.1
    [216000, "20"], // 3.2
    [245760, "28"], // 4.0
    [522240, "2a"], // 4.2
    [589824, "32"], // 5.0
    [983040, "33"], // 5.1
    [2073600, "34"], // 5.2
  ];
  const lv = levels.find(([max]) => mbs <= max)?.[1] ?? "34";
  return `avc1.6400${lv}`;
}

function vp9Level(w: number, h: number): number {
  const px = w * h;
  if (px <= 1280 * 720) return 31;
  if (px <= 2048 * 1088) return 41;
  return 51;
}

function bitrate(w: number, h: number, fps: number): number {
  // About 0.15 bits a pixel at 30 fps: 8 Mbit/s at 1080p30.
  return Math.round(w * h * fps * 0.13);
}

export interface PickedCodec {
  codec: "avc" | "vp9";
  config: VideoEncoderConfig;
  vp9?: { profile: number; level: number; bitDepth: number };
}

/** The first codec the browser encodes at this size and rate. */
export async function pickCodec(
  width: number,
  height: number,
  fps: number,
  want: "auto" | "avc" | "vp9" = "auto",
): Promise<PickedCodec | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const base = {
    width,
    height,
    framerate: fps,
    bitrate: bitrate(width, height, fps),
    latencyMode: "quality" as const,
  };
  const tries: PickedCodec[] = [];
  if (want !== "vp9")
    tries.push({
      codec: "avc",
      config: {
        ...base,
        codec: avcCodec(width, height, fps),
        avc: { format: "avc" },
      },
    });
  if (want !== "avc") {
    const level = vp9Level(width, height);
    tries.push({
      codec: "vp9",
      config: { ...base, codec: `vp09.00.${level}.08` },
      vp9: { profile: 0, level, bitDepth: 8 },
    });
  }
  for (const t of tries) {
    try {
      const s = await VideoEncoder.isConfigSupported(t.config);
      if (s.supported) return t;
    } catch {
      // An invalid config is not supported.
    }
  }
  return null;
}

/** The audio of the video: nothing until slides carry media (see above). */
export function audioOf(_slides: readonly ShowSlide[]): null {
  return null;
}

const abortError = () =>
  Object.assign(new Error("the video export was cancelled"), {
    name: "AbortError",
  });

/** Make the video of `slides`. */
export async function renderVideo(
  slides: readonly ShowSlide[],
  frames: FrameSource,
  opts: VideoOptions,
  hooks: { onProgress?(p: VideoProgress): void; signal?: AbortSignal } = {},
): Promise<Video> {
  const shown = slides.filter((s) => !s.hidden);
  if (shown.length === 0)
    throw new Error("every slide is hidden: there is nothing to show");
  const size = videoSize(opts.height, shown[0]!.sizePt);
  const fps = opts.fps;
  const plan = timeline(slides, {
    fps,
    defaultSeconds: opts.defaultSeconds,
    useTimings: opts.useTimings,
  });
  const picked = await pickCodec(
    size.width,
    size.height,
    fps,
    opts.codec ?? "auto",
  );
  if (!picked)
    throw new Error(
      typeof VideoEncoder === "undefined"
        ? "this browser has no WebCodecs video encoder"
        : `this browser encodes neither H.264 nor VP9 at ${size.width} × ${size.height}, ${fps} fps`,
    );

  const samples: Sample[] = [];
  let avcC: Uint8Array | undefined;
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === "key" });
      const d = meta?.decoderConfig?.description;
      if (d && !avcC) {
        avcC =
          d instanceof ArrayBuffer
            ? new Uint8Array(d.slice(0))
            : new Uint8Array(
                (d as ArrayBufferView).buffer.slice(
                  (d as ArrayBufferView).byteOffset,
                  (d as ArrayBufferView).byteOffset +
                    (d as ArrayBufferView).byteLength,
                ),
              );
      }
    },
    error(e) {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure(picked.config);

  const renderer = await createOfflineRenderer(size.width, size.height);
  const scale = size.width / shown[0]!.sizePt[0];
  const frameOf = async (pageId: string): Promise<Frame | null> =>
    frames.frame(pageId, scale);
  const keyEvery = fps * 2;
  const usPerFrame = 1e6 / fps;
  let index = 0;

  const drain = async () => {
    while (encoder.encodeQueueSize > 4) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        encoder.addEventListener?.("dequeue", done, { once: true });
        setTimeout(done, 20);
      });
    }
  };
  const emit = async (source: VideoFrame) => {
    if (hooks.signal?.aborted) throw abortError();
    if (failure) throw failure;
    await drain();
    const f = new VideoFrame(source, {
      timestamp: Math.round(index * usPerFrame),
      duration: Math.round(usPerFrame),
    });
    encoder.encode(f, { keyFrame: index % keyEvery === 0 });
    f.close();
    index++;
    if (index % 8 === 0) {
      hooks.onProgress?.({ done: index, total: plan.frames });
      // Let the editor paint between batches of frames.
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  const snap = () =>
    new VideoFrame(renderer.canvas as CanvasImageSource & OffscreenCanvas, {
      timestamp: 0,
    });

  try {
    for (let s = 0; s < plan.segments.length; s++) {
      const seg: Segment = plan.segments[s]!;
      const next = plan.segments[s + 1];
      if (next?.kind === "hold") frames.prefetch(next.pageId, scale);
      if (seg.kind === "hold") {
        renderer.slide(await frameOf(seg.pageId));
        const still = snap();
        try {
          for (let i = 0; i < seg.frames; i++) await emit(still);
        } finally {
          still.close();
        }
      } else {
        const a = await frameOf(seg.from);
        const b = await frameOf(seg.to);
        for (let i = 0; i < seg.frames; i++) {
          if (a && b)
            await renderer.transition(
              a,
              b,
              seg.shader,
              (i + 1) / (seg.frames + 1),
              seg.params,
            );
          else renderer.slide(b);
          const f = snap();
          try {
            await emit(f);
          } finally {
            f.close();
          }
        }
      }
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== "closed") encoder.close();
    renderer.dispose();
  }
  hooks.onProgress?.({ done: plan.frames, total: plan.frames });
  const bytes = muxMp4({
    codec: picked.codec,
    width: size.width,
    height: size.height,
    fps,
    avcC,
    vp9: picked.vp9,
    samples,
  });
  return {
    bytes,
    codec: picked.codec,
    codecString: picked.config.codec,
    width: size.width,
    height: size.height,
    fps,
    frames: samples.length,
    durationMs: (samples.length * 1000) / fps,
    gpu: renderer.gpu,
  };
}
