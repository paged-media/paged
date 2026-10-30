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
// Video and audio (slide ADR 718, engine ADR 1027): a medium plays in the
// video where it would in the show: with its slide (or at its build step on
// an animated slide, after the step's offset) until the slide ends. A
// movie's pictures are drawn over its frame at each frame's moment
// (audio.ts, `MovieFrames`); every medium's sound is mixed with an
// OfflineAudioContext and encoded as the MP4's audio track (AAC, else
// Opus). A medium that plays when it is clicked is not in the video.

import type { Frame, FrameSource } from "../../show/frames.js";
import { SlideAnimation, type Player } from "../../show/animation.js";
import { createOfflineRenderer } from "../../show/offline.js";
import { closeScene, type SlideScene } from "../../show/scene-source.js";
import type { ShowSlide } from "../../show/show-model.js";
import type { MediaReader, ShowMedia } from "../../media.js";
import { encodeAudio, mixCues, MovieFrames, type MediaCue } from "./audio.js";
import { muxMp4, type Mp4Audio, type Sample } from "./mp4.js";
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
  /** The sound track's codec, or null for a silent video. */
  audio: "aac" | "opus" | null;
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

/** A medium of a held slide as the video plays it. */
interface Playing {
  m: ShowMedia;
  bytes: Uint8Array;
  movie: MovieFrames | null;
  /** When it starts, s after the slide's first frame (null: not yet). */
  at: number | null;
}

/** Where a medium is in its own timeline, `dt` s after it started: its
 *  moment, or null once it has ended (and does not loop). */
export function mediaMoment(
  m: ShowMedia["media"],
  dt: number,
  duration: number,
): number | null {
  const from = Math.max(0, (m.trimStartMs ?? 0) / 1000);
  const to = Math.max(from, duration - (m.trimEndMs ?? 0) / 1000);
  const span = to - from;
  if (!(span > 0)) return from;
  if (m.loop) return from + (dt % span);
  return dt <= span ? from + dt : null;
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
  hooks: {
    onProgress?(p: VideoProgress): void;
    signal?: AbortSignal;
    /** An animated slide's layers and player at `scale` (slide ADR 714):
     *  its builds play in the video, each click when the one before has
     *  finished, as PowerPoint's video does. */
    animation?(
      slide: ShowSlide,
      scale: number,
    ): Promise<{ scene: SlideScene; player: Player } | null>;
    /** Reads the slides' video and audio (slide ADR 718); absent, the
     *  video shows their posters and is silent. */
    media?: MediaReader;
  } = {},
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
  const frameOf = async (
    pageId: string,
    hide?: readonly string[],
  ): Promise<Frame | null> => frames.frame(pageId, scale, hide);
  const cues: MediaCue[] = [];
  const bytesOf = new Map<string, Uint8Array | null>();
  /** The media a held slide plays in the video, their bytes read. */
  const mediaOf = async (slide: ShowSlide | undefined): Promise<Playing[]> => {
    if (!slide?.media?.length || !hooks.media) return [];
    const out: Playing[] = [];
    for (const m of slide.media) {
      if (m.step === null) continue; // plays when clicked: not in a video
      const key = String(m.element.id);
      if (!bytesOf.has(key)) {
        const r = await hooks.media(m.element).catch(() => null);
        bytesOf.set(key, r?.bytes ?? null);
      }
      const bytes = bytesOf.get(key);
      if (!bytes) continue;
      let movie: MovieFrames | null = null;
      if (m.media.kind === "movie") {
        movie = new MovieFrames();
        if (!(await movie.open(bytes, m.media.mime ?? "video/mp4")))
          movie = null;
      }
      out.push({ m, bytes, movie, at: m.step === 0 ? m.beginMs / 1000 : null });
    }
    return out;
  };
  /** Draw the playing movies at `t` s into the slide. */
  const drawMovies = async (playing: readonly Playing[], t: number) => {
    for (const p of playing) {
      if (!p.movie || p.at === null || t < p.at) continue;
      const when = mediaMoment(p.m.media, t - p.at, p.movie.duration());
      if (when === null && (p.m.media.hideWhileNotPlaying || p.m.media.rewind))
        continue;
      const img = await p.movie.at(when ?? p.movie.duration());
      if (!img) continue;
      const b = p.m.box;
      renderer.overlay(img, b.x * scale, b.y * scale, b.w * scale, b.h * scale);
    }
  };
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
      const held =
        seg.kind === "hold"
          ? shown.find((x) => x.pageId === seg.pageId)
          : undefined;
      const animated =
        seg.kind === "hold" && held?.anim && hooks.animation
          ? await hooks.animation(held, scale)
          : null;
      // Slide ADR 718: the slide's media, on the video's clock from here.
      const playing = seg.kind === "hold" ? await mediaOf(held) : [];
      const segStart = index / fps;
      const segEnd = segStart + seg.frames / fps;
      const hide = held?.hide;
      if (seg.kind === "hold" && animated) {
        // The slide's own clock is the video's: frame i is i / fps s in.
        let t = 0;
        const anim = new SlideAnimation(
          animated.player,
          animated.scene,
          () => t,
        );
        let quietSince: number | null = null;
        try {
          for (let i = 0; i < seg.frames; i++) {
            t = (i * 1000) / fps;
            const { states, running } = anim.draws();
            if (running) quietSince = null;
            else if (anim.step() < anim.clicks()) {
              quietSince ??= t;
              if (t - quietSince >= 250) {
                anim.next();
                quietSince = null;
                // A medium of this step starts now (after its offset).
                for (const p of playing)
                  if (p.at === null && p.m.step === anim.step())
                    p.at = t / 1000 + p.m.beginMs / 1000;
              }
            }
            renderer.slide(null, { scene: animated.scene, states });
            await drawMovies(playing, t / 1000);
            const f = snap();
            try {
              await emit(f);
            } finally {
              f.close();
            }
          }
        } finally {
          anim.dispose();
          closeScene(animated.scene);
        }
      } else if (seg.kind === "hold" && playing.some((p) => p.movie)) {
        // A movie plays: every frame is drawn.
        const base = await frameOf(seg.pageId, hide);
        for (let i = 0; i < seg.frames; i++) {
          renderer.slide(base);
          await drawMovies(playing, i / fps);
          const f = snap();
          try {
            await emit(f);
          } finally {
            f.close();
          }
        }
      } else if (seg.kind === "hold") {
        renderer.slide(await frameOf(seg.pageId, hide));
        const still = snap();
        try {
          for (let i = 0; i < seg.frames; i++) await emit(still);
        } finally {
          still.close();
        }
      } else {
        const a = await frameOf(seg.from, shown.find((x) => x.pageId === seg.from)?.hide);
        const b = await frameOf(seg.to, shown.find((x) => x.pageId === seg.to)?.hide);
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
      for (const p of playing) {
        if (p.at !== null && segStart + p.at < segEnd)
          cues.push({
            media: p.m.media,
            bytes: p.bytes,
            start: segStart + p.at,
            end: segEnd,
          });
        p.movie?.close();
      }
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== "closed") encoder.close();
    renderer.dispose();
  }
  hooks.onProgress?.({ done: plan.frames, total: plan.frames });
  // The media's sound (slide ADR 718).
  let audio: Mp4Audio | null = null;
  if (cues.length > 0) {
    const mix = await mixCues(cues, samples.length / fps).catch(() => null);
    if (mix) audio = await encodeAudio(mix).catch(() => null);
  }
  const bytes = muxMp4({
    codec: picked.codec,
    width: size.width,
    height: size.height,
    fps,
    avcC,
    vp9: picked.vp9,
    samples,
    audio: audio ?? undefined,
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
    audio: audio?.codec ?? null,
  };
}
