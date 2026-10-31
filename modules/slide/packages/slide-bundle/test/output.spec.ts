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

// Slide ADR 720, the pure parts: the MP4 muxer read back box by box, the
// video's timeline, sections and custom shows over a deck's slides, paper
// and slide choice for the PDF.

import { describe, expect, it } from "bun:test";

import type { MutationInput } from "@paged-media/plugin-api";

import {
  liveShows,
  nextShowId,
  showsMutation,
  showsOfLabel,
} from "../src/custom-shows";
import { chosenSlides, paperFor } from "../src/output/documents";
import {
  findBox,
  muxMp4,
  parseBoxes,
  type ParsedBox,
} from "../src/output/video/mp4";
import { timeline, videoSize } from "../src/output/video/timeline";
import {
  addSectionMutation,
  moveSectionMutation,
  removeSectionMutation,
  renameSectionMutation,
  sectionsOf,
} from "../src/sections";
import { customShowSlides } from "../src/show/contribute";
import type { ShowSlide } from "../src/show/show-model";
import {
  deleteMutation,
  encodeState,
  parseState,
  type Slide,
} from "../src/slides-model";

const u32 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset).getUint32(at);

function samples(n: number, keyEvery: number) {
  return Array.from({ length: n }, (_, i) => ({
    data: new Uint8Array(10 + (i % 7)).fill(i & 0xff),
    key: i % keyEvery === 0,
  }));
}

/** A box's full-box payload after version/flags. */
const fullBody = (b: ParsedBox) => b.body + 4;

describe("[plugin-slide.output] the MP4 muxer", () => {
  const avcC = Uint8Array.from([
    1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68,
    0xce,
  ]);

  it("writes ftyp, moov and mdat, and reads back sample counts, sizes, keys and the duration", () => {
    const n = 75;
    const s = samples(n, 30);
    const mp4 = muxMp4({
      codec: "avc",
      width: 1280,
      height: 720,
      fps: 30,
      avcC,
      samples: s,
    });
    const boxes = parseBoxes(mp4);
    expect(boxes.map((b) => b.type)).toEqual(["ftyp", "moov", "mdat"]);
    // mvhd: timescale 1000, duration 2500 ms (75 frames at 30 fps).
    const mvhd = findBox(boxes, "mvhd")!;
    expect(u32(mp4, fullBody(mvhd) + 8)).toBe(1000);
    expect(u32(mp4, fullBody(mvhd) + 12)).toBe(2500);
    // mdhd: its own timescale and duration agree.
    const mdhd = findBox(boxes, "mdhd")!;
    const ts = u32(mp4, fullBody(mdhd) + 8);
    expect(u32(mp4, fullBody(mdhd) + 12) / ts).toBeCloseTo(2.5, 6);
    // stts: one run of n samples.
    const stts = findBox(boxes, "stts")!;
    expect(u32(mp4, fullBody(stts))).toBe(1);
    expect(u32(mp4, fullBody(stts) + 4)).toBe(n);
    expect((u32(mp4, fullBody(stts) + 8) * n) / ts).toBeCloseTo(2.5, 6);
    // stsz: every sample's size.
    const stsz = findBox(boxes, "stsz")!;
    expect(u32(mp4, fullBody(stsz) + 4)).toBe(n);
    for (let i = 0; i < n; i++)
      expect(u32(mp4, fullBody(stsz) + 8 + 4 * i)).toBe(s[i]!.data.length);
    // stss: the key frames, 1-based.
    const stss = findBox(boxes, "stss")!;
    expect(u32(mp4, fullBody(stss))).toBe(3);
    expect([0, 1, 2].map((k) => u32(mp4, fullBody(stss) + 4 + 4 * k))).toEqual([
      1, 31, 61,
    ]);
    // stco: the chunk starts at mdat's data, which is the samples in order.
    const stco = findBox(boxes, "stco")!;
    const mdat = findBox(boxes, "mdat")!;
    expect(u32(mp4, fullBody(stco) + 4)).toBe(mdat.body);
    let at = mdat.body;
    for (const x of s) {
      expect(mp4.subarray(at, at + x.data.length)).toEqual(x.data);
      at += x.data.length;
    }
    // The sample entry: avc1 at the frame size, holding the encoder's avcC.
    const avc1 = findBox(boxes, "avc1")!;
    expect(new DataView(mp4.buffer).getUint16(avc1.body + 24)).toBe(1280);
    expect(new DataView(mp4.buffer).getUint16(avc1.body + 26)).toBe(720);
    const c = findBox(boxes, "avcC")!;
    expect(mp4.subarray(c.body, c.start + c.size)).toEqual(avcC);
    // tkhd: the track's size in 16.16.
    const tkhd = findBox(boxes, "tkhd")!;
    expect(u32(mp4, tkhd.start + tkhd.size - 8) / 65536).toBe(1280);
    expect(u32(mp4, tkhd.start + tkhd.size - 4) / 65536).toBe(720);
  });

  it("writes VP9 as vp09 with a vpcC, and leaves stss out when every frame is a key", () => {
    const mp4 = muxMp4({
      codec: "vp9",
      width: 1920,
      height: 1080,
      fps: 24,
      vp9: { profile: 0, level: 41, bitDepth: 8 },
      samples: samples(5, 1),
    });
    const boxes = parseBoxes(mp4);
    const vpcC = findBox(boxes, "vpcC")!;
    expect(mp4[vpcC.body]).toBe(1); // version 1
    expect(mp4[vpcC.body + 4]).toBe(0); // profile
    expect(mp4[vpcC.body + 5]).toBe(41); // level
    expect(mp4[vpcC.body + 6]! >> 4).toBe(8); // bit depth
    expect(findBox(boxes, "vp09")).not.toBeNull();
    expect(findBox(boxes, "stss")).toBeNull();
    expect(findBox(boxes, "avcC")).toBeNull();
  });

  it("refuses what it cannot write", () => {
    expect(() =>
      muxMp4({ codec: "avc", width: 2, height: 2, fps: 30, avcC, samples: [] }),
    ).toThrow();
    expect(() =>
      muxMp4({
        codec: "avc",
        width: 2,
        height: 2,
        fps: 29.97,
        avcC,
        samples: samples(1, 1),
      }),
    ).toThrow();
    expect(() =>
      muxMp4({
        codec: "avc",
        width: 2,
        height: 2,
        fps: 30,
        samples: samples(1, 1),
      }),
    ).toThrow();
  });
});

const show = (n: number, over: Partial<ShowSlide> = {}): ShowSlide => ({
  pageId: `p${n}`,
  number: n,
  hidden: false,
  advanceAfterMs: null,
  transition: null,
  notes: "",
  sizePt: [960, 540],
  ...over,
});

describe("[plugin-slide.output] the video's timeline", () => {
  it("holds each slide for its time, plays transitions in between, skips hidden slides", () => {
    const t = timeline(
      [
        show(1, {
          transition: {
            kind: "fade",
            dir: null,
            speed: null,
            durationMs: 1000,
          },
        }),
        show(2, {
          advanceAfterMs: 2000,
          transition: { kind: "fade", dir: null, speed: null, durationMs: 500 },
        }),
        show(3, { hidden: true }),
        show(4, {
          transition: { kind: "push", dir: "l", speed: null, durationMs: 1000 },
        }),
      ],
      { fps: 30, defaultSeconds: 5, useTimings: true },
    );
    expect(t.pages).toEqual(["p1", "p2", "p4"]);
    expect(t.segments.map((s) => [s.kind, s.frames])).toEqual([
      ["hold", 150], // the first slide's transition does not play (it comes in from nothing)
      ["transition", 15],
      ["hold", 60], // its recorded 2 s
      ["transition", 30],
      ["hold", 150],
    ]);
    expect(t.frames).toBe(405);
    expect(t.durationMs).toBe(13500);
    // Without recorded timings every slide takes the default.
    const u = timeline([show(1), show(2, { advanceAfterMs: 2000 })], {
      fps: 24,
      defaultSeconds: 1,
      useTimings: false,
    });
    expect(u.frames).toBe(48);
  });

  it("sizes the video to the slide's shape, even pixels", () => {
    expect(videoSize(1080, [960, 540])).toEqual({ width: 1920, height: 1080 });
    expect(videoSize(720, [720, 540])).toEqual({ width: 960, height: 720 });
    expect(videoSize(2160, [960, 540])).toEqual({ width: 3840, height: 2160 });
  });
});

const slide = (n: number, state: Slide["state"] = {}): Slide => ({
  pageId: `p${n}`,
  number: n,
  sizePt: [960, 540],
  state,
});
const setState = (m: MutationInput | null) =>
  m as { op: string; args: { page: string; value: string | null } };

describe("[plugin-slide.output] sections", () => {
  const deck = [
    slide(1, { section: { id: "{A}", name: "Intro" } }),
    slide(2),
    slide(3, { section: { id: "{B}", name: "Body" } }),
    slide(4),
    slide(5, { section: { id: "{B}", name: "Body" } }), // a duplicated first slide
  ];

  it("reads sections from the slides that start them", () => {
    expect(sectionsOf(deck).map((s) => [s.name, s.start, s.pageIds])).toEqual([
      ["Intro", 0, ["p1", "p2"]],
      ["Body", 2, ["p3", "p4", "p5"]],
    ]);
    expect(
      sectionsOf([slide(1), slide(2, { section: { id: "x", name: "X" } })])[0]!
        .pageIds,
    ).toEqual(["p2"]);
  });

  it("keeps a section on its slide's label through the state codec", () => {
    const s = parseState([
      {
        key: "x-paged:media.paged.slide",
        value: encodeState({
          hidden: true,
          section: { id: "{A}", name: "Ä" },
        })!,
      },
    ]);
    expect(s.section).toEqual({ id: "{A}", name: "Ä" });
  });

  it("adds, renames, removes and moves sections as one write each", () => {
    const add = setState(addSectionMutation(deck, "p2", "New", "{N}"));
    expect(add.args.page).toBe("p2");
    expect(JSON.parse(add.args.value!).data.section).toEqual({
      id: "{N}",
      name: "New",
    });
    const ren = setState(renameSectionMutation(deck, "{B}", "Hauptteil"));
    expect(ren.args.page).toBe("p3");
    expect(renameSectionMutation(deck, "{B}", "Body")).toBeNull();
    const rm = setState(removeSectionMutation(deck, "{A}"));
    expect(rm.args.page).toBe("p1");
    expect(rm.args.value).toBeNull();
    const rmAll = removeSectionMutation(deck, "{A}", true) as {
      args: { ops: unknown[] };
    };
    expect(rmAll.args.ops).toHaveLength(2);
    // Body moves up before Intro: its three slides first.
    const up = moveSectionMutation(deck, "{B}", -1) as {
      args: { ops: { args: { page: string; after: string | null } }[] };
    };
    expect(up.args.ops.map((o) => [o.args.page, o.args.after])).toEqual([
      ["p3", null],
      ["p4", "p3"],
      ["p5", "p4"],
    ]);
    expect(moveSectionMutation(deck, "{A}", -1)).toBeNull();
    const down = moveSectionMutation(deck, "{A}", 1) as {
      args: { ops: { args: { page: string; after: string | null } }[] };
    };
    expect(down.args.ops[0]!.args.after).toBe("p5");
  });

  it("deleting a section's first slide hands the section to the next slide", () => {
    const m = deleteMutation("p3", deck) as {
      op: string;
      args: { ops: { op: string; args: { page?: string; value?: string } }[] };
    };
    expect(m.op).toBe("batch");
    expect(m.args.ops[0]!.args.page).toBe("p4");
    expect(JSON.parse(m.args.ops[0]!.args.value!).data.section.name).toBe(
      "Body",
    );
    expect(m.args.ops[1]!.op).toBe("deletePage");
    expect(deleteMutation("p2", deck).op).toBe("deletePage");
  });
});

describe("[plugin-slide.output] custom shows", () => {
  it("reads the label's shows, drops missing pages, keeps the label's other keys", () => {
    const label = {
      deck: { name: "D" },
      customShows: [
        { id: 0, name: "A", pages: ["p1", "p9", "p2"] },
        { id: "bad", name: "B", pages: [] },
      ],
    };
    const shows = showsOfLabel(label);
    expect(shows).toEqual([{ id: 0, name: "A", pages: ["p1", "p9", "p2"] }]);
    expect(liveShows(shows, ["p1", "p2"])[0]!.pages).toEqual(["p1", "p2"]);
    expect(nextShowId(shows)).toBe(1);
    const m = showsMutation(label, [{ id: 3, name: "C", pages: ["p2"] }]) as {
      op: string;
      args: { value: string };
    };
    expect(m.op).toBe("setDocumentMetadata");
    const data = JSON.parse(m.args.value).data;
    expect(data.deck).toEqual({ name: "D" });
    expect(data.customShows).toEqual([{ id: 3, name: "C", pages: ["p2"] }]);
    const none = showsMutation(label, []) as { args: { value: string } };
    expect(JSON.parse(none.args.value).data.customShows).toBeUndefined();
  });

  it("plays a custom show's slides in its order", () => {
    const all = [show(1), show(2), show(3)];
    expect(
      customShowSlides(all, ["p3", "p1", "p3", "gone"]).map((s) => s.pageId),
    ).toEqual(["p3", "p1", "p3"]);
  });
});

describe("[plugin-slide.output] PDF choices", () => {
  it("chooses Letter in the Americas' Letter countries and A4 elsewhere", () => {
    expect(paperFor("en-US")).toBe("letter");
    expect(paperFor("de-AT")).toBe("a4");
    expect(paperFor("en")).toBe("a4");
    expect(paperFor(undefined)).toBe("a4");
  });

  it("prints the chosen slides, hidden ones only on request", () => {
    const deck = [slide(1), slide(2, { hidden: true }), slide(3)];
    expect(chosenSlides(deck, {}).map((s) => s.number)).toEqual([1, 3]);
    expect(
      chosenSlides(deck, { includeHidden: true }).map((s) => s.number),
    ).toEqual([1, 2, 3]);
    expect(
      chosenSlides(deck, { slides: [2, 3], includeHidden: true }).map(
        (s) => s.number,
      ),
    ).toEqual([2, 3]);
  });
});
