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

// Video and audio (slide ADR 718) without an engine: when a medium starts
// in the show, its volume and moment as it plays, the file types Insert
// takes, and the MP4's audio track.

import { describe, expect, it } from "bun:test";

import type { MediaItem } from "@paged-media/plugin-api";

import type { EffectInfo } from "../src/anim/model";
import { mediaStart, mediaType, showMediaOf } from "../src/media";
import { mediaMoment } from "../src/output/video/runner";
import {
  audioSpecificConfig,
  findBox,
  muxMp4,
  parseBoxes,
} from "../src/output/video/mp4";
import { volumeAt } from "../src/show/media-player";

const movie = (over: Partial<MediaItem> = {}): MediaItem =>
  ({
    kind: "movie",
    source: { type: "part", path: "paged/core/media/a.mp4" },
    play: "onClick",
    volume: 1,
    ...over,
  }) as MediaItem;

const effect = (over: Partial<EffectInfo>): EffectInfo =>
  ({
    index: 0,
    target: { spid: "4", item: "r1", key: "ppt/slides/slide1.xml#4" },
    paragraph: null,
    bg: false,
    presetClass: "mediacall",
    presetId: 1,
    presetSubtype: 0,
    name: "Play",
    start: "after",
    delayMs: 0,
    durationMs: 0,
    repeat: null,
    rewind: false,
    trigger: null,
    clickGroup: 0,
    beginMs: 0,
    endMs: 0,
    editable: false,
    ...over,
  }) as EffectInfo;

describe("when a medium starts (slide ADR 718)", () => {
  it("follows its mediacall effect: the click group and the offset", () => {
    expect(
      mediaStart(movie(), "r1", null, [
        effect({ clickGroup: 2, beginMs: 500 }),
      ]),
    ).toEqual({ step: 2, beginMs: 500 });
    // By its shape key on a duplicated slide.
    expect(
      mediaStart(movie(), "other", "ppt/slides/slide1.xml#4", [effect({})]),
    ).toEqual({ step: 0, beginMs: 0 });
  });
  it("a trigger plays it when it is clicked", () => {
    expect(
      mediaStart(movie(), "r1", null, [
        effect({ trigger: { spid: "4", item: "r1" } }),
      ]),
    ).toEqual({ step: null, beginMs: 0 });
  });
  it("without an effect, its own play decides", () => {
    expect(mediaStart(movie({ play: "auto" }), "r1", null, [])).toEqual({
      step: 0,
      beginMs: 0,
    });
    expect(mediaStart(movie(), "r1", null, undefined).step).toBeNull();
    // Another class on the frame is no start.
    expect(
      mediaStart(movie(), "r1", null, [effect({ presetClass: "entr" })]).step,
    ).toBeNull();
  });
  it("lists a slide's media with their boxes", () => {
    const list = showMediaOf(
      [
        {
          item: {
            id: { kind: "rectangle", id: "r1" } as never,
            key: null,
            z: 0,
            box: { x: 10, y: 20, w: 160, h: 90 },
          },
          media: movie({ play: "auto" }),
        },
      ],
      [],
    );
    expect(list[0]!.box).toEqual({ x: 10, y: 20, w: 160, h: 90 });
    expect(list[0]!.step).toBe(0);
  });
});

describe("a medium as it plays", () => {
  it("fades in from its trimmed start and out towards its trimmed end", () => {
    const m = movie({
      volume: 0.5,
      trimStartMs: 1000,
      trimEndMs: 1000,
      fadeInMs: 1000,
      fadeOutMs: 2000,
    });
    expect(volumeAt(m, 1, 10)).toBe(0);
    expect(volumeAt(m, 1.5, 10)).toBeCloseTo(0.25);
    expect(volumeAt(m, 4, 10)).toBeCloseTo(0.5);
    expect(volumeAt(m, 8, 10)).toBeCloseTo(0.25);
    expect(volumeAt(movie({ volume: 2 }), 0, 10)).toBe(1);
  });
  it("is at its trimmed moment, loops within the trim, ends", () => {
    const m = movie({ trimStartMs: 500, trimEndMs: 500 });
    expect(mediaMoment(m, 0, 3)).toBe(0.5);
    expect(mediaMoment(m, 1.5, 3)).toBe(2);
    expect(mediaMoment(m, 2.5, 3)).toBeNull();
    expect(mediaMoment({ ...m, loop: true }, 2.5, 3)).toBeCloseTo(1);
  });
});

describe("Insert ▸ Video and Audio", () => {
  it("knows a medium by its file name", () => {
    expect(mediaType("Clip.MP4")).toEqual({ mime: "video/mp4", kind: "movie" });
    expect(mediaType("tone.m4a")).toEqual({ mime: "audio/mp4", kind: "sound" });
    expect(mediaType("x.mp3")?.kind).toBe("sound");
    expect(mediaType("picture.png")).toBeNull();
  });
});

describe("the MP4's audio track (slide ADR 718, ADR 720)", () => {
  const video = {
    codec: "vp9" as const,
    width: 64,
    height: 36,
    fps: 30,
    samples: [
      { data: new Uint8Array([1, 2, 3]), key: true },
      { data: new Uint8Array([4, 5]), key: false },
    ],
  };
  it("writes an AAC track after the video, its samples in mdat", () => {
    const bytes = muxMp4({
      ...video,
      audio: {
        codec: "aac",
        sampleRate: 48000,
        channels: 2,
        samples: [
          { data: new Uint8Array([9, 9, 9, 9]), duration: 1024 },
          { data: new Uint8Array([8, 8]), duration: 1024 },
          { data: new Uint8Array([7]), duration: 512 },
        ],
      },
    });
    const boxes = parseBoxes(bytes);
    const moov = findBox(boxes, "moov")!;
    const traks = moov.children!.filter((b) => b.type === "trak");
    expect(traks).toHaveLength(2);
    expect(findBox([traks[1]!], "smhd")).not.toBeNull();
    const mp4a = findBox([traks[1]!], "mp4a");
    expect(mp4a).not.toBeNull();
    expect(findBox([traks[1]!], "esds")).not.toBeNull();
    // stco points at the audio samples: after the video's 5 bytes.
    const stco = findBox([traks[1]!], "stco")!;
    const dv = new DataView(bytes.buffer);
    const off = dv.getUint32(stco.body + 8);
    expect([...bytes.subarray(off, off + 7)]).toEqual([9, 9, 9, 9, 8, 8, 7]);
    // stts: runs of equal durations.
    const stts = findBox([traks[1]!], "stts")!;
    expect(dv.getUint32(stts.body + 4)).toBe(2);
    // The video still comes first in mdat.
    const v = findBox([traks[0]!], "stco")!;
    const voff = dv.getUint32(v.body + 8);
    expect([...bytes.subarray(voff, voff + 5)]).toEqual([1, 2, 3, 4, 5]);
    // The next track id names three.
    const mvhd = findBox([moov], "mvhd")!;
    expect(dv.getUint32(mvhd.body + 4 + 92)).toBe(3);
  });
  it("writes an Opus track with dOps", () => {
    const bytes = muxMp4({
      ...video,
      audio: {
        codec: "opus",
        sampleRate: 48000,
        channels: 2,
        samples: [{ data: new Uint8Array([1]), duration: 960 }],
      },
    });
    expect(findBox(parseBoxes(bytes), "dOps")).not.toBeNull();
  });
  it("a silent video has one track", () => {
    const moov = findBox(parseBoxes(muxMp4(video)), "moov")!;
    expect(moov.children!.filter((b) => b.type === "trak")).toHaveLength(1);
  });
  it("builds an AAC-LC AudioSpecificConfig", () => {
    // AAC LC (2), 48 kHz (index 3), stereo: 0x11 0x90.
    expect([...audioSpecificConfig(48000, 2)]).toEqual([0x11, 0x90]);
    expect([...audioSpecificConfig(44100, 1)]).toEqual([0x12, 0x08]);
  });
});
