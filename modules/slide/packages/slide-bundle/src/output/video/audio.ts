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

// The video export's sound (slide ADR 718, ADR 720): each medium that plays
// in the video is a cue (its bytes, when it starts and stops on the
// video's clock), mixed by an OfflineAudioContext with the medium's trim,
// loop, volume and fades, and encoded with WebCodecs (AAC, else Opus) into
// the MP4's audio track. A movie's pictures are drawn into the frames by
// `MovieFrames`, which seeks a `<video>` to each frame's moment.

import type { MediaItem } from "@paged-media/plugin-api";

import type { Mp4Audio } from "./mp4.js";

/** One medium's playing in the video. */
export interface MediaCue {
  media: MediaItem;
  bytes: Uint8Array;
  /** On the video's clock, s. */
  start: number;
  end: number;
}

const n = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** The mix of `cues` over `duration` s, or null when nothing sounds (no
 *  cue decodes, or no OfflineAudioContext). */
export async function mixCues(
  cues: readonly MediaCue[],
  duration: number,
  sampleRate = 48000,
): Promise<AudioBuffer | null> {
  const Ctx = (
    globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }
  ).OfflineAudioContext;
  if (!Ctx || cues.length === 0 || !(duration > 0)) return null;
  const ctx = new Ctx(2, Math.ceil(duration * sampleRate), sampleRate);
  let any = false;
  const decoded = new Map<Uint8Array, AudioBuffer | null>();
  for (const c of cues) {
    let buf = decoded.get(c.bytes);
    if (buf === undefined) {
      try {
        buf = await ctx.decodeAudioData(c.bytes.slice().buffer);
      } catch {
        buf = null; // a video without sound, a format the browser lacks
      }
      decoded.set(c.bytes, buf);
    }
    if (!buf || !(c.end > c.start)) continue;
    const m = c.media;
    const from = Math.min(buf.duration, n(m.trimStartMs) / 1000);
    const to = Math.max(from, buf.duration - n(m.trimEndMs) / 1000);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    const vol = Math.min(1, Math.max(0, m.volume ?? 1));
    const span = c.end - c.start;
    const fin = n(m.fadeInMs) / 1000;
    const fout = n(m.fadeOutMs) / 1000;
    gain.gain.setValueAtTime(fin > 0 ? 0 : vol, c.start);
    if (fin > 0) gain.gain.linearRampToValueAtTime(vol, c.start + fin);
    const playEnd = m.loop ? c.end : Math.min(c.end, c.start + (to - from));
    if (fout > 0 && playEnd - fout > c.start) {
      gain.gain.setValueAtTime(vol, playEnd - fout);
      gain.gain.linearRampToValueAtTime(0, playEnd);
    }
    src.connect(gain).connect(ctx.destination);
    if (m.loop) {
      src.loop = true;
      src.loopStart = from;
      src.loopEnd = to;
      src.start(c.start, from);
      src.stop(c.end);
    } else {
      src.start(c.start, from, Math.min(span, to - from));
    }
    any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
}

/** `buffer` encoded for the MP4 (AAC-LC at 128 kbit/s, else Opus), or
 *  null when the browser encodes neither. */
export async function encodeAudio(
  buffer: AudioBuffer,
): Promise<Mp4Audio | null> {
  const Enc = (globalThis as { AudioEncoder?: typeof AudioEncoder })
    .AudioEncoder;
  const Data = (globalThis as { AudioData?: typeof AudioData }).AudioData;
  if (!Enc || !Data) return null;
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const tries: { codec: "aac" | "opus"; config: AudioEncoderConfig }[] = [
    {
      codec: "aac",
      config: {
        codec: "mp4a.40.2",
        sampleRate,
        numberOfChannels: channels,
        bitrate: 128000,
      },
    },
    {
      codec: "opus",
      config: {
        codec: "opus",
        sampleRate,
        numberOfChannels: channels,
        bitrate: 128000,
      },
    },
  ];
  let picked: (typeof tries)[number] | null = null;
  for (const t of tries) {
    try {
      if ((await Enc.isConfigSupported(t.config)).supported) {
        picked = t;
        break;
      }
    } catch {
      // not supported
    }
  }
  if (!picked) return null;
  const samples: { data: Uint8Array; duration: number }[] = [];
  let description: Uint8Array | undefined;
  let failure: unknown = null;
  const enc = new Enc({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const frames = Math.round(((chunk.duration ?? 0) * sampleRate) / 1e6);
      samples.push({
        data,
        duration: frames > 0 ? frames : picked!.codec === "aac" ? 1024 : 960,
      });
      const d = meta?.decoderConfig?.description;
      if (d && !description)
        description =
          d instanceof ArrayBuffer
            ? new Uint8Array(d.slice(0))
            : new Uint8Array(
                (d as ArrayBufferView).buffer.slice(
                  (d as ArrayBufferView).byteOffset,
                  (d as ArrayBufferView).byteOffset +
                    (d as ArrayBufferView).byteLength,
                ),
              );
    },
    error(e) {
      failure = e;
    },
  });
  enc.configure(picked.config);
  const block = 4096;
  for (let at = 0; at < buffer.length; at += block) {
    const len = Math.min(block, buffer.length - at);
    const planar = new Float32Array(len * channels);
    for (let c = 0; c < channels; c++)
      planar.set(buffer.getChannelData(c).subarray(at, at + len), c * len);
    const data = new Data({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: len,
      numberOfChannels: channels,
      timestamp: Math.round((at * 1e6) / sampleRate),
      data: planar,
    });
    enc.encode(data);
    data.close();
  }
  await enc.flush();
  enc.close();
  if (failure) return null;
  return {
    codec: picked.codec,
    sampleRate,
    channels,
    description: picked.codec === "aac" ? description : undefined,
    samples,
  };
}

/** A movie's pictures for the video: a `<video>` sought to each moment. */
export class MovieFrames {
  private el: HTMLVideoElement | null = null;
  private url: string | null = null;

  /** Open `bytes`; false where the browser cannot decode it. */
  async open(bytes: Uint8Array, mime: string): Promise<boolean> {
    if (typeof document === "undefined") return false;
    this.url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
    );
    const el = document.createElement("video");
    el.muted = true;
    el.preload = "auto";
    el.src = this.url;
    const ok = await new Promise<boolean>((resolve) => {
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
    if (ok) this.el = el;
    return ok;
  }

  /** The movie's length, s. */
  duration(): number {
    return this.el && Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }

  /** The picture at `t` s of the movie's own timeline. */
  async at(t: number): Promise<CanvasImageSource | null> {
    const el = this.el;
    if (!el) return null;
    const target = Math.max(0, Math.min(t, Math.max(0, this.duration() - 0.001)));
    if (Math.abs(el.currentTime - target) > 1e-4) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        el.addEventListener(
          "seeked",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        el.currentTime = target;
      });
    }
    return el;
  }

  close(): void {
    if (this.el) {
      this.el.removeAttribute("src");
      this.el.load?.();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.el = null;
    this.url = null;
  }
}
